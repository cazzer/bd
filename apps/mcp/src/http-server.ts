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
// Every request, /healthz included, passes the shared admission function
// (packages/core admission.ts; tailnet-hosting decision 2) before anything
// else looks at it. A loopback peer with a loopback Host needs no token, as
// before (unless a forwarding header names a remote address); anything else
// needs an allowed Host and a live client token, of either scope — MCP is
// where agents work (decision 9). The admitted token client is bound to the
// session it initializes (decision 4): the session's Server records it in
// each write's actor, and a later request on that session presenting any
// other client — another token, or none — is refused, so one client cannot
// continue another's session. A request refused because of the token it
// presented — unknown or revoked (401), or a scope MCP does not accept
// (403) — closes the token-opened session it names, but only when the
// refusal speaks for that session's own client: its client no longer holds
// a live token, or the scope refusal was of that same client's token. So
// once a session's token is revoked, the client's next request also ends
// its open SSE stream, while a garbage or unknown token naming someone
// else's session id cannot end it. A refusal the credential did not cause
// (no token, a foreign Host or Origin) leaves the session open
// (hangar-queue decision 9).
//
// Requests are dispatched in this order:
//   1. admission: a foreign Host or Origin → 403; no usable token where
//      one is needed → 401 with WWW-Authenticate: Bearer; a refusal the
//      presented token caused closes the token-opened session its
//      Mcp-Session-Id names, when it speaks for that session's client;
//   2. a declared body over MAX_BODY_BYTES → 413;
//   3. GET /healthz → 200 or 503 (no session, never writes);
//   4. /mcp with a method other than GET/POST/DELETE → 405;
//   5. a POST body is read here, capped at MAX_BODY_BYTES (413), parsed
//      (400 on bad JSON), and handed to the SDK as parsedBody;
//   6. /mcp with a session id the registry holds → 403 if the admitted
//      client is not the one the session was opened by, else that
//      session's transport;
//   7. /mcp with a session id it does not hold → 404 + JSON-RPC -32001, so
//      the client re-initializes. Sent here, not by the SDK: a fresh
//      transport has no session id to compare against, and only 404s an
//      id that mismatches its own;
//   8. /mcp POST with no id → a new session (the SDK refuses anything but
//      initialize on a transport that has none yet);
//   9. /mcp GET/DELETE with no id → 400.
//
// In JSON-response mode the SDK never answers a POST whose session closes
// while the call is in flight (its cleanup only drops the pending entry),
// so each session tracks its open POST responses and its close answers
// them 404 "Session not found" — whether the close came from a DELETE,
// eviction, the idle sweep, or shutdown. In the microtask gap after the SDK
// has resolved a reply but before the node adapter calls writeHead, a close
// wins: the client gets the 404 (and re-initializes; writes are idempotent
// upserts) and the adapter logs an ERR_HTTP_HEADERS_SENT stack to stderr.
// That trace is expected, not a bug.
//
// Session lifetime (decision 3) is a memory bound, not a correctness one:
// an expired session costs its client one 404 and one re-initialize.

import { randomUUID } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { performance } from "node:perf_hooks";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  admitRequest,
  credentialFrom,
  forwardedAddressesFrom,
  isLoopbackAddress,
  UNAUTHORIZED_HEADERS,
  hasLiveToken,
  verifyClientToken,
  type AdmissionPolicy,
  type ClientTokenScope,
} from "@breakdown/core";
import type { Database } from "@breakdown/db";
import { createServer } from "./server.js";
import { describeConnectionError, type Pool } from "./startup.js";

export const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
export const IDLE_LIMIT_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_SESSIONS = 256;
export const HEALTH_TIMEOUT_MS = 2_000;
export const MAX_BODY_BYTES = 16 * 1024 * 1024;
/** How long shutdown waits for in-flight requests before closing sessions under them. */
export const SHUTDOWN_GRACE_MS = 3_000;
/** How long shutdown waits for the 404s it just sent to flush before dropping connections. */
const SHUTDOWN_FLUSH_MS = 500;
/** How long a refused oversized upload keeps draining before its connection is dropped. */
const TOO_LARGE_LINGER_MS = 1_000;
/** A person's tokens and agents' tokens alike (module header). */
const MCP_SCOPES: readonly ClientTokenScope[] = ["human", "agent"];

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
  /** A monotonic clock in milliseconds (performance.now in the server). */
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
 * A single-flight `select 1`: concurrent callers share one in-flight
 * query, and each races it against its own timer. statement_timeout is no
 * help here: with connectionTimeoutMillis unset, pg-pool waits forever for
 * a connection to a database that accepts TCP but never answers. Sharing
 * the query caps what a hung database costs at one abandoned query, not
 * one per /healthz.
 */
export function createDatabaseProbe(pool: Pick<Pool, "query">, timeoutMs: number): () => Promise<ProbeResult> {
  let inflight: Promise<void> | undefined;

  return async () => {
    if (!inflight) {
      const query = Promise.resolve()
        .then(() => pool.query("select 1"))
        .then(() => undefined);
      inflight = query;
      // Handles the rejection too, so an abandoned query never surfaces as unhandled.
      const settle = (): void => {
        if (inflight === query) inflight = undefined;
      };
      query.then(settle, settle);
    }

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`database did not answer within ${timeoutMs}ms`)), timeoutMs);
    });
    try {
      await Promise.race([inflight, timeout]);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: describeConnectionError(err) };
    } finally {
      clearTimeout(timer);
    }
  };
}

export interface StartHttpServerOptions {
  db: Database;
  pool: Pick<Pool, "query">;
  readOnly: boolean;
  /** `host:port/database`, no credentials (bootstrap's target). */
  target: string;
  /** 0 asks the OS for an ephemeral port. */
  port: number;
  /** The address to bind; loopback unless the operator chose otherwise (http-config.ts). */
  host: string;
  /** Host names admitted besides loopback, each already through `normalizeAllowedHost`. */
  allowedHosts: readonly string[];
}

export interface RunningHttpServer {
  /** `http://<bound address>:<port>/mcp`, IPv6 bracketed. */
  url: string;
  port: number;
  /** Stops accepting, drains, closes every session, then every connection. The caller ends the pool. */
  close(): Promise<void>;
}

interface Session extends Closeable {
  transport: StreamableHTTPServerTransport;
  server: Server;
  /** POST responses still waiting on this session's answer. */
  pending: Set<ServerResponse>;
  /** The token client that initialized the session; null for a tokenless loopback session. */
  tokenClient: string | null;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
}

function sendJsonRpcError(res: ServerResponse, status: number, code: number, message: string, headers: Record<string, string> = {}): void {
  sendJson(res, status, { jsonrpc: "2.0", error: { code, message }, id: null }, headers);
}

/**
 * 413, then drop the connection. The rest of the body is discarded for a
 * short linger first: destroying a socket with unread input sends a reset,
 * which can make the client lose the 413 it has not read yet.
 */
function sendTooLarge(req: IncomingMessage, res: ServerResponse): void {
  req.resume();
  res.once("finish", () => setTimeout(() => req.socket.destroy(), TOO_LARGE_LINGER_MS).unref());
  sendJsonRpcError(res, 413, -32000, `Payload Too Large: request body exceeds ${MAX_BODY_BYTES} bytes`, { connection: "close" });
}

/** The whole body, or undefined once it passes `limit` bytes (chunked bodies declare no length). */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = (): void => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("close", onClose);
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > limit) {
        cleanup();
        resolve(undefined);
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error("request closed before its body was read"));
    };
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("close", onClose);
  });
}

function sessionIdOf(req: IncomingMessage): string | undefined {
  const header = req.headers["mcp-session-id"];
  return Array.isArray(header) ? header[0] : header;
}

function track(set: Set<ServerResponse>, res: ServerResponse): void {
  set.add(res);
  res.once("close", () => set.delete(res));
}

/** Listens on host:port and serves /mcp and /healthz; rejects if the listen fails (EADDRINUSE included). */
export async function startHttpServer(options: StartHttpServerOptions): Promise<RunningHttpServer> {
  const { db, readOnly, target } = options;
  const registry = createSessionRegistry<Session>({ maxSessions: MAX_SESSIONS, idleLimitMs: IDLE_LIMIT_MS, now: () => performance.now() });
  const probe = createDatabaseProbe(options.pool, HEALTH_TIMEOUT_MS);
  // Set once listening; no request is accepted before then.
  let guardPort = 0;
  const verifyToken = (token: string) => verifyClientToken(db, token);

  // Requests shutdown waits for. GETs are left out: on /mcp a GET is a
  // session's SSE stream, which stays open until the session closes.
  const inflight = new Set<ServerResponse>();
  let onDrained: (() => void) | undefined;

  function waitForInflight(ms: number): Promise<void> {
    if (inflight.size === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done(): void {
        clearTimeout(timer);
        onDrained = undefined;
        resolve();
      }
      onDrained = done;
    });
  }

  async function openSession(req: IncomingMessage, res: ServerResponse, parsedBody: unknown, tokenClient: string | null, hangarSessionId: string | null): Promise<void> {
    const server = createServer(db, { readOnly, ...(tokenClient === null ? {} : { tokenClient }), ...(hangarSessionId === null ? {} : { hangarSessionId }) });
    const pending = new Set<ServerResponse>();
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        registry.add(id, { transport, server, pending, tokenClient, close: () => server.close() });
      },
    });
    // Before connect: Protocol.connect chains its own onclose after this one.
    transport.onclose = () => {
      if (transport.sessionId) registry.remove(transport.sessionId);
      for (const waiting of pending) {
        if (!waiting.headersSent) sendJsonRpcError(waiting, 404, -32001, "Session not found");
      }
      pending.clear();
    };
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
    } finally {
      // Not an initialize (the SDK answered 400), or it failed: nothing references this pair.
      if (transport.sessionId === undefined) await server.close();
    }
  }

  /**
   * Closes the token-opened session a request refused by its credential
   * names, when the refusal speaks for the session's own client (module
   * header): that client holds no live token any more, or `refusedClient`
   * — the client whose live token was refused for its scope — is that
   * client. A tokenless loopback session is left alone: only a token can be
   * revoked, and a remote caller holding a leaked id must not be able to end
   * a local session. A failed token lookup leaves the session open.
   */
  async function closeRefusedTokenSession(req: IncomingMessage, refusedClient: string | null): Promise<void> {
    const sessionId = sessionIdOf(req);
    if (sessionId === undefined) return;
    const session = registry.get(sessionId);
    if (session === undefined || session.tokenClient === null) return;
    if (refusedClient !== session.tokenClient) {
      let live: boolean;
      try {
        live = await hasLiveToken(db, session.tokenClient);
      } catch (err) {
        console.error(`[breakdown-brain] checking session ${sessionId}'s token failed: ${describeConnectionError(err)}`);
        return;
      }
      if (live) return;
    }
    // The lookup awaited: the session may have closed or been replaced meanwhile.
    if (registry.get(sessionId) !== session) return;
    registry.remove(sessionId);
    void closeQuietly(sessionId, session, "refused");
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // No isPublic: every MCP path, /healthz included, needs a token off loopback.
    const policy: AdmissionPolicy = { port: guardPort, allowedHosts: options.allowedHosts, originCheck: "all-methods", scopes: MCP_SCOPES, verifyToken };
    // The raw request-target, deliberately not URL-normalized (admission.ts header).
    const rawUrl = req.url ?? "/";
    const queryAt = rawUrl.indexOf("?");
    const admission = await admitRequest(
      {
        method: req.method,
        host: req.headers.host,
        origin: req.headers.origin,
        peerIsLoopback: isLoopbackAddress(req.socket.remoteAddress),
        path: queryAt === -1 ? rawUrl : rawUrl.slice(0, queryAt),
        credential: credentialFrom(req.headers),
        forwardedFor: forwardedAddressesFrom(req.headers),
      },
      policy,
    );
    if (admission.outcome !== "allow" && admission.byCredential) {
      await closeRefusedTokenSession(req, admission.outcome === "forbidden" ? admission.client : null);
    }
    if (admission.outcome === "forbidden") {
      sendJsonRpcError(res, 403, -32000, "Forbidden: this server accepts requests only for its own or an allowed host, from local or allowed origins");
      return;
    }
    if (admission.outcome === "unauthorized") {
      sendJsonRpcError(res, 401, -32000, "Unauthorized: a client token is required", { ...UNAUTHORIZED_HEADERS });
      return;
    }
    const declaredLength = req.headers["content-length"];
    if (declaredLength !== undefined && Number(declaredLength) > MAX_BODY_BYTES) {
      sendTooLarge(req, res);
      return;
    }

    const { pathname } = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";

    if (pathname === "/healthz") {
      if (method !== "GET") {
        sendJson(res, 405, { error: "method not allowed" }, { allow: "GET" });
        return;
      }
      const result = await probe();
      if (result.ok) sendJson(res, 200, { ready: true, readOnly, database: target });
      else sendJson(res, 503, { ready: false, readOnly, database: target, error: result.error });
      return;
    }

    if (pathname !== "/mcp") {
      sendJson(res, 404, { error: "not found" });
      return;
    }

    if (method !== "GET" && method !== "POST" && method !== "DELETE") {
      sendJsonRpcError(res, 405, -32000, "Method not allowed.", { allow: "GET, POST, DELETE" });
      return;
    }

    let parsedBody: unknown;
    if (method === "POST") {
      const body = await readBody(req, MAX_BODY_BYTES);
      if (body === undefined) {
        sendTooLarge(req, res);
        return;
      }
      try {
        parsedBody = JSON.parse(new TextDecoder().decode(body));
      } catch {
        sendJsonRpcError(res, 400, -32700, "Parse error: Invalid JSON");
        return;
      }
    }

    const sessionId = sessionIdOf(req);
    if (sessionId !== undefined) {
      const session = registry.get(sessionId);
      if (!session) {
        sendJsonRpcError(res, 404, -32001, "Session not found");
        return;
      }
      if (admission.client !== session.tokenClient) {
        sendJsonRpcError(res, 403, -32000, "Forbidden: this session belongs to another client");
        return;
      }
      registry.touch(sessionId);
      if (method === "POST") track(session.pending, res);
      await session.transport.handleRequest(req, res, parsedBody);
      return;
    }
    if (method === "POST") {
      await openSession(req, res, parsedBody, admission.client, admission.sessionId);
      return;
    }
    sendJsonRpcError(res, 400, -32000, "Bad Request: Mcp-Session-Id header is required");
  }

  const httpServer = createHttpServer((req, res) => {
    if (req.method !== "GET") {
      inflight.add(res);
      res.once("close", () => {
        inflight.delete(res);
        if (inflight.size === 0) onDrained?.();
      });
    }
    handle(req, res).catch((err: unknown) => {
      // The method and the path only: a query string is never logged.
      const rawUrl = req.url ?? "/";
      const queryAt = rawUrl.indexOf("?");
      console.error(`[breakdown-brain] ${req.method} ${queryAt === -1 ? rawUrl : rawUrl.slice(0, queryAt)} failed: ${describeConnectionError(err)}`);
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

  const address = httpServer.address() as AddressInfo;
  httpServer.on("error", (err) => {
    console.error(`[breakdown-brain] http server error: ${describeConnectionError(err)}`);
  });

  guardPort = address.port;
  const sweep = setInterval(() => registry.sweep(), SWEEP_INTERVAL_MS);
  sweep.unref();

  async function shutdown(): Promise<void> {
    clearInterval(sweep);
    const stopped = new Promise<void>((resolve, reject) => httpServer.close((err) => (err ? reject(err) : resolve())));
    httpServer.closeIdleConnections();
    await waitForInflight(SHUTDOWN_GRACE_MS);
    // Answers any call still waiting with 404, via each session's onclose.
    await registry.closeAll();
    await waitForInflight(SHUTDOWN_FLUSH_MS);
    httpServer.closeAllConnections();
    await stopped;
  }

  let closing: Promise<void> | undefined;
  const hostPart = address.family === "IPv6" ? `[${address.address}]` : address.address;
  return {
    url: `http://${hostPart}:${address.port}/mcp`,
    port: address.port,
    close() {
      closing ??= shutdown();
      return closing;
    },
  };
}
