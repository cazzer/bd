// The hangar REST API over real HTTP (hangar-queue spec: claiming, session
// tokens, reporting state, messages by long-poll; docs/hangar-api.md): the
// production dispatcher and handler, real tokens from the store, and a
// tailnet Host, since admission trusts a loopback request without reading
// its token (dispatch.test.ts's header). tRPC is the real router too, so a
// worker's inbox request and a person's decision reach the worker's
// messages end to end.
//
// The database is shared with live data. Every claim goes through the
// `claimAmong` seam, set per test to this file's own fixtures, so no claim
// can take a real queued request. Tokens, check-ins, sessions, messages, and
// runs are this file's own and deleted by name, id, or actor prefix; nothing
// asserts on a table as a whole.

import { randomUUID } from "node:crypto";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { appendHangarMessage, closeIngestRun, createClientToken, openIngestRun, requestSession, upsertNodes, verifyClientToken, type IngestRunHandle } from "@breakdown/core";
import { clientTokens, createDb, createPool, hangarCheckIns, hangarMessages, nodes, resolveDatabaseUrl, type Database } from "@breakdown/db";
import { createHTTPHandler } from "@trpc/server/adapters/standalone";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createContextFactory } from "./context.js";
import { createRequestDispatcher } from "./dispatch.js";
import { createHangarHandler, HANGAR_ENDPOINTS, MAX_HANGAR_BODY_BYTES } from "./hangar-api.js";
import { appRouter } from "./router.js";

const TAILNET = "breakdown.tail.example";
const suffix = randomUUID().slice(0, 8);
const PREFIX = `hgapi-${suffix}`;
const HANGAR_A = `${PREFIX}-a`;
const HANGAR_B = `${PREFIX}-b`;
const WORKER = `${PREFIX}-worker`;
const PHONE = `${PREFIX}-phone`;
const FIXTURE_SOURCE = `hangar-api-test-${suffix}`;
const INBOX_KEY = `session:${PREFIX}`;

let pool: ReturnType<typeof createPool>;
let db: Database;
let fixtureRun: IngestRunHandle;
const servers: Server[] = [];
let port: number;
let readOnlyPort: number;
const tokens: Record<string, string> = {};
const sessionIds: string[] = [];
const fixtureNodes: string[] = [];
/** The sessions a claim may take right now (the `claimAmong` seam). */
let among: string[] = [];

async function listen(hangarReadOnly: boolean): Promise<number> {
  let dispatch: ReturnType<typeof createRequestDispatcher> | null = null;
  const server = createServer((req, res) => dispatch!(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const p = (server.address() as AddressInfo).port;
  dispatch = createRequestDispatcher({
    port: p,
    allowedHosts: [TAILNET],
    verifyToken: (token) => verifyClientToken(db, token),
    connect: async (_req, res) => void res.writeHead(500).end(),
    health: async (_req, res) => void res.writeHead(500).end(),
    reviewImages: async (_req, res) => void res.writeHead(500).end(),
    hangar: createHangarHandler({ db, readOnly: hangarReadOnly, claimAmong: () => among }),
    trpc: createHTTPHandler({ router: appRouter, createContext: createContextFactory(db), basePath: "/trpc/" }),
  });
  return p;
}

beforeAll(async () => {
  pool = createPool(resolveDatabaseUrl());
  db = createDb(pool);
  fixtureRun = await openIngestRun(db, FIXTURE_SOURCE, { actor: PREFIX });
  tokens[HANGAR_A] = (await createClientToken(db, HANGAR_A, "hangar")).token;
  tokens[HANGAR_B] = (await createClientToken(db, HANGAR_B, "hangar")).token;
  tokens[WORKER] = (await createClientToken(db, WORKER, "agent")).token;
  tokens[PHONE] = (await createClientToken(db, PHONE, "human")).token;
  port = await listen(false);
  readOnlyPort = await listen(true);
});

afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  const sessionClients = sessionIds.map((id) => `session-${id}`);
  await db.delete(clientTokens).where(inArray(clientTokens.client, [HANGAR_A, HANGAR_B, WORKER, PHONE, ...sessionClients]));
  if (sessionIds.length > 0) await db.delete(hangarMessages).where(inArray(hangarMessages.sessionId, sessionIds));
  await db.delete(hangarCheckIns).where(inArray(hangarCheckIns.hangar, [HANGAR_A, HANGAR_B]));
  await db.delete(nodes).where(and(eq(nodes.sourceSystem, "inbox"), like(nodes.externalId, `${INBOX_KEY}%`)));
  const ids = [...sessionIds, ...fixtureNodes];
  if (ids.length > 0) await db.delete(nodes).where(inArray(nodes.id, ids));
  await closeIngestRun(db, fixtureRun);
  await db.execute(sql`DELETE FROM ingest_runs WHERE source_system = ${FIXTURE_SOURCE} OR actor LIKE ${`${PREFIX}%`} OR actor = ANY(${`{${sessionClients.join(",")}}`}::text[])`);
  await pool.end();
});

// --- Helpers ---------------------------------------------------------------------------------

interface Sent {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
  json: { error?: { code: string; message: string } } & Record<string, unknown>;
}

interface SendOptions {
  method?: string;
  token?: string | null;
  body?: unknown;
  /** Sent as is instead of JSON-encoding `body`. */
  raw?: Buffer | string;
  contentType?: string | null;
  headers?: Record<string, string>;
  /** Defaults to the tailnet Host. */
  host?: string;
  port?: number;
  /** Destroys the request after this many ms (a client that goes away). */
  abortAfterMs?: number;
}

function send(path: string, options: SendOptions = {}): Promise<Sent> {
  const p = options.port ?? port;
  const headers: Record<string, string> = { Host: options.host ?? `${TAILNET}:${p}`, ...options.headers };
  if (options.token !== null && options.token !== undefined) headers["Authorization"] = `Bearer ${options.token}`;
  const payload = options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
  if (payload !== undefined && options.contentType !== null) headers["Content-Type"] = options.contentType ?? "application/json";
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: p, path, method: options.method ?? (payload === undefined ? "GET" : "POST"), headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => {
        let json: Sent["json"] = {};
        try {
          json = JSON.parse(body) as Sent["json"];
        } catch {
          // not JSON; the test asserts on what it expects
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json });
      });
    });
    req.on("error", reject);
    if (options.abortAfterMs !== undefined) setTimeout(() => req.destroy(new Error("client went away")), options.abortAfterMs);
    req.end(payload);
  });
}

const errorCode = (sent: Sent): string | undefined => sent.json.error?.code;

async function workItem(title: string): Promise<{ id: string; externalId: string }> {
  const externalId = randomUUID();
  const result = await upsertNodes(db, fixtureRun, [{ nodeType: "work_item", sourceSystem: FIXTURE_SOURCE, externalId, title, metadata: { status: "open" } }]);
  const id = result.rows[0]!.id;
  fixtureNodes.push(id);
  return { id, externalId };
}

/** A queued session of `flavor` for a fresh work item. Not claimable until a test lets it be. */
async function queued(flavor = "headless", title = "Fix the thing"): Promise<{ id: string; workItem: { id: string; externalId: string } }> {
  const item = await workItem(title);
  const { session } = await requestSession(db, { repo: "cazzer/bd", workItemId: item.id, flavor, actor: `${PREFIX}-requester` });
  sessionIds.push(session.id);
  return { id: session.id, workItem: item };
}

async function metadataOf(id: string): Promise<Record<string, unknown>> {
  const [row] = await db.select({ metadata: nodes.metadata }).from(nodes).where(eq(nodes.id, id));
  return row!.metadata as Record<string, unknown>;
}

/** Claims exactly `id` for `hangar`, returning the session JSON and its token. */
async function claim(id: string, hangar = HANGAR_A): Promise<{ session: Record<string, unknown>; token: string }> {
  among = [id];
  const sent = await send("/hangar/v1/claim", { token: tokens[hangar], body: { flavors: ["headless", "display-browser", "display-godot"] } });
  expect(sent.status, sent.body).toBe(200);
  among = [];
  return sent.json as unknown as { session: Record<string, unknown>; token: string };
}

function patch(id: string, body: unknown, hangar = HANGAR_A): Promise<Sent> {
  return send(`/hangar/v1/sessions/${id}`, { method: "PATCH", token: tokens[hangar], body });
}

async function appendMessage(sessionId: string, body: Record<string, unknown>): Promise<number> {
  return (await db.transaction((tx) => appendHangarMessage(tx, { sessionId, kind: "test", body }))).id;
}

// --- Endpoints ----------------------------------------------------------------------------------

describe("POST /hangar/v1/check-in", () => {
  it("records the hangar's version and capacity and answers the interval and the server's clock", async () => {
    const sent = await send("/hangar/v1/check-in", { token: tokens[HANGAR_A], body: { version: "0.4.1", capacity: { slots: 2 } } });
    expect(sent.status, sent.body).toBe(200);
    expect(sent.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(sent.json).toEqual({ interval_s: 30, now: expect.any(String) });
    expect(Math.abs(Date.parse(sent.json["now"] as string) - Date.now())).toBeLessThan(5000);
    const [row] = await db.select().from(hangarCheckIns).where(eq(hangarCheckIns.hangar, HANGAR_A));
    expect(row).toMatchObject({ version: "0.4.1", capacity: { slots: 2 } });
  });

  it("refuses a missing or mistyped version with invalid_request naming it", async () => {
    const missing = await send("/hangar/v1/check-in", { token: tokens[HANGAR_A], body: {} });
    expect(missing.status).toBe(400);
    expect(missing.json.error).toMatchObject({ code: "invalid_request", message: expect.stringContaining("version") });
    const mistyped = await send("/hangar/v1/check-in", { token: tokens[HANGAR_A], body: { version: 4 } });
    expect(mistyped.status).toBe(400);
    expect(mistyped.json.error).toMatchObject({ code: "invalid_request", message: expect.stringContaining("version") });
  });

  it("ignores an unknown field, so a newer hangar keeps working", async () => {
    const sent = await send("/hangar/v1/check-in", { token: tokens[HANGAR_A], body: { version: "0.5.0", slots: 3, capacity: { slots: 1 } } });
    expect(sent.status, sent.body).toBe(200);
    const [row] = await db.select().from(hangarCheckIns).where(eq(hangarCheckIns.hangar, HANGAR_A));
    expect(row).toMatchObject({ version: "0.5.0", capacity: { slots: 1 } });
  });
});

describe("POST /hangar/v1/claim", () => {
  it("takes a queued session of a named flavor with its work item and a session token, then finds none", async () => {
    const { id, workItem: item } = await queued("headless", "Claimable work");
    const other = await queued("display-godot");
    among = [id, other.id];
    const sent = await send("/hangar/v1/claim", { token: tokens[HANGAR_A], body: { flavors: ["headless", "display-browser"], wait_s: 0 } });
    expect(sent.status, sent.body).toBe(200);
    expect(sent.json["session"]).toMatchObject({
      id,
      state: "claimed",
      flavor: "headless",
      repo: "cazzer/bd",
      work_item: { id: item.id, external_id: item.externalId, source_system: FIXTURE_SOURCE, title: "Claimable work" },
      container: null,
      host: null,
      disk_path: null,
      requeue_reason: null,
      claimed_by: HANGAR_A,
      claimed_at: expect.any(String),
      requested_at: expect.any(String),
    });
    expect(sent.json["token"]).toMatch(/^bdt_/);
    expect(await verifyClientToken(db, sent.json["token"] as string)).toEqual({ client: `session-${id}`, scope: "agent", sessionId: id });

    const none = await send("/hangar/v1/claim", { token: tokens[HANGAR_A], body: { flavors: ["headless"] } });
    expect(none.status).toBe(200);
    expect(none.json).toEqual({ session: null });
    expect((await metadataOf(other.id))["state"]).toBe("queued");
    among = [];
  });

  it("refuses an agent token with 403 and changes nothing", async () => {
    const { id } = await queued();
    among = [id];
    const before = await metadataOf(id);
    const sent = await send("/hangar/v1/claim", { token: tokens[WORKER], body: { flavors: ["headless"] } });
    expect(sent.status).toBe(403);
    expect(errorCode(sent)).toBe("forbidden");
    expect(await metadataOf(id)).toEqual(before);
    among = [];
  });

  it("refuses bad bodies with invalid_request", async () => {
    for (const body of [{ flavors: [] }, { flavors: ["headless", "headless"] }, { flavors: ["gpu"] }, { flavors: ["headless"], wait_s: 31 }, { flavors: ["headless"], wait_s: 1.5 }]) {
      const sent = await send("/hangar/v1/claim", { token: tokens[HANGAR_A], body });
      expect(sent.status, JSON.stringify(body)).toBe(400);
      expect(errorCode(sent), JSON.stringify(body)).toBe("invalid_request");
    }
  });
});

describe("PATCH /hangar/v1/sessions/:id and GET /hangar/v1/sessions", () => {
  it("reports placement and state, lists only the caller's sessions, refuses another hangar and a backwards move, and revokes the token on stop", async () => {
    const mine = await queued();
    const { token } = await claim(mine.id);
    const theirs = await queued();
    await claim(theirs.id, HANGAR_B);

    const running = await patch(mine.id, { state: "running", container: "c-12", host: "hangar-linux", disk_path: `/var/lib/hangar/disks/${mine.id}.img` });
    expect(running.status, running.body).toBe(200);
    expect(running.json["session"]).toMatchObject({ id: mine.id, state: "running", container: "c-12", host: "hangar-linux", disk_path: `/var/lib/hangar/disks/${mine.id}.img` });

    const cleared = await patch(mine.id, { host: null });
    expect(cleared.json["session"]).toMatchObject({ state: "running", host: null, container: "c-12" });

    const listed = await send("/hangar/v1/sessions?state=running&state=claimed&limit=200", { token: tokens[HANGAR_A] });
    expect(listed.status, listed.body).toBe(200);
    const listedIds = (listed.json["sessions"] as { id: string }[]).map((s) => s.id);
    expect(listedIds).toContain(mine.id);
    expect(listedIds).not.toContain(theirs.id);
    expect(listed.json["truncated"]).toBe(false);
    const byDefault = await send("/hangar/v1/sessions", { token: tokens[HANGAR_B] });
    expect((byDefault.json["sessions"] as { id: string }[]).map((s) => s.id)).toContain(theirs.id);

    const notMine = await patch(theirs.id, { state: "running" });
    expect(notMine.status).toBe(403);
    expect(errorCode(notMine)).toBe("not_claimer");
    expect((await metadataOf(theirs.id))["state"]).toBe("claimed");

    expect((await send("/hangar/v1/messages", { token })).status).toBe(200);
    expect((await patch(mine.id, { state: "stopped" })).status).toBe(200);
    const backwards = await patch(mine.id, { state: "running" });
    expect(backwards.status).toBe(409);
    expect(backwards.json.error).toMatchObject({ code: "invalid_transition", message: expect.stringMatching(/stopped.*running/) });
    expect((await metadataOf(mine.id))["state"]).toBe("stopped");

    const revoked = await send("/hangar/v1/messages", { token });
    expect(revoked.status).toBe(401);
    expect(errorCode(revoked)).toBe("unauthorized");
    expect(revoked.headers["www-authenticate"]).toBe("Bearer");
  });

  it("refuses an empty update, an unknown session, and a bad state filter", async () => {
    const { id } = await queued();
    await claim(id);
    const empty = await patch(id, {});
    expect(empty.status).toBe(400);
    expect(errorCode(empty)).toBe("invalid_request");
    const unknown = await patch(randomUUID(), { state: "running" });
    expect(unknown.status).toBe(404);
    expect(errorCode(unknown)).toBe("not_found");
    const badState = await send("/hangar/v1/sessions?state=paused", { token: tokens[HANGAR_A] });
    expect(badState.status).toBe(400);
    const twice = await send("/hangar/v1/sessions?limit=1&limit=2", { token: tokens[HANGAR_A] });
    expect(twice.status).toBe(400);
  });
});

describe("POST /hangar/v1/sessions/:id/requeue", () => {
  it("returns a claimed session to the queue with its reason and revokes its token; a running one is refused", async () => {
    const { id } = await queued();
    const { token } = await claim(id);
    const sent = await send(`/hangar/v1/sessions/${id}/requeue`, { token: tokens[HANGAR_A], body: { reason: "disk budget full" } });
    expect(sent.status, sent.body).toBe(200);
    expect(sent.json["session"]).toMatchObject({ id, state: "queued", requeue_reason: "disk budget full", claimed_by: null, claimed_at: null });
    expect((await send("/hangar/v1/messages", { token })).status).toBe(401);

    const again = await claim(id);
    expect(again.session).toMatchObject({ state: "claimed", requeue_reason: null });
    expect((await patch(id, { state: "running" })).status).toBe(200);
    const refused = await send(`/hangar/v1/sessions/${id}/requeue`, { token: tokens[HANGAR_A], body: { reason: "too late" } });
    expect(refused.status).toBe(409);
    expect(errorCode(refused)).toBe("invalid_transition");
  });
});

describe("GET /hangar/v1/messages", () => {
  it("returns the token's own session's messages after the cursor, whatever session the request names", async () => {
    const a = await queued();
    const b = await queued();
    const { token } = await claim(a.id);
    const first = await appendMessage(a.id, { n: 1 });
    const second = await appendMessage(a.id, { n: 2 });
    await appendMessage(b.id, { n: "b's" });

    const all = await send(`/hangar/v1/messages?session=${b.id}&session_id=${b.id}`, { token });
    expect(all.status, all.body).toBe(200);
    expect(all.json).toEqual({
      messages: [
        { id: first, kind: "test", body: { n: 1 }, created_at: expect.any(String) },
        { id: second, kind: "test", body: { n: 2 }, created_at: expect.any(String) },
      ],
      cursor: second,
    });
    expect(await send(`/hangar/v1/messages?after=${first}`, { token })).toMatchObject({ json: { messages: [{ id: second }], cursor: second } });
    expect(await send(`/hangar/v1/messages?after=${second}`, { token })).toMatchObject({ json: { messages: [], cursor: second } });
    expect((await send("/hangar/v1/messages?after=-1", { token })).status).toBe(400);
    expect((await send("/hangar/v1/messages?wait_s=31", { token })).status).toBe(400);
  });

  it("refuses an agent token that is not bound to a session, and the hangar token", async () => {
    const worker = await send("/hangar/v1/messages", { token: tokens[WORKER] });
    expect(worker.status).toBe(403);
    expect(worker.json.error).toMatchObject({ code: "forbidden", message: expect.stringContaining("session token") });
    expect(errorCode(await send("/hangar/v1/messages", { token: tokens[HANGAR_A] }))).toBe("forbidden");
  });
});

// --- Scopes and refusals ---------------------------------------------------------------------------

describe("scopes", () => {
  const concrete = (path: string): string => path.replace(":id", randomUUID());

  it("refuses a human token on every endpoint with a JSON 403", async () => {
    for (const { method, path } of HANGAR_ENDPOINTS) {
      const sent = await send(concrete(path), { method, token: tokens[PHONE], ...(method === "GET" ? {} : { body: {} }) });
      expect(sent.status, `${method} ${path}`).toBe(403);
      expect(errorCode(sent), `${method} ${path}`).toBe("forbidden");
    }
  });

  it("refuses a tokenless loopback request (the local person) on every endpoint, even carrying a hangar token", async () => {
    for (const { method, path } of HANGAR_ENDPOINTS) {
      for (const token of [null, tokens[HANGAR_A]]) {
        const sent = await send(concrete(path), { method, token, host: `127.0.0.1:${port}`, ...(method === "GET" ? {} : { body: {} }) });
        expect(sent.status, `${method} ${path}`).toBe(403);
        expect(errorCode(sent)).toBe("forbidden");
      }
    }
  });

  it("refuses every write on a read-only server and still answers reads", async () => {
    const checkIn = await send("/hangar/v1/check-in", { port: readOnlyPort, token: tokens[HANGAR_A], body: { version: "1" } });
    expect(checkIn.status).toBe(403);
    expect(errorCode(checkIn)).toBe("read_only");
    const claimed = await send("/hangar/v1/claim", { port: readOnlyPort, token: tokens[HANGAR_A], body: { flavors: ["headless"] } });
    expect(errorCode(claimed)).toBe("read_only");
    expect((await send("/hangar/v1/sessions", { port: readOnlyPort, token: tokens[HANGAR_A] })).status).toBe(200);
  });
});

describe("routing and bodies", () => {
  it("answers 404 for an unknown path, a trailing slash, or an id that is not a uuid", async () => {
    for (const path of ["/hangar/v1/nope", "/hangar/v1/claim/", "/hangar/v1/sessions/not-a-uuid", "/hangar/v1/sessions/123/requeue"]) {
      const sent = await send(path, { token: tokens[HANGAR_A], method: "POST", body: {} });
      expect(sent.status, path).toBe(404);
      expect(errorCode(sent), path).toBe("not_found");
    }
  });

  it("answers 405 with Allow for a known path and the wrong method", async () => {
    const claimGet = await send("/hangar/v1/claim", { token: tokens[HANGAR_A] });
    expect(claimGet.status).toBe(405);
    expect(claimGet.headers["allow"]).toBe("POST");
    expect(errorCode(claimGet)).toBe("method_not_allowed");
    const sessionsPost = await send("/hangar/v1/sessions", { token: tokens[HANGAR_A], body: {} });
    expect(sessionsPost.headers["allow"]).toBe("GET");
    expect((await send(`/hangar/v1/sessions/${randomUUID()}`, { token: tokens[HANGAR_A] })).headers["allow"]).toBe("PATCH");
  });

  it("answers 415 without application/json, 413 past the cap (declared or streamed), and 400 for bad JSON or UTF-8", async () => {
    const text = await send("/hangar/v1/check-in", { token: tokens[HANGAR_A], raw: '{"version":"1"}', contentType: "text/plain" });
    expect(text.status).toBe(415);
    expect(errorCode(text)).toBe("unsupported_media_type");
    const none = await send("/hangar/v1/check-in", { token: tokens[HANGAR_A], raw: '{"version":"1"}', contentType: null });
    expect(none.status).toBe(415);

    const big = JSON.stringify({ version: "x".repeat(MAX_HANGAR_BODY_BYTES) });
    const declared = await send("/hangar/v1/check-in", { token: tokens[HANGAR_A], raw: big });
    expect(declared.status).toBe(413);
    expect(errorCode(declared)).toBe("too_large");
    const streamed = await send("/hangar/v1/check-in", { token: tokens[HANGAR_A], raw: big, headers: { "Transfer-Encoding": "chunked" } });
    expect(streamed.status).toBe(413);

    const badJson = await send("/hangar/v1/check-in", { token: tokens[HANGAR_A], raw: "{version:" });
    expect(badJson.status).toBe(400);
    expect(errorCode(badJson)).toBe("invalid_json");
    const badUtf8 = await send("/hangar/v1/check-in", { token: tokens[HANGAR_A], raw: Buffer.from([0x7b, 0x22, 0x76, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]) });
    expect(errorCode(badUtf8)).toBe("invalid_json");
  });
});

// --- Long-poll ---------------------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("long-poll", () => {
  it("a claim waiting 5 s answers soon after a matching request is enqueued", async () => {
    among = [];
    const started = Date.now();
    const pending = send("/hangar/v1/claim", { token: tokens[HANGAR_A], body: { flavors: ["display-browser"], wait_s: 5 } });
    await sleep(1500);
    const { id } = await queued("display-browser");
    among = [id];
    const sent = await pending;
    among = [];
    expect(sent.status, sent.body).toBe(200);
    expect(sent.json["session"]).toMatchObject({ id, state: "claimed" });
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it("a message read waiting 5 s answers soon after a message is appended", async () => {
    const { id } = await queued();
    const { token } = await claim(id);
    const started = Date.now();
    const pending = send("/hangar/v1/messages?after=0&wait_s=5", { token });
    await sleep(1500);
    const appended = await appendMessage(id, { hello: "worker" });
    const sent = await pending;
    expect(sent.json).toMatchObject({ messages: [{ id: appended, body: { hello: "worker" } }], cursor: appended });
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it("an empty wait answers at its bound", async () => {
    const started = Date.now();
    const sent = await send("/hangar/v1/claim", { token: tokens[HANGAR_A], body: { flavors: ["display-godot"], wait_s: 1 } });
    expect(sent.json).toEqual({ session: null });
    expect(Date.now() - started).toBeGreaterThanOrEqual(950);
  });

  it("stops when the client goes away: a request enqueued after the disconnect is not claimed", async () => {
    among = [];
    const gone = send("/hangar/v1/claim", { token: tokens[HANGAR_A], body: { flavors: ["display-godot"], wait_s: 5 }, abortAfterMs: 300 });
    await expect(gone).rejects.toThrow();
    const { id } = await queued("display-godot");
    among = [id];
    // Past the next attempts the loop would have made had it kept going.
    await sleep(2500);
    among = [];
    expect((await metadataOf(id))["state"]).toBe("queued");
  });
});

// --- A worker's inbox request, end to end -----------------------------------------------------------

describe("a remote worker's inbox request", () => {
  function trpc(token: string, procedure: string, input: unknown): Promise<Sent> {
    return send(`/trpc/${procedure}`, { token, body: input });
  }

  it("is bound to the session from its token, and the person's decision arrives as the session's message with no herdr call", async () => {
    const { id } = await queued();
    const { token } = await claim(id);
    const requested = await trpc(token, "inboxRequest", {
      key: `${INBOX_KEY}-flow`,
      title: "May I ship it?",
      content: "the plan",
      metadata: { source: "session", pane: "w1:p1", socket: "/tmp/herdr.sock", session: randomUUID() },
    });
    expect(requested.status, requested.body).toBe(200);
    const filed = (requested.json as unknown as { result: { data: { id: string; session: string | null } } }).result.data;
    expect(filed.session).toBe(id);
    const stored = await metadataOf(filed.id);
    expect(stored).toMatchObject({ session: id });
    expect(stored).not.toHaveProperty("pane");

    const decided = await trpc(tokens[PHONE]!, "inboxDecision", { id: filed.id, decision: "changes", message: "say why first" });
    expect(decided.status, decided.body).toBe(200);
    expect((decided.json as unknown as { result: { data: { notified: unknown } } }).result.data.notified).toEqual({ ok: true, session: id });

    const read = await send("/hangar/v1/messages", { token });
    expect(read.json["messages"]).toEqual([
      {
        id: expect.any(Number),
        kind: "inbox_decision",
        body: { item_id: filed.id, title: "May I ship it?", decision: "changes", outcome: "changes", message: "say why first", text: expect.stringContaining("say why first") },
        created_at: expect.any(String),
      },
    ]);
  });
});
