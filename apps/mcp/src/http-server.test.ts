// http-server.ts driven in-process on ephemeral ports (port 0) against the
// test database (brain-mcp spec, "Shared HTTP transport", "HTTP mode is
// local only"; brain-service spec, "Health endpoint").
//
// The database is shared with live sessions and with the other apps/mcp
// test files running in parallel, so every fixture is scoped: nodes carry
// this file's unique source system, and runs are removed by the ids the
// writes returned. Client versions carry this file's suffix, so no other
// file's actor-scoped sweep (server.test.ts deletes zero-count runs by
// actor) can match a run of ours while it is still open.

import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createDb, createPool, ingestRuns, nodes, resolveDatabaseUrl, type Database } from "@breakdown/db";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createSessionRegistry, HEALTH_TIMEOUT_MS, probeDatabase, startHttpServer, type RunningHttpServer } from "./http-server.js";
import { describeConnectionTarget } from "./startup.js";

const mcpRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsxBin = path.join(mcpRoot, "node_modules", ".bin", "tsx");
const stdioEntry = path.join(mcpRoot, "src", "index.ts");

const suffix = randomUUID().replace(/-/g, "");
const sourceSystem = `mcp-http-${suffix}`;
const runIds: string[] = [];

let databaseUrl: string;
let pool: ReturnType<typeof createPool>;
let db: Database;
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
  await db.delete(nodes).where(eq(nodes.sourceSystem, sourceSystem));
  if (runIds.length > 0) {
    await db.delete(nodes).where(inArray(nodes.ingestRunId, runIds));
    await db.delete(ingestRuns).where(inArray(ingestRuns.id, runIds));
  }
  await pool.end();
});

async function start(overrides: { readOnly?: boolean; pool?: ReturnType<typeof createPool> } = {}): Promise<RunningHttpServer> {
  const p = overrides.pool ?? pool;
  const running = await startHttpServer({ db: createDb(p), pool: p, readOnly: overrides.readOnly ?? false, target, port: 0, host: "127.0.0.1" });
  servers.push(running);
  return running;
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
  expect(raw.isError, textOf(raw)).toBeFalsy();
  const { ingestRunId } = JSON.parse(textOf(raw)) as { ingestRunId: string };
  runIds.push(ingestRunId);
  return ingestRunId;
}

async function nodeExists(externalId: string): Promise<boolean> {
  const rows = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.sourceSystem, sourceSystem), eq(nodes.externalId, externalId)));
  return rows.length > 0;
}

interface RawResponse {
  status: number;
  body: string;
}

/** node:http rather than fetch, which refuses to set Host. */
function rawRequest(url: string, options: { method: string; headers: Record<string, string>; body?: string }): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: options.method, headers: options.headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end(options.body);
  });
}

describe("sessions over Streamable HTTP", () => {
  it("attributes each client's write to its own actor", async () => {
    const running = await start();
    const claude = await connect(running.url, "claude-code", `2.1.0+${suffix}`);
    const codex = await connect(running.url, "codex", `0.164.0+${suffix}`);

    const claudeRun = await writeNode(claude.client, `claude-${suffix}`);
    const codexRun = await writeNode(codex.client, `codex-${suffix}`);

    const runs = await db.select({ id: ingestRuns.id, sourceSystem: ingestRuns.sourceSystem, actor: ingestRuns.actor }).from(ingestRuns).where(inArray(ingestRuns.id, [claudeRun, codexRun]));
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
    await first.close();
    servers.splice(servers.indexOf(first), 1);

    const second = await start();
    const res = await fetch(second.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": staleId! },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null });

    const fresh = await connect(second.url, "restart-client", suffix);
    expect((await fresh.client.listTools()).tools.length).toBeGreaterThan(0);
  }, 30_000);

  it("refuses with 400 a GET or DELETE on /mcp with no session id", async () => {
    const running = await start();
    for (const method of ["GET", "DELETE"]) {
      const res = await fetch(running.url, { method, headers: { accept: "text/event-stream" } });
      expect(res.status, method).toBe(400);
    }
  });
});

describe("local-only guard", () => {
  it("refuses a foreign Host and a foreign Origin with 403, writing nothing", async () => {
    const running = await start();
    const { transport } = await connect(running.url, "guard-client", suffix);
    const sessionId = transport.sessionId!;
    const externalId = `guard-${suffix}`;
    const writeBody = JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "brain_write", arguments: { items: { nodeType: "doc", externalId, sourceSystem, content: "c" } } },
    });
    const mcpHeaders = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
      "mcp-protocol-version": transport.protocolVersion ?? "2025-06-18",
    };

    const foreignOrigin = await rawRequest(running.url, { method: "POST", headers: { ...mcpHeaders, host: `127.0.0.1:${running.port}`, origin: "https://evil.example" }, body: writeBody });
    expect(foreignOrigin.status).toBe(403);

    const foreignHost = await rawRequest(running.url, { method: "POST", headers: { ...mcpHeaders, host: `evil.example:${running.port}` }, body: writeBody });
    expect(foreignHost.status).toBe(403);

    const foreignOriginGet = await rawRequest(running.url, { method: "GET", headers: { ...mcpHeaders, accept: "text/event-stream", host: `127.0.0.1:${running.port}`, origin: "https://evil.example" } });
    expect(foreignOriginGet.status).toBe(403);

    const healthzForeignHost = await rawRequest(running.url.replace("/mcp", "/healthz"), { method: "GET", headers: { host: `evil.example:${running.port}` } });
    expect(healthzForeignHost.status).toBe(403);

    expect(await nodeExists(externalId)).toBe(false);
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

  it("refuses a method other than GET with 405", async () => {
    const running = await start();
    const res = await fetch(running.url.replace("/mcp", "/healthz"), { method: "POST" });
    expect(res.status).toBe(405);
  });

  it("probeDatabase gives up on a database that never answers", async () => {
    const hanging = { query: () => new Promise<never>(() => {}) } as unknown as Parameters<typeof probeDatabase>[0];
    const startedAt = Date.now();
    const result = await probeDatabase(hanging, 50);
    expect(result).toEqual({ ok: false, error: "database did not answer within 50ms" });
    expect(Date.now() - startedAt).toBeLessThan(HEALTH_TIMEOUT_MS);
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
