// Streamable HTTP mode (brain-mcp spec, "Shared HTTP transport"; design.md
// decisions 2, 3, 5, 6). Importable, with no entrypoint of its own: http.ts
// parses flags, runs the shared bootstrap, and calls startHttpServer, so
// tests drive the same server in-process on an ephemeral port.
//
// One process, one pool, many sessions. Each client that initializes gets
// its own StreamableHTTPServerTransport and its own createServer() Server:
// attribution reads the client's initialize identity off the Server
// instance (server.ts's actor thunk), and the SDK refuses to connect one
// Server to a second transport, so one Server per session is what keeps
// each client's writes named after that client.
//
// Requests are dispatched in this order:
//   1. the local-only guard (request-guard.ts) → 403, before any route;
//   2. GET /healthz → 200 or 503 (no session, never writes);
//   3. /mcp with a session id the registry holds → that session's transport;
//   4. /mcp with a session id it does not hold → 404 + JSON-RPC -32001, so
//      the client re-initializes. Sent here, not by the SDK: a fresh
//      transport has no session id to compare against, and only 404s an
//      id that mismatches its own;
//   5. /mcp POST with no id → a new session (the SDK refuses anything but
//      initialize on a transport that has none yet);
//   6. /mcp GET/DELETE with no id → 400.
//
// Session lifetime (decision 3) is a memory bound, not a correctness one:
// an expired session costs its client one 404 and one re-initialize.

import { randomUUID } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Database } from "@breakdown/db";
import { isAllowedRequest } from "./request-guard.js";
import { createServer } from "./server.js";
import { describeConnectionError, type Pool } from "./startup.js";

export const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
export const IDLE_LIMIT_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_SESSIONS = 256;
export const HEALTH_TIMEOUT_MS = 2_000;

/** Anything the registry can hold; closing it must release the session. */
export interface Closeable {
  close(): Promise<void>;
}

export interface SessionRegistry<S extends Closeable> {
  add(id: string, session: S): void;
  get(id: string): S | undefined;
  /** Marks the session as just seen, making it the last to be evicted. */
  touch(id: string): void;
  /** Forgets the session without closing it (its transport closed already). */
  remove(id: string): void;
  /** Closes every session idle for longer than the limit. */
  sweep(): void;
  closeAll(): Promise<void>;
  readonly size: number;
}

export interface SessionRegistryOptions {
  maxSessions: number;
  idleLimitMs: number;
  now: () => number;
}

function closeQuietly(id: string, session: Closeable, why: string): Promise<void> {
  return session.close().catch((err: unknown) => {
    console.error(`[breakdown-brain] closing ${why} session ${id} failed: ${describeConnectionError(err)}`);
  });
}

/**
 * Sessions keyed by id. A Map iterates in insertion order and touch()
 * re-inserts, so the front is always the least recently seen: eviction
 * takes the first entry, and a sweep stops at the first one still live.
 */
export function createSessionRegistry<S extends Closeable>(options: SessionRegistryOptions): SessionRegistry<S> {
  const entries = new Map<string, { session: S; lastSeen: number }>();

  return {
    add(id, session) {
      while (entries.size >= options.maxSessions) {
        const [oldestId, oldest] = entries.entries().next().value!;
        entries.delete(oldestId);
        void closeQuietly(oldestId, oldest.session, "evicted");
      }
      entries.set(id, { session, lastSeen: options.now() });
    },
    get(id) {
      return entries.get(id)?.session;
    },
    touch(id) {
      const entry = entries.get(id);
      if (!entry) return;
      entries.delete(id);
      entries.set(id, { session: entry.session, lastSeen: options.now() });
    },
    remove(id) {
      entries.delete(id);
    },
    sweep() {
      const cutoff = options.now() - options.idleLimitMs;
      for (const [id, entry] of entries) {
        if (entry.lastSeen >= cutoff) break;
        entries.delete(id);
        void closeQuietly(id, entry.session, "expired");
      }
    },
    async closeAll() {
      const all = [...entries];
      entries.clear();
      await Promise.all(all.map(([id, entry]) => closeQuietly(id, entry.session, "open")));
    },
    get size() {
      return entries.size;
    },
  };
}

export type ProbeResult = { ok: true } | { ok: false; error: string };

/**
 * `select 1`, raced against a timer. statement_timeout is no help here:
 * with connectionTimeoutMillis unset, pg-pool waits forever for a
 * connection to a database that accepts TCP but never answers.
 */
export async function probeDatabase(pool: Pick<Pool, "query">, timeoutMs: number): Promise<ProbeResult> {
  let timer: NodeJS.Timeout | undefined;
  const query = Promise.resolve(pool.query("select 1"));
  // The loser of the race must not surface as an unhandled rejection.
  query.catch(() => {});
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`database did not answer within ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    await Promise.race([query, timeout]);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeConnectionError(err) };
  } finally {
    clearTimeout(timer);
  }
}

export interface StartHttpServerOptions {
  db: Database;
  pool: Pick<Pool, "query">;
  readOnly: boolean;
  /** `host:port/database`, no credentials (bootstrap's target). */
  target: string;
  port: number;
  host: string;
}

export interface RunningHttpServer {
  /** `http://<bound address>:<port>/mcp`, IPv6 bracketed. */
  url: string;
  port: number;
  /** Closes every session and the listener. The caller ends the pool. */
  close(): Promise<void>;
}

interface Session extends Closeable {
  transport: StreamableHTTPServerTransport;
  server: Server;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

function sendJsonRpcError(res: ServerResponse, status: number, code: number, message: string): void {
  sendJson(res, status, { jsonrpc: "2.0", error: { code, message }, id: null });
}

/** Listens on host:port and serves /mcp and /healthz; rejects if the listen fails (EADDRINUSE included). */
export async function startHttpServer(options: StartHttpServerOptions): Promise<RunningHttpServer> {
  const { db, pool, readOnly, target } = options;
  const registry = createSessionRegistry<Session>({ maxSessions: MAX_SESSIONS, idleLimitMs: IDLE_LIMIT_MS, now: Date.now });
  // Set once listening; no request is accepted before then.
  let guardPort = 0;

  async function openSession(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const server = createServer(db, { readOnly });
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        registry.add(id, { transport, server, close: () => server.close() });
      },
    });
    // Before connect: Protocol.connect chains its own onclose after this one.
    transport.onclose = () => {
      if (transport.sessionId) registry.remove(transport.sessionId);
    };
    await server.connect(transport);
    await transport.handleRequest(req, res);
    // Not an initialize (the SDK answered 400): nothing references this pair.
    if (transport.sessionId === undefined) await server.close();
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isAllowedRequest({ host: req.headers.host, origin: req.headers.origin }, guardPort)) {
      sendJsonRpcError(res, 403, -32000, "Forbidden: this server accepts loopback requests from local origins only");
      return;
    }

    const { pathname } = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";

    if (pathname === "/healthz") {
      if (method !== "GET") {
        res.setHeader("allow", "GET");
        sendJson(res, 405, { error: "method not allowed" });
        return;
      }
      const probe = await probeDatabase(pool, HEALTH_TIMEOUT_MS);
      if (probe.ok) sendJson(res, 200, { ready: true, readOnly, database: target });
      else sendJson(res, 503, { ready: false, readOnly, database: target, error: probe.error });
      return;
    }

    if (pathname === "/mcp") {
      const header = req.headers["mcp-session-id"];
      const sessionId = Array.isArray(header) ? header[0] : header;
      if (sessionId !== undefined) {
        const session = registry.get(sessionId);
        if (!session) {
          sendJsonRpcError(res, 404, -32001, "Session not found");
          return;
        }
        registry.touch(sessionId);
        await session.transport.handleRequest(req, res);
        return;
      }
      if (method === "POST") {
        await openSession(req, res);
        return;
      }
      sendJsonRpcError(res, 400, -32000, "Bad Request: Mcp-Session-Id header is required");
      return;
    }

    sendJson(res, 404, { error: "not found" });
  }

  const httpServer = createHttpServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      console.error(`[breakdown-brain] ${req.method} ${req.url} failed: ${describeConnectionError(err)}`);
      if (!res.headersSent) sendJsonRpcError(res, 500, -32603, "Internal server error");
      else res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port, options.host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });
  httpServer.on("error", (err) => {
    console.error(`[breakdown-brain] http server error: ${describeConnectionError(err)}`);
  });

  const address = httpServer.address() as AddressInfo;
  guardPort = address.port;
  const sweep = setInterval(() => registry.sweep(), SWEEP_INTERVAL_MS);
  sweep.unref();

  const hostPart = address.family === "IPv6" ? `[${address.address}]` : address.address;
  return {
    url: `http://${hostPart}:${address.port}/mcp`,
    port: address.port,
    async close() {
      clearInterval(sweep);
      await registry.closeAll();
      httpServer.closeAllConnections();
      await new Promise<void>((resolve, reject) => httpServer.close((err) => (err ? reject(err) : resolve())));
    },
  };
}
