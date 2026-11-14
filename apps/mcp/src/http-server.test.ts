// http-server.ts driven in-process on ephemeral ports (port 0) against the
// test database (brain-mcp spec, "Shared HTTP transport", "HTTP mode is
// local by default"; client-access spec; brain-service spec, "Health
// endpoint").
//
// The database is shared with live sessions and with the other apps/mcp
// test files running in parallel, so every fixture is scoped: nodes carry
// this file's unique source system, and runs are removed by the ids the
// writes returned. Client versions carry this file's suffix as a backstop
// against any actor-scoped sweep elsewhere matching a run of ours, and
// client tokens are minted under names carrying it and deleted by name.
//
// Every server here binds loopback, so every request comes from a loopback
// peer: a tailnet Host (TAILNET_HOST, allowed at start) is what forces the
// token path, since admission trusts a loopback peer only with a loopback
// Host. That stands in for a tailnet client reaching a non-loopback bind,
// which a test cannot produce without binding 0.0.0.0 (macOS firewall
// prompt).
//
// Calls that must stay in flight (a session closing under them) run
// against a fake pool whose queries never answer.

import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createClientToken, createSessionToken, revokeClientToken, sessionTokenClient } from "@breakdown/core";
import { clientTokens, createDb, createPool, ingestRuns, nodes, resolveDatabaseUrl, type Database } from "@breakdown/db";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDatabaseProbe, createSessionRegistry, HEALTH_TIMEOUT_MS, MAX_BODY_BYTES, startHttpServer, type RunningHttpServer } from "./http-server.js";
import { describeConnectionTarget } from "./startup.js";

const mcpRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsxBin = path.join(mcpRoot, "node_modules", ".bin", "tsx");
const stdioEntry = path.join(mcpRoot, "src", "index.ts");

const suffix = randomUUID().replace(/-/g, "");
const sourceSystem = `mcp-http-${suffix}`;
const runIds: string[] = [];
const tokenClients: string[] = [];
const TAILNET_HOST = "breakdown.tail.example";
const RAW_CLIENT = { name: "raw-client", version: `1.0.0+${suffix}` };

let databaseUrl: string;
let pool: ReturnType<typeof createPool> | undefined;
let db: Database | undefined;
let target: string;
const servers: RunningHttpServer[] = [];
const clients: Client[] = [];

beforeAll(() => {
  databaseUrl = resolveDatabaseUrl();
  pool = createPool(databaseUrl);
  db = createDb(pool);
  target = describeConnectionTarget(databaseUrl);
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => {})));
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

afterAll(async () => {
  if (db) {
    await db.delete(nodes).where(eq(nodes.sourceSystem, sourceSystem));
    if (runIds.length > 0) {
      await db.delete(nodes).where(inArray(nodes.ingestRunId, runIds));
      await db.delete(ingestRuns).where(inArray(ingestRuns.id, runIds));
    }
    if (tokenClients.length > 0) await db.delete(clientTokens).where(inArray(clientTokens.client, tokenClients));
  }
  await pool?.end();
});

type PoolLike = Parameters<typeof startHttpServer>[0]["pool"];

/** A pool whose every query and checkout waits forever; `calls` counts attempts. */
function hangingPool(): PoolLike & { calls: number; connect(): Promise<never> } {
  const fake = {
    calls: 0,
    query: () => {
      fake.calls++;
      return new Promise<never>(() => {});
    },
    connect: () => {
      fake.calls++;
      return new Promise<never>(() => {});
    },
  };
  return fake as unknown as PoolLike & { calls: number; connect(): Promise<never> };
}

async function start(overrides: { readOnly?: boolean; db?: Database; pool?: PoolLike; host?: string; allowedHosts?: string[] } = {}): Promise<RunningHttpServer> {
  const p = overrides.pool ?? pool!;
  const running = await startHttpServer({
    db: overrides.db ?? createDb(p as ReturnType<typeof createPool>),
    pool: p,
    readOnly: overrides.readOnly ?? false,
    target,
    port: 0,
    host: overrides.host ?? "127.0.0.1",
    allowedHosts: overrides.allowedHosts ?? [],
  });
  servers.push(running);
  return running;
}

/** Closes a server the test closed itself, so afterEach does not close it again. */
async function stop(running: RunningHttpServer): Promise<void> {
  const i = servers.indexOf(running);
  if (i >= 0) servers.splice(i, 1);
  await running.close();
}

async function connect(url: string, name: string, version: string): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const client = new Client({ name, version });
  const transport = new StreamableHTTPClientTransport(new URL(url));
  await client.connect(transport);
  clients.push(client);
  return { client, transport };
}

function textOf(raw: Awaited<ReturnType<Client["callTool"]>>): string {
  return (raw.content as { type: string; text: string }[])[0]!.text;
}

async function writeNode(client: Client, externalId: string): Promise<string> {
  const raw = await client.callTool({ name: "brain_write", arguments: { items: { nodeType: "doc", externalId, sourceSystem, content: "c" } } });
  const parsed = raw.isError ? undefined : (JSON.parse(textOf(raw)) as { ingestRunId: string });
  if (parsed) runIds.push(parsed.ingestRunId);
  expect(raw.isError, textOf(raw)).toBeFalsy();
  return parsed!.ingestRunId;
}

async function nodeExists(externalId: string): Promise<boolean> {
  const rows = await db!
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.sourceSystem, sourceSystem), eq(nodes.externalId, externalId)));
  return rows.length > 0;
}

async function until(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function sessionHeaders(transport: StreamableHTTPClientTransport): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-session-id": transport.sessionId!,
    "mcp-protocol-version": transport.protocolVersion ?? "2025-06-18",
  };
}

function brainWriteCall(externalId: string): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name: "brain_write", arguments: { items: { nodeType: "doc", externalId, sourceSystem, content: "c" } } },
  });
}

const BRAIN_MAP_CALL = JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "brain_map", arguments: {} } });
const SESSION_NOT_FOUND = { jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null };

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** node:http rather than fetch, which refuses to set Host. */
function rawRequest(url: string, options: { method: string; headers: Record<string, string>; body?: string }): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: options.method, headers: options.headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end(options.body);
  });
}

/** Raw bytes over a socket: a declared Content-Length with no body behind it. */
function rawSocketRequest(port: number, head: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(port, "127.0.0.1", () => socket.write(head));
    let received = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => (received += chunk));
    socket.on("close", () => resolve(received));
    socket.on("error", reject);
  });
}

/** A live token for a client name unique to this test file (deleted in afterAll). */
async function newToken(label: string, scope: "human" | "agent" | "hangar" = "human"): Promise<{ client: string; token: string }> {
  const client = `mcpt-${label}-${suffix.slice(0, 16)}`;
  tokenClients.push(client);
  const { token } = await createClientToken(db!, client, scope);
  return { client, token };
}

const MCP_POST_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const PROTOCOL_VERSION = "2025-06-18";

function initializeBody(): string {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: RAW_CLIENT } });
}

/**
 * initialize then notifications/initialized over raw HTTP, with the given
 * headers (Host, Authorization) on both; returns the session's headers for
 * later calls. Throws with the response if the server refuses either step.
 */
async function rawInitialize(url: string, headers: Record<string, string>): Promise<Record<string, string>> {
  const init = await rawRequest(url, { method: "POST", headers: { ...MCP_POST_HEADERS, ...headers }, body: initializeBody() });
  const sessionId = init.headers["mcp-session-id"];
  if (init.status !== 200 || typeof sessionId !== "string") throw new Error(`initialize refused: ${init.status} ${init.body}`);
  const session = { ...MCP_POST_HEADERS, ...headers, "mcp-session-id": sessionId, "mcp-protocol-version": PROTOCOL_VERSION };
  const initialized = await rawRequest(url, { method: "POST", headers: session, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
  if (initialized.status !== 202) throw new Error(`notifications/initialized refused: ${initialized.status} ${initialized.body}`);
  return session;
}

/** The ingest run id a raw brain_write response reports (recorded for cleanup). */
function runIdOf(response: RawResponse): string {
  const result = (JSON.parse(response.body) as { result: { content: { text: string }[]; isError?: boolean } }).result;
  expect(result.isError, result.content[0]!.text).toBeFalsy();
  const { ingestRunId } = JSON.parse(result.content[0]!.text) as { ingestRunId: string };
  runIds.push(ingestRunId);
  return ingestRunId;
}

describe("sessions over Streamable HTTP", () => {
  it("attributes each client's write to its own actor", async () => {
    const running = await start();
    const claude = await connect(running.url, "claude-code", `2.1.0+${suffix}`);
    const codex = await connect(running.url, "codex", `0.164.0+${suffix}`);

    const claudeRun = await writeNode(claude.client, `claude-${suffix}`);
    const codexRun = await writeNode(codex.client, `codex-${suffix}`);

    const runs = await db!.select({ id: ingestRuns.id, sourceSystem: ingestRuns.sourceSystem, actor: ingestRuns.actor }).from(ingestRuns).where(inArray(ingestRuns.id, [claudeRun, codexRun]));
    const byId = new Map(runs.map((r) => [r.id, r]));
    expect(byId.get(claudeRun)).toMatchObject({ sourceSystem: "agent", actor: `claude-code 2.1.0+${suffix}` });
    expect(byId.get(codexRun)).toMatchObject({ sourceSystem: "agent", actor: `codex 0.164.0+${suffix}` });
    expect(claude.transport.sessionId).not.toBe(codex.transport.sessionId);
  }, 30_000);

  it("advertises the same tools as the stdio entrypoint", async () => {
    const running = await start();
    const http = await connect(running.url, "list-http", suffix);
    const overHttp = await http.client.listTools();

    const env = { ...process.env } as Record<string, string>;
    delete env["BRAIN_READ_ONLY"];
    const stdio = new Client({ name: "list-stdio", version: suffix });
    const transport = new StdioClientTransport({ command: tsxBin, args: [stdioEntry], env, stderr: "pipe" });
    let stderr = "";
    transport.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    try {
      await stdio.connect(transport).catch((err: unknown) => {
        throw new Error(`stdio connect failed: ${String(err)} — stderr=${stderr}`);
      });
      const overStdio = await stdio.listTools();
      expect(overHttp.tools.length).toBeGreaterThan(0);
      expect(overHttp.tools).toEqual(overStdio.tools);
    } finally {
      await stdio.close();
    }
  }, 30_000);

  it("answers 404 for a session lost to a restart, and a fresh initialize succeeds", async () => {
    const first = await start();
    const { client, transport } = await connect(first.url, "restart-client", suffix);
    const staleId = transport.sessionId;
    expect(staleId).toBeTruthy();
    await client.close();
    await stop(first);

    const second = await start();
    const res = await fetch(second.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": staleId! },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(SESSION_NOT_FOUND);

    const fresh = await connect(second.url, "restart-client", suffix);
    expect((await fresh.client.listTools()).tools.length).toBeGreaterThan(0);
  }, 30_000);

  it("forgets a session its client DELETEs: the id then gets 404", async () => {
    const running = await start();
    const { transport } = await connect(running.url, "delete-client", suffix);
    const headers = sessionHeaders(transport);
    await transport.terminateSession();

    const res = await fetch(running.url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(SESSION_NOT_FOUND);
  });

  it("answers 404 to a call in flight when a DELETE closes its session", async () => {
    const hung = hangingPool();
    const running = await start({ db: createDb(hung as unknown as ReturnType<typeof createPool>) });
    const { transport } = await connect(running.url, "race-client", suffix);
    const headers = sessionHeaders(transport);

    const call = fetch(running.url, { method: "POST", headers, body: BRAIN_MAP_CALL });
    await until(() => hung.calls > 0);
    const deleted = await fetch(running.url, { method: "DELETE", headers });
    expect(deleted.status).toBe(200);

    const res = await call;
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(SESSION_NOT_FOUND);
  }, 30_000);

  it("on shutdown, ends each session under its waiting client with Session not found", async () => {
    const hung = hangingPool();
    const running = await start({ db: createDb(hung as unknown as ReturnType<typeof createPool>) });
    const { client } = await connect(running.url, "shutdown-client", suffix);

    const outcome = client.callTool({ name: "brain_map", arguments: {} }).then(
      () => "resolved",
      (err: unknown) => String(err),
    );
    await until(() => hung.calls > 0);
    await stop(running);
    expect(await outcome).toMatch(/404.*Session not found|Session not found/);
  }, 30_000);

  it("refuses with 400 a GET or DELETE on /mcp with no session id", async () => {
    const running = await start();
    for (const method of ["GET", "DELETE"]) {
      const res = await fetch(running.url, { method, headers: { accept: "text/event-stream" } });
      expect(res.status, method).toBe(400);
    }
  });

  it("refuses PUT and PATCH on /mcp with 405 naming the allowed methods", async () => {
    const running = await start();
    for (const method of ["PUT", "PATCH"]) {
      const res = await fetch(running.url, { method, body: "{}" });
      expect(res.status, method).toBe(405);
      expect(res.headers.get("allow")).toBe("GET, POST, DELETE");
    }
  });
});

describe("admission", () => {
  it("refuses a foreign Host and a foreign Origin with 403, writing nothing", async () => {
    const running = await start();
    const { transport } = await connect(running.url, "guard-client", suffix);
    const externalId = `guard-${suffix}`;
    const mcpHeaders = sessionHeaders(transport);

    const foreignOrigin = await rawRequest(running.url, { method: "POST", headers: { ...mcpHeaders, host: `127.0.0.1:${running.port}`, origin: "https://evil.example" }, body: brainWriteCall(externalId) });
    expect(foreignOrigin.status).toBe(403);

    const foreignHost = await rawRequest(running.url, { method: "POST", headers: { ...mcpHeaders, host: `evil.example:${running.port}` }, body: brainWriteCall(externalId) });
    expect(foreignHost.status).toBe(403);

    const foreignOriginGet = await rawRequest(running.url, { method: "GET", headers: { ...mcpHeaders, accept: "text/event-stream", host: `127.0.0.1:${running.port}`, origin: "https://evil.example" } });
    expect(foreignOriginGet.status).toBe(403);

    const healthzForeignHost = await rawRequest(running.url.replace("/mcp", "/healthz"), { method: "GET", headers: { host: `evil.example:${running.port}` } });
    expect(healthzForeignHost.status).toBe(403);

    expect(await nodeExists(externalId)).toBe(false);
  }, 30_000);

  it("writes nothing for a text/plain POST from a local origin (the SDK's media-type check)", async () => {
    const running = await start();
    const { transport } = await connect(running.url, "plain-client", suffix);
    const externalId = `plain-${suffix}`;
    const res = await fetch(running.url, {
      method: "POST",
      headers: { ...sessionHeaders(transport), "content-type": "text/plain", origin: "http://localhost:5173" },
      body: brainWriteCall(externalId),
    });
    expect(res.status).toBe(415);
    expect(await nodeExists(externalId)).toBe(false);
  }, 30_000);
});

describe("client tokens behind a tailnet Host", () => {
  async function startTailnet(): Promise<{ running: RunningHttpServer; host: string; healthz: string }> {
    const running = await start({ allowedHosts: [TAILNET_HOST] });
    return { running, host: `${TAILNET_HOST}:${running.port}`, healthz: running.url.replace("/mcp", "/healthz") };
  }

  it("refuses initialize and a write without a token with 401 + WWW-Authenticate: Bearer, writing nothing", async () => {
    const { running, host } = await startTailnet();
    const init = await rawRequest(running.url, { method: "POST", headers: { ...MCP_POST_HEADERS, host }, body: initializeBody() });
    expect(init.status).toBe(401);
    expect(init.headers["www-authenticate"]).toBe("Bearer");
    expect(init.headers["mcp-session-id"]).toBeUndefined();
    expect(JSON.parse(init.body)).toEqual({ jsonrpc: "2.0", error: { code: -32000, message: "Unauthorized: a client token is required" }, id: null });

    const externalId = `tokenless-${suffix}`;
    const write = await rawRequest(running.url, { method: "POST", headers: { ...MCP_POST_HEADERS, host }, body: brainWriteCall(externalId) });
    expect(write.status).toBe(401);
    expect(await nodeExists(externalId)).toBe(false);
  });

  it("guards /healthz too: 401 without a token, 200 with one", async () => {
    const { host, healthz } = await startTailnet();
    const { token } = await newToken("health");
    const without = await rawRequest(healthz, { method: "GET", headers: { host } });
    expect(without.status).toBe(401);
    expect(without.headers["www-authenticate"]).toBe("Bearer");
    const withToken = await rawRequest(healthz, { method: "GET", headers: { host, authorization: `Bearer ${token}` } });
    expect(withToken.status).toBe(200);
  });

  it("opens a session for a valid bearer token and attributes its write to \"<client> via <name> <version>\"", async () => {
    const { running, host } = await startTailnet();
    const { client, token } = await newToken("writer");
    const session = await rawInitialize(running.url, { host, authorization: `Bearer ${token}` });

    const write = await rawRequest(running.url, { method: "POST", headers: session, body: brainWriteCall(`token-write-${suffix}`) });
    expect(write.status).toBe(200);
    const runId = runIdOf(write);
    const [run] = await db!.select({ sourceSystem: ingestRuns.sourceSystem, actor: ingestRuns.actor }).from(ingestRuns).where(eq(ingestRuns.id, runId));
    expect(run).toEqual({ sourceSystem: "agent", actor: `${client} via ${RAW_CLIENT.name} ${RAW_CLIENT.version}` });
  }, 30_000);

  it("refuses the next call with 401 once the session's token is revoked", async () => {
    const { running, host } = await startTailnet();
    const { client, token } = await newToken("revoked");
    const session = await rawInitialize(running.url, { host, authorization: `Bearer ${token}` });
    await revokeClientToken(db!, client);

    const externalId = `revoked-${suffix}`;
    const res = await rawRequest(running.url, { method: "POST", headers: session, body: brainWriteCall(externalId) });
    expect(res.status).toBe(401);
    expect(res.headers["www-authenticate"]).toBe("Bearer");
    expect(await nodeExists(externalId)).toBe(false);
  }, 30_000);

  it("serves an agent token, /healthz and a session write alike", async () => {
    const { running, host, healthz } = await startTailnet();
    const { client, token } = await newToken("agent", "agent");
    expect((await rawRequest(healthz, { method: "GET", headers: { host, authorization: `Bearer ${token}` } })).status).toBe(200);
    const session = await rawInitialize(running.url, { host, authorization: `Bearer ${token}` });
    const write = await rawRequest(running.url, { method: "POST", headers: session, body: brainWriteCall(`agent-write-${suffix}`) });
    expect(write.status).toBe(200);
    const [run] = await db!.select({ actor: ingestRuns.actor }).from(ingestRuns).where(eq(ingestRuns.id, runIdOf(write)));
    expect(run?.actor).toBe(`${client} via ${RAW_CLIENT.name} ${RAW_CLIENT.version}`);
  }, 30_000);

  it("narrows a hangar session's token: brain_merge and brain_hangar_request are neither listed nor callable; a host agent token keeps them", async () => {
    const { running, host } = await startTailnet();
    const hangarSession = randomUUID();
    tokenClients.push(sessionTokenClient(hangarSession));
    const { token } = await db!.transaction((tx) => createSessionToken(tx, hangarSession));
    const session = await rawInitialize(running.url, { host, authorization: `Bearer ${token}` });

    const listed = await rawRequest(running.url, { method: "POST", headers: session, body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }) });
    const names = (JSON.parse(listed.body) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
    expect(names).toContain("brain_write");
    expect(names).not.toContain("brain_merge");
    expect(names).not.toContain("brain_hangar_request");

    for (const [name, args] of [["brain_merge", { loserId: randomUUID(), survivorId: randomUUID() }], ["brain_hangar_request", { repo: "cazzer/bd", workItemId: randomUUID(), flavor: "headless" }]] as const) {
      const called = await rawRequest(running.url, { method: "POST", headers: session, body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name, arguments: args } }) });
      const result = (JSON.parse(called.body) as { result: { isError: boolean; content: { text: string }[] } }).result;
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain(`'${name}' is not available to a hangar session's token`);
    }
    const map = await rawRequest(running.url, { method: "POST", headers: session, body: BRAIN_MAP_CALL });
    expect((JSON.parse(map.body) as { result: { isError?: boolean } }).result.isError).toBeFalsy();

    const { token: hostAgent } = await newToken("host-agent", "agent");
    const hostSession = await rawInitialize(running.url, { host, authorization: `Bearer ${hostAgent}` });
    const hostListed = await rawRequest(running.url, { method: "POST", headers: hostSession, body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }) });
    const hostNames = (JSON.parse(hostListed.body) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
    expect(hostNames).toEqual(expect.arrayContaining(["brain_merge", "brain_hangar_request"]));
  }, 30_000);

  it("ends a revoked token's open SSE stream on the session's next request", async () => {
    const { running, host } = await startTailnet();
    const { client, token } = await newToken("stream");
    const session = await rawInitialize(running.url, { host, authorization: `Bearer ${token}` });

    const { "content-type": _type, ...getHeaders } = session;
    let streamStatus = 0;
    let streamEnded = false;
    const stream = httpRequest(running.url, { method: "GET", headers: { ...getHeaders, accept: "text/event-stream" } }, (res) => {
      streamStatus = res.statusCode ?? 0;
      res.resume();
      res.on("close", () => (streamEnded = true));
    });
    stream.on("error", () => (streamEnded = true));
    stream.end();
    await until(() => streamStatus !== 0);
    expect(streamStatus).toBe(200);
    expect(streamEnded).toBe(false);

    await revokeClientToken(db!, client);
    expect(streamEnded).toBe(false);
    const refused = await rawRequest(running.url, { method: "POST", headers: session, body: BRAIN_MAP_CALL });
    expect(refused.status).toBe(401);
    await until(() => streamEnded);

    // The session is gone: a re-issued token for the same client cannot pick it up.
    tokenClients.push(client);
    const { token: reissued } = await createClientToken(db!, client, "human");
    const after = await rawRequest(running.url, { method: "POST", headers: { ...session, authorization: `Bearer ${reissued}` }, body: BRAIN_MAP_CALL });
    expect(after.status).toBe(404);
  }, 30_000);

  it("leaves a token session open when a request naming it is refused without a credential, or from a foreign Origin", async () => {
    const { running, host } = await startTailnet();
    const { token } = await newToken("kept");
    const session = await rawInitialize(running.url, { host, authorization: `Bearer ${token}` });
    const { authorization: _drop, ...tokenless } = session;

    const noCredential = await rawRequest(running.url, { method: "POST", headers: tokenless, body: BRAIN_MAP_CALL });
    expect(noCredential.status).toBe(401);
    const foreignOrigin = await rawRequest(running.url, { method: "POST", headers: { ...session, origin: "https://evil.example" }, body: BRAIN_MAP_CALL });
    expect(foreignOrigin.status).toBe(403);

    const still = await rawRequest(running.url, { method: "POST", headers: session, body: BRAIN_MAP_CALL });
    expect(still.status).toBe(200);
  }, 30_000);

  it("closes a token session when a request naming it presents a revoked token", async () => {
    const { running, host } = await startTailnet();
    const { client, token } = await newToken("closed");
    const session = await rawInitialize(running.url, { host, authorization: `Bearer ${token}` });
    await revokeClientToken(db!, client);
    expect((await rawRequest(running.url, { method: "POST", headers: session, body: BRAIN_MAP_CALL })).status).toBe(401);

    tokenClients.push(client);
    const { token: reissued } = await createClientToken(db!, client, "human");
    const after = await rawRequest(running.url, { method: "POST", headers: { ...session, authorization: `Bearer ${reissued}` }, body: BRAIN_MAP_CALL });
    expect(after.status).toBe(404);
  }, 30_000);

  it("leaves a token session open when an unknown token or another client's refused token names it", async () => {
    const { running, host } = await startTailnet();
    const { token } = await newToken("victim");
    const session = await rawInitialize(running.url, { host, authorization: `Bearer ${token}` });

    const garbage = await rawRequest(running.url, { method: "POST", headers: { ...session, authorization: "Bearer garbage" }, body: BRAIN_MAP_CALL });
    expect(garbage.status).toBe(401);
    const unknown = `bdt_${Buffer.alloc(32, 9).toString("base64url")}`;
    expect((await rawRequest(running.url, { method: "POST", headers: { ...session, authorization: `Bearer ${unknown}` }, body: BRAIN_MAP_CALL })).status).toBe(401);
    const hangar = await newToken("hangar-other", "hangar");
    expect((await rawRequest(running.url, { method: "POST", headers: { ...session, authorization: `Bearer ${hangar.token}` }, body: BRAIN_MAP_CALL })).status).toBe(403);

    const still = await rawRequest(running.url, { method: "POST", headers: session, body: BRAIN_MAP_CALL });
    expect(still.status).toBe(200);
  }, 30_000);

  it("closes a token session on any credential refusal naming it once its client's token is revoked", async () => {
    const { running, host } = await startTailnet();
    const { client, token } = await newToken("garbage-after");
    const session = await rawInitialize(running.url, { host, authorization: `Bearer ${token}` });
    await revokeClientToken(db!, client);
    expect((await rawRequest(running.url, { method: "POST", headers: { ...session, authorization: "Bearer garbage" }, body: BRAIN_MAP_CALL })).status).toBe(401);

    tokenClients.push(client);
    const { token: reissued } = await createClientToken(db!, client, "human");
    const after = await rawRequest(running.url, { method: "POST", headers: { ...session, authorization: `Bearer ${reissued}` }, body: BRAIN_MAP_CALL });
    expect(after.status).toBe(404);
  }, 30_000);

  it("refuses a hangar token on /mcp with 403", async () => {
    const { running, host } = await startTailnet();
    const { token } = await newToken("hangar", "hangar");
    const res = await rawRequest(running.url, { method: "POST", headers: { ...MCP_POST_HEADERS, host, authorization: `Bearer ${token}` }, body: initializeBody() });
    expect(res.status).toBe(403);
  }, 30_000);

  it("leaves a tokenless loopback session open when a refused request names it", async () => {
    const { running, host } = await startTailnet();
    const { client, transport } = await connect(running.url, "loopback-kept", suffix);
    const refused = await rawRequest(running.url, { method: "POST", headers: { ...sessionHeaders(transport), host }, body: BRAIN_MAP_CALL });
    expect(refused.status).toBe(401);
    await expect(client.callTool({ name: "brain_map", arguments: {} })).resolves.toBeDefined();
  }, 30_000);

  it("refuses with 403 a call on a session opened by another client, token or not, writing nothing", async () => {
    const { running, host } = await startTailnet();
    const a = await newToken("owner");
    const b = await newToken("intruder");
    const session = await rawInitialize(running.url, { host, authorization: `Bearer ${a.token}` });
    const externalId = `hijack-${suffix}`;
    const forbidden = { jsonrpc: "2.0", error: { code: -32000, message: "Forbidden: this session belongs to another client" }, id: null };

    const asB = await rawRequest(running.url, { method: "POST", headers: { ...session, authorization: `Bearer ${b.token}` }, body: brainWriteCall(externalId) });
    expect(asB.status).toBe(403);
    expect(JSON.parse(asB.body)).toEqual(forbidden);

    const { authorization: _drop, ...tokenless } = session;
    const asLoopback = await rawRequest(running.url, { method: "POST", headers: { ...tokenless, host: `127.0.0.1:${running.port}` }, body: brainWriteCall(externalId) });
    expect(asLoopback.status).toBe(403);
    expect(JSON.parse(asLoopback.body)).toEqual(forbidden);

    expect(await nodeExists(externalId)).toBe(false);
  }, 30_000);

  it("refuses with 403 a token-bearing call on a tokenless loopback session", async () => {
    const { running, host } = await startTailnet();
    const { token } = await newToken("late");
    const { transport } = await connect(running.url, "loopback-owner", suffix);
    const externalId = `loopback-owned-${suffix}`;
    const res = await rawRequest(running.url, { method: "POST", headers: { ...sessionHeaders(transport), host, authorization: `Bearer ${token}` }, body: brainWriteCall(externalId) });
    expect(res.status).toBe(403);
    expect(await nodeExists(externalId)).toBe(false);
  }, 30_000);

  it("refuses a valid token behind a foreign Host with 403", async () => {
    const { running } = await startTailnet();
    const { token } = await newToken("foreign");
    const res = await rawRequest(running.url, { method: "POST", headers: { ...MCP_POST_HEADERS, host: `evil.example:${running.port}`, authorization: `Bearer ${token}` }, body: initializeBody() });
    expect(res.status).toBe(403);
  });

  it("ignores a token in the query string: 401", async () => {
    const { running, host } = await startTailnet();
    const { token } = await newToken("query");
    const res = await rawRequest(`${running.url}?token=${token}`, { method: "POST", headers: { ...MCP_POST_HEADERS, host }, body: initializeBody() });
    expect(res.status).toBe(401);
  });
});

describe("request body cap", () => {
  it("refuses a declared Content-Length over the cap with 413, before reading it", async () => {
    const running = await start();
    const head =
      `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${running.port}\r\nContent-Type: application/json\r\n` +
      `Accept: application/json, text/event-stream\r\nContent-Length: ${MAX_BODY_BYTES + 1}\r\n\r\n`;
    const response = await rawSocketRequest(running.port, head);
    expect(response).toMatch(/^HTTP\/1\.1 413 /);
    expect(response).toContain("Payload Too Large");
  });

  it("refuses a chunked body once it passes the cap", async () => {
    const running = await start();
    const chunk = Buffer.alloc(1024 * 1024, 0x20);
    const status = await new Promise<number>((resolve, reject) => {
      let answered = false;
      const req = httpRequest(running.url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" } }, (res) => {
        answered = true;
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      // Once answered, the server dropping the connection is expected.
      req.on("error", (err) => {
        if (!answered) reject(err);
      });
      let sent = 0;
      const pump = (): void => {
        while (sent <= MAX_BODY_BYTES && !answered) {
          sent += chunk.length;
          if (!req.write(chunk)) {
            req.once("drain", pump);
            return;
          }
        }
        req.end();
      };
      pump();
    }).catch((err: unknown) => {
      // The server may drop the socket while the client is still writing.
      throw new Error(`chunked upload failed before a response: ${String(err)}`);
    });
    expect(status).toBe(413);
  }, 30_000);
});

describe("/healthz", () => {
  it("returns 200 with the read-only flag and a password-free target", async () => {
    const running = await start();
    const res = await fetch(running.url.replace("/mcp", "/healthz"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ready: boolean; readOnly: boolean; database: string };
    expect(body).toEqual({ ready: true, readOnly: false, database: target });
    // The test database's password equals its name, so check for the
    // credential pair rather than the bare password.
    const { username, password } = new URL(databaseUrl);
    expect(body.database).not.toContain("@");
    if (password) expect(body.database).not.toContain(`${username}:${password}`);
  });

  it("returns 503 naming the failure when the database is down, and keeps serving", async () => {
    const deadPool = createPool("postgres://breakdown:breakdown@127.0.0.1:1/breakdown");
    try {
      const running = await start({ pool: deadPool });
      const healthz = running.url.replace("/mcp", "/healthz");
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await fetch(healthz);
        expect(res.status).toBe(503);
        const body = (await res.json()) as { ready: boolean; error: string };
        expect(body.ready).toBe(false);
        expect(body.error).toMatch(/ECONNREFUSED/);
      }
    } finally {
      await Promise.all(servers.splice(0).map((s) => s.close()));
      await deadPool.end().catch(() => {});
    }
  });

  it("shares one query among concurrent probes of a hung database", async () => {
    const hung = hangingPool();
    const running = await start({ pool: hung, db: db! });
    const healthz = running.url.replace("/mcp", "/healthz");
    const responses = await Promise.all([fetch(healthz), fetch(healthz), fetch(healthz)]);
    for (const res of responses) {
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: string }).error).toBe(`database did not answer within ${HEALTH_TIMEOUT_MS}ms`);
    }
    expect(hung.calls).toBe(1);
  }, 15_000);

  it("refuses a method other than GET with 405", async () => {
    const running = await start();
    const res = await fetch(running.url.replace("/mcp", "/healthz"), { method: "POST" });
    expect(res.status).toBe(405);
  });
});

describe("createDatabaseProbe", () => {
  it("gives up on a database that never answers, without issuing a second query", async () => {
    const hung = hangingPool();
    const probe = createDatabaseProbe(hung, 50);
    const startedAt = Date.now();
    expect(await probe()).toEqual({ ok: false, error: "database did not answer within 50ms" });
    expect(Date.now() - startedAt).toBeLessThan(HEALTH_TIMEOUT_MS);
    expect(await probe()).toEqual({ ok: false, error: "database did not answer within 50ms" });
    expect(hung.calls).toBe(1);
  });

  it("issues a fresh query once the previous one settles", async () => {
    let calls = 0;
    const answering = { query: async () => void calls++ } as unknown as PoolLike;
    const probe = createDatabaseProbe(answering, 1_000);
    expect(await probe()).toEqual({ ok: true });
    expect(await probe()).toEqual({ ok: true });
    expect(calls).toBe(2);
  });
});

describe("read-only mode over HTTP", () => {
  it("does not advertise brain_write, refuses a call to it, and writes nothing", async () => {
    const running = await start({ readOnly: true });
    const { client } = await connect(running.url, "read-only-client", suffix);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).not.toContain("brain_write");

    const externalId = `read-only-${suffix}`;
    const raw = await client.callTool({ name: "brain_write", arguments: { items: { nodeType: "doc", externalId, sourceSystem, content: "c" } } });
    expect(raw.isError).toBe(true);
    expect(textOf(raw)).toMatch(/read-only/);
    expect(await nodeExists(externalId)).toBe(false);

    const health = (await (await fetch(running.url.replace("/mcp", "/healthz"))).json()) as { readOnly: boolean };
    expect(health.readOnly).toBe(true);
  }, 30_000);
});

describe("createSessionRegistry", () => {
  function fakeSession() {
    return { close: vi.fn(async () => {}) };
  }

  it("evicts and closes the least recently seen session past the cap", () => {
    let now = 0;
    const registry = createSessionRegistry<ReturnType<typeof fakeSession>>({ maxSessions: 2, idleLimitMs: 1000, now: () => now });
    const a = fakeSession();
    const b = fakeSession();
    const c = fakeSession();
    registry.add("a", a);
    now = 1;
    registry.add("b", b);
    now = 2;
    registry.add("c", c);
    expect(a.close).toHaveBeenCalledOnce();
    expect(registry.get("a")).toBeUndefined();
    expect(registry.get("b")).toBe(b);
    expect(registry.get("c")).toBe(c);
    expect(registry.size).toBe(2);
  });

  it("touch makes a session the last to be evicted", () => {
    let now = 0;
    const registry = createSessionRegistry<ReturnType<typeof fakeSession>>({ maxSessions: 2, idleLimitMs: 1000, now: () => now });
    const a = fakeSession();
    const b = fakeSession();
    const c = fakeSession();
    registry.add("a", a);
    registry.add("b", b);
    now = 5;
    registry.touch("a");
    registry.add("c", c);
    expect(b.close).toHaveBeenCalledOnce();
    expect(a.close).not.toHaveBeenCalled();
    expect(registry.get("a")).toBe(a);
  });

  it("sweep closes only sessions idle past the limit", () => {
    let now = 0;
    const registry = createSessionRegistry<ReturnType<typeof fakeSession>>({ maxSessions: 2, idleLimitMs: 1000, now: () => now });
    const old = fakeSession();
    const recent = fakeSession();
    registry.add("old", old);
    now = 900;
    registry.add("recent", recent);
    now = 1500;
    registry.sweep();
    expect(old.close).toHaveBeenCalledOnce();
    expect(recent.close).not.toHaveBeenCalled();
    expect(registry.get("old")).toBeUndefined();
    expect(registry.get("recent")).toBe(recent);
  });

  it("remove forgets without closing; closeAll closes the rest", async () => {
    const registry = createSessionRegistry<ReturnType<typeof fakeSession>>({ maxSessions: 4, idleLimitMs: 1000, now: () => 0 });
    const a = fakeSession();
    const b = fakeSession();
    registry.add("a", a);
    registry.add("b", b);
    registry.remove("a");
    await registry.closeAll();
    expect(a.close).not.toHaveBeenCalled();
    expect(b.close).toHaveBeenCalledOnce();
    expect(registry.size).toBe(0);
  });
});
