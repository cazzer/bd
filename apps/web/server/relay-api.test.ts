// The relay REST API over real HTTP (laptop-relay spec: the relay claims and
// reports actions, the board stays live from the relay; docs/relay.md): the
// production dispatcher and handler, real tokens from the store, and a
// tailnet Host, since admission trusts a loopback request without reading
// its token (dispatch.test.ts's header).
//
// The database is shared with live data. Every claim goes through the
// `claimAmong` seam, set per test to this file's own fixtures, so no claim
// can take a real queued action. Fixtures are `beads_reingest` actions on
// project keys and bead ids unique to this run; tokens, check-ins, actions,
// nodes, and runs are this file's own and deleted by name, id, or prefix.
// Nothing asserts on a table as a whole.

import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  applyBeadsIngest,
  claimSession,
  createClientToken,
  enqueueRelayAction,
  fileHangarDecision,
  getRelayAction,
  markHangarDecisionEscalated,
  openIngestRun,
  readHangarMessages,
  requestSession,
  updateSession,
  upsertNodes,
  verifyClientToken,
  type BeadsIssue,
} from "@breakdown/core";
import { clientTokens, createDb, createPool, hangarDecisions, hangarMessages, ingestRuns, nodes, relayActions, relayCheckIns, resolveDatabaseUrl, type Database } from "@breakdown/db";
import { and, eq, inArray, like, or } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BEADS_WATCHER_EVENT, createBeadsWatcher, type BeadsWatcher, type BeadsWatcherEvent } from "./beads-watcher.js";
import { createRequestDispatcher } from "./dispatch.js";
import { MAX_CONCURRENT_RELAY_LONG_POLLS, MAX_RELAY_BODY_BYTES, MAX_RELAY_PUSH_BYTES, createRelayHandler, RELAY_CLAIMER_GONE_REASON, RELAY_ENDPOINTS } from "./relay-api.js";

const TAILNET = "breakdown.tail.example";
const suffix = randomUUID().slice(0, 8);
const PREFIX = `test-rapi-${suffix}`;
const RELAY_A = `${PREFIX}-relay-a`;
const RELAY_B = `${PREFIX}-relay-b`;
const WORKER = `${PREFIX}-worker`;
const HANGAR = `${PREFIX}-hangar`;
const PHONE = `${PREFIX}-phone`;
/** Bead ids: a lowercase prefix, a hyphen, a suffix (RELAY_ISSUE_ID_PATTERN). */
const BEAD = `ra${suffix}`;
const PROJECT = `${PREFIX}-main`;
const OTHER_PROJECT = `${PREFIX}-other`;
const UNREGISTERED = `${PREFIX}-nowhere`;
const SCRATCH = mkdtempSync(path.join(tmpdir(), "relay-api-test-"));
const CHECKOUT = realpathSync(SCRATCH);

let pool: ReturnType<typeof createPool>;
let db: Database;
let watcher: BeadsWatcher;
const events: BeadsWatcherEvent[] = [];
const servers: Server[] = [];
/** Hangar sessions and work items a test made, for cleanup. */
const escalationSessions: string[] = [];
const fixtureNodeIds: string[] = [];
let port: number;
let readOnlyPort: number;
const tokens: Record<string, string> = {};
const actionIds: number[] = [];
const runIds: string[] = [];
/** The actions a claim may take right now (the `claimAmong` seam). */
let among: number[] = [];
/** Runs once at the start of the next claim attempt. */
let onClaimAttempt: (() => void) | null = null;
let lastRequestSocket: Socket | null = null;
let fixtureKey = 0;

async function listen(readOnly: boolean): Promise<number> {
  let dispatch: ReturnType<typeof createRequestDispatcher> | null = null;
  const server = createServer((req, res) => {
    lastRequestSocket = req.socket;
    void dispatch!(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const p = (server.address() as AddressInfo).port;
  const refuse = async (_req: unknown, res: { writeHead(s: number): { end(): void } }) => void res.writeHead(500).end();
  dispatch = createRequestDispatcher({
    port: p,
    allowedHosts: [TAILNET],
    verifyToken: (token) => verifyClientToken(db, token),
    connect: refuse,
    health: refuse,
    reviewImages: refuse,
    reviewUploads: refuse,
    hangar: async (_req, res) => void res.writeHead(500).end(),
    relay: createRelayHandler({
      db,
      readOnly,
      watcher,
      missingBinaries: ["bd"],
      claimAmong: () => {
        const hook = onClaimAttempt;
        onClaimAttempt = null;
        hook?.();
        return among;
      },
    }),
    trpc: (_req, res) => void res.writeHead(500).end(),
  });
  return p;
}

function issue(n: number, overrides: Partial<BeadsIssue> = {}): BeadsIssue {
  return { id: `${BEAD}-${n}`, title: `Pushed ${n}`, status: "open", priority: 2, issue_type: "task", created_at: "2026-09-01T10:00:00Z", ...overrides };
}

beforeAll(async () => {
  pool = createPool(resolveDatabaseUrl());
  db = createDb(pool);
  watcher = createBeadsWatcher({ bdAvailable: false, log: () => {} });
  watcher.events.on(BEADS_WATCHER_EVENT, (e: BeadsWatcherEvent) => events.push(e));
  for (const [client, scope] of [[RELAY_A, "relay"], [RELAY_B, "relay"], [WORKER, "agent"], [HANGAR, "hangar"], [PHONE, "human"]] as const) {
    tokens[client] = (await createClientToken(db, client, scope)).token;
  }
  // Registered the way a local beads ingest registers: a `beads` run under the default actor.
  const main = await applyBeadsIngest(db, { project: PROJECT, path: CHECKOUT, issues: [issue(1)], comments: {} });
  const other = await applyBeadsIngest(db, { project: OTHER_PROJECT, path: path.join(CHECKOUT, "other"), issues: [issue(900)], comments: {} });
  runIds.push(main.ingestRunId, other.ingestRunId);
  port = await listen(false);
  readOnlyPort = await listen(true);
});

afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  await db.delete(clientTokens).where(inArray(clientTokens.client, [RELAY_A, RELAY_B, WORKER, HANGAR, PHONE, ...escalationSessions.map((id) => `session-${id}`)]));
  if (escalationSessions.length > 0) {
    await db.delete(hangarDecisions).where(inArray(hangarDecisions.sessionId, escalationSessions));
    await db.delete(hangarMessages).where(inArray(hangarMessages.sessionId, escalationSessions));
  }
  if (fixtureNodeIds.length > 0) await db.delete(nodes).where(inArray(nodes.id, fixtureNodeIds));
  await db.delete(ingestRuns).where(inArray(ingestRuns.actor, [PREFIX, HANGAR]));
  if (actionIds.length > 0) await db.delete(relayActions).where(inArray(relayActions.id, actionIds));
  await db.delete(relayCheckIns).where(inArray(relayCheckIns.relay, [RELAY_A, RELAY_B]));
  await db.delete(nodes).where(and(eq(nodes.sourceSystem, "beads"), or(like(nodes.externalId, `${BEAD}-%`), like(nodes.externalId, `project:${PREFIX}-%`))));
  await db.delete(ingestRuns).where(or(inArray(ingestRuns.id, runIds), inArray(ingestRuns.actor, [RELAY_A, RELAY_B])));
  await pool.end();
  rmSync(SCRATCH, { recursive: true, force: true });
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
  raw?: Buffer | string;
  contentType?: string | null;
  headers?: Record<string, string>;
  host?: string;
  port?: number;
  abortAfterMs?: number;
}

function send(urlPath: string, options: SendOptions = {}): Promise<Sent> {
  const p = options.port ?? port;
  const headers: Record<string, string> = { Host: options.host ?? `${TAILNET}:${p}`, ...options.headers };
  if (options.token !== null && options.token !== undefined) headers["Authorization"] = `Bearer ${options.token}`;
  const payload = options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
  if (payload !== undefined && options.contentType !== null) headers["Content-Type"] = options.contentType ?? "application/json";
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: p, path: urlPath, method: options.method ?? (payload === undefined ? "GET" : "POST"), headers }, (res) => {
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
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A queued re-ingest on a project key of its own. Not claimable until a test lets it be. */
async function queued(): Promise<number> {
  fixtureKey += 1;
  const { action } = await enqueueRelayAction(db, { kind: "beads_reingest", payload: { project_key: `${PREFIX}-q${fixtureKey}` }, requestedBy: PHONE });
  actionIds.push(action.id);
  return action.id;
}

async function claim(id: number, relay = RELAY_A): Promise<Record<string, unknown>> {
  among = [id];
  const sent = await send("/relay/v1/claim", { token: tokens[relay], body: { kinds: ["beads_reingest"] } });
  among = [];
  expect(sent.status, sent.body).toBe(200);
  return sent.json["action"] as Record<string, unknown>;
}

function push(body: Record<string, unknown>, token = tokens[RELAY_A]): Promise<Sent> {
  return send("/relay/v1/beads-ingest", { token, body: { project_key: PROJECT, path: CHECKOUT, comments: {}, ...body } });
}

// --- Endpoints -----------------------------------------------------------------------------------

describe("POST /relay/v1/check-in", () => {
  it("records the relay's version and answers the interval and the server's clock", async () => {
    const sent = await send("/relay/v1/check-in", { token: tokens[RELAY_A], body: { version: "0.1.0", extra: true } });
    expect(sent.status, sent.body).toBe(200);
    expect(sent.json).toEqual({ interval_s: 30, now: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) });
    const [row] = await db.select().from(relayCheckIns).where(eq(relayCheckIns.relay, RELAY_A));
    expect(row!.version).toBe("0.1.0");
  });

  it("refuses a missing or blank version with invalid_request naming it", async () => {
    for (const body of [{}, { version: "  " }, { version: 3 }]) {
      const sent = await send("/relay/v1/check-in", { token: tokens[RELAY_A], body });
      expect(sent.status).toBe(400);
      expect(errorCode(sent)).toBe("invalid_request");
      expect(sent.json.error?.message).toContain("version");
    }
  });
});

describe("POST /relay/v1/claim", () => {
  it("takes a queued action with its payload, then finds none", async () => {
    const id = await queued();
    const action = await claim(id);
    expect(action).toEqual({ id, kind: "beads_reingest", payload: { project_key: `${PREFIX}-q${fixtureKey}` }, created_at: expect.any(String), attempts: 1 });
    expect((await getRelayAction(db, id))).toMatchObject({ state: "claimed", claimedBy: RELAY_A });
    among = [id];
    const again = await send("/relay/v1/claim", { token: tokens[RELAY_A], body: {} });
    among = [];
    expect(again.json).toEqual({ action: null });
  });

  it("takes only the kinds named", async () => {
    const id = await queued();
    among = [id];
    const sent = await send("/relay/v1/claim", { token: tokens[RELAY_A], body: { kinds: ["herdr_prompt"] } });
    among = [];
    expect(sent.json).toEqual({ action: null });
    expect((await getRelayAction(db, id))!.state).toBe("queued");
  });

  it("takes only the projects named: a relay narrowed to one project never claims another's actions", async () => {
    const id = await queued();
    const key = `${PREFIX}-q${fixtureKey}`;
    among = [id];
    const other = await send("/relay/v1/claim", { token: tokens[RELAY_A], body: { projects: [`${PREFIX}-elsewhere`] } });
    expect(other.json).toEqual({ action: null });
    expect((await getRelayAction(db, id))!.state).toBe("queued");
    const mine = await send("/relay/v1/claim", { token: tokens[RELAY_A], body: { projects: [`${PREFIX}-elsewhere`, key] } });
    among = [];
    expect((mine.json["action"] as { id: number }).id).toBe(id);
  });

  it("refuses an agent token with 403 and changes nothing", async () => {
    const id = await queued();
    among = [id];
    const sent = await send("/relay/v1/claim", { token: tokens[WORKER], body: {} });
    among = [];
    expect(sent.status).toBe(403);
    expect(errorCode(sent)).toBe("forbidden");
    expect(await getRelayAction(db, id)).toMatchObject({ state: "queued", attempts: 0, claimedBy: null });
  });

  it("refuses bad bodies with invalid_request", async () => {
    for (const body of [{ wait_s: 31 }, { wait_s: -1 }, { wait_s: 1.5 }, { kinds: [] }, { kinds: ["bd_delete"] }, { kinds: ["herdr_prompt", "herdr_prompt"] }, { projects: ["../etc"] }, { projects: "bd" }]) {
      const sent = await send("/relay/v1/claim", { token: tokens[RELAY_A], body });
      expect(sent.status, JSON.stringify(body)).toBe(400);
      expect(errorCode(sent)).toBe("invalid_request");
    }
  });
});

describe("POST /relay/v1/actions/:id/result", () => {
  it("finishes a claimed action, and a repeated report is a no-op saying so", async () => {
    const id = await queued();
    await claim(id);
    const done = await send(`/relay/v1/actions/${id}/result`, { token: tokens[RELAY_A], body: { state: "done", result: { note: "already applied" } } });
    expect(done.status, done.body).toBe(200);
    expect(done.json).toEqual({ action: { id, state: "done" }, already_finished: false });
    expect(await getRelayAction(db, id)).toMatchObject({ state: "done", result: { note: "already applied" } });
    const repeated = await send(`/relay/v1/actions/${id}/result`, { token: tokens[RELAY_A], body: { state: "failed", error: "late" } });
    expect(repeated.json).toEqual({ action: { id, state: "done" }, already_finished: true });
  });

  it("a person's review decision on a hangar escalation reaches the session once the relay reports it done", async () => {
    const run = await openIngestRun(db, `relay-api-test-${suffix}`, { actor: PREFIX });
    runIds.push(run.id);
    const item = (await upsertNodes(db, run, [{ nodeType: "work_item", sourceSystem: `relay-api-test-${suffix}`, externalId: randomUUID(), title: "Escalated work", metadata: { status: "open" } }])).rows[0]!.id;
    fixtureNodeIds.push(item);
    const { session } = await requestSession(db, { repo: "cazzer/bd", workItemId: item, flavor: "headless", actor: PREFIX, requestedAt: new Date(Date.UTC(2999, 0, 1)) });
    fixtureNodeIds.push(session.id);
    escalationSessions.push(session.id);
    if ((await claimSession(db, { hangar: HANGAR, flavors: ["headless"], among: [session.id] })) === null) throw new Error("fixture claim failed");
    await updateSession(db, { hangar: HANGAR, id: session.id, state: "running" });
    const decision = await fileHangarDecision(db, { sessionId: session.id, kind: "question", title: "Which store?", card: { question: "Postgres or SQLite?" } });
    await markHangarDecisionEscalated(db, { id: decision.id, escalation: { via: "review", project_key: PROJECT, issue_id: `${BEAD}-w1`, review_key: "hangar-x", relay_action_id: 0, review_id: `${BEAD}-r1` } });

    const { action } = await enqueueRelayAction(db, { kind: "review_decision", payload: { project_key: PROJECT, cwd: CHECKOUT, issue_id: `${BEAD}-r1`, decision: "changes", message: "Keep Postgres." }, requestedBy: PHONE });
    actionIds.push(action.id);
    among = [action.id];
    const claimed = await send("/relay/v1/claim", { token: tokens[RELAY_A], body: { kinds: ["review_decision"] } });
    among = [];
    expect(claimed.status, claimed.body).toBe(200);
    expect((await readHangarMessages(db, { sessionId: session.id })).messages).toEqual([]);
    const done = await send(`/relay/v1/actions/${action.id}/result`, { token: tokens[RELAY_A], body: { state: "done", result: {} } });
    expect(done.status, done.body).toBe(200);
    const { messages } = await readHangarMessages(db, { sessionId: session.id });
    expect(messages.map((m) => [m.kind, m.body["item_id"], m.body["decision"], m.body["message"], m.body["by"], m.body["via"]])).toEqual([["session_decision", decision.id, "changes", "Keep Postgres.", PHONE, "review"]]);
  });

  it("refuses another relay's action with 409 not_claimer, an unknown or malformed id with 404, and a failure without an error with 400", async () => {
    const id = await queued();
    await claim(id, RELAY_B);
    const theirs = await send(`/relay/v1/actions/${id}/result`, { token: tokens[RELAY_A], body: { state: "done" } });
    expect(theirs.status).toBe(409);
    expect(errorCode(theirs)).toBe("not_claimer");
    expect((await getRelayAction(db, id))!.state).toBe("claimed");

    const unknown = await send("/relay/v1/actions/999999999999999999/result", { token: tokens[RELAY_A], body: { state: "done" } });
    expect(unknown.status).toBe(404);
    expect(errorCode(unknown)).toBe("not_found");
    for (const bad of ["abc", "0", "1234567890123456789", "-1"]) {
      const sent = await send(`/relay/v1/actions/${bad}/result`, { token: tokens[RELAY_A], body: { state: "done" } });
      expect(sent.status, bad).toBe(404);
    }
    const noError = await send(`/relay/v1/actions/${id}/result`, { token: tokens[RELAY_B], body: { state: "failed" } });
    expect(noError.status).toBe(400);
    expect(errorCode(noError)).toBe("invalid_request");
  });
});

describe("POST /relay/v1/beads-ingest", () => {
  it("applies a push attributed to the relay client, emits the watcher's changed event, and a re-push is unchanged and silent", async () => {
    const before = events.length;
    const issues = [issue(1), issue(2, { labels: ["review"], comment_count: 1 }), issue(3, { dependencies: [{ issue_id: `${BEAD}-3`, depends_on_id: `${BEAD}-1`, type: "blocks" }] })];
    const comments = { [`${BEAD}-2`]: [{ id: 1, author: "caleb", text: "pushed thread", created_at: "2026-09-02T10:00:00Z" }] };
    const sent = await push({ issues, comments });
    expect(sent.status, sent.body).toBe(200);
    expect(sent.json).toMatchObject({ project: PROJECT, nodes: { created: 2, updated: 0, unchanged: 2 }, edges: { created: 1 }, edges_deleted: 0, changed: true });
    const changedIds = sent.json["changed_node_ids"] as string[];
    expect(changedIds).toHaveLength(2);

    const runs = await db.select().from(ingestRuns).where(eq(ingestRuns.actor, RELAY_A));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ sourceSystem: "beads" });
    const [reviewed] = await db.select().from(nodes).where(and(eq(nodes.sourceSystem, "beads"), eq(nodes.externalId, `${BEAD}-2`)));
    expect(reviewed!.metadata).toMatchObject({ project: PROJECT, review_comments: [{ text: "pushed thread" }] });
    const [registry] = await db.select().from(nodes).where(and(eq(nodes.sourceSystem, "beads"), eq(nodes.externalId, `project:${PROJECT}`)));
    expect(registry!.metadata).toEqual({ project: PROJECT, path: CHECKOUT });
    expect(events.slice(before)).toEqual([{ kind: "changed", project: PROJECT, changedNodeIds: changedIds, at: expect.any(String) }]);

    const again = await push({ issues, comments });
    expect(again.json).toMatchObject({ nodes: { created: 0, updated: 0, unchanged: 4 }, changed: false, changed_node_ids: [] });
    expect(events.slice(before)).toHaveLength(1);
  });

  it("refuses an unregistered project with 404 and another path with 409, writing nothing", async () => {
    const unregistered = await push({ project_key: UNREGISTERED, issues: [issue(50)] });
    expect(unregistered.status).toBe(404);
    expect(errorCode(unregistered)).toBe("not_registered");
    const elsewhere = await push({ path: path.join(CHECKOUT, "elsewhere"), issues: [issue(50)] });
    expect(elsewhere.status).toBe(409);
    expect(errorCode(elsewhere)).toBe("path_mismatch");
    expect(await db.select().from(nodes).where(and(eq(nodes.sourceSystem, "beads"), eq(nodes.externalId, `${BEAD}-50`)))).toEqual([]);
  });

  it("refuses an issue another project owns with 409 project_conflict and reports the failure to the board", async () => {
    const before = events.length;
    const sent = await push({ issues: [issue(900)] });
    expect(sent.status).toBe(409);
    expect(errorCode(sent)).toBe("project_conflict");
    expect(events.slice(before)).toEqual([{ kind: "error", project: PROJECT, message: expect.stringContaining(`${BEAD}-900`), at: expect.any(String) }]);
    const [owned] = await db.select().from(nodes).where(and(eq(nodes.sourceSystem, "beads"), eq(nodes.externalId, `${BEAD}-900`)));
    expect(owned!.metadata).toMatchObject({ project: OTHER_PROJECT });
  });

  it("refuses bodies outside the contract with invalid_request", async () => {
    const bad: Record<string, unknown>[] = [
      { issues: [] },
      { issues: [{ id: "Not An Id", title: "t", status: "open" }] },
      { issues: [{ id: `${BEAD}-1`, status: "open" }] },
      { issues: [issue(1)], comments: { "Not An Id": [] } },
      { issues: [issue(1)], comments: { [`${BEAD}-1`]: Array.from({ length: 1001 }, () => ({ text: "x" })) } },
      { issues: [issue(1)], path: "relative/path" },
      { issues: [issue(1)], project_key: "Not A Key" },
      { issues: [issue(1, { created_at: "not a time" })] },
    ];
    for (const body of bad) {
      const sent = await push(body);
      expect(sent.status, JSON.stringify(body).slice(0, 120)).toBe(400);
      expect(errorCode(sent)).toBe("invalid_request");
    }
  });

  it("takes a push past 64 KiB and refuses one past 8 MiB", async () => {
    const large = await push({ issues: [issue(1), issue(4, { description: "x".repeat(MAX_RELAY_BODY_BYTES * 2) })] });
    expect(large.status, large.body.slice(0, 200)).toBe(200);
    const huge = JSON.stringify({ project_key: PROJECT, path: CHECKOUT, comments: {}, issues: [issue(1, { description: "x".repeat(MAX_RELAY_PUSH_BYTES) })] });
    const declared = await send("/relay/v1/beads-ingest", { token: tokens[RELAY_A], raw: huge });
    expect(declared.status).toBe(413);
    expect(errorCode(declared)).toBe("too_large");
    const streamed = await send("/relay/v1/beads-ingest", { token: tokens[RELAY_A], raw: huge, headers: { "Transfer-Encoding": "chunked" } });
    expect(streamed.status).toBe(413);
  });
});

describe("GET /relay/v1/projects", () => {
  it("lists the beads-registered projects with their paths, and says the relay must push", async () => {
    const sent = await send("/relay/v1/projects", { token: tokens[RELAY_A] });
    expect(sent.status).toBe(200);
    expect(sent.json["push"]).toBe(true);
    const projects = sent.json["projects"] as Array<{ key: string; path: string }>;
    expect(projects).toEqual(expect.arrayContaining([{ key: PROJECT, path: CHECKOUT }, { key: OTHER_PROJECT, path: path.join(CHECKOUT, "other") }]));
  });
});

// --- Scopes and refusals ---------------------------------------------------------------------------

describe("scopes", () => {
  const concrete = (p: string): string => p.replace(":id", "1");

  it("refuses an agent, hangar, or human token on every endpoint with a JSON 403", async () => {
    for (const { method, path: p } of RELAY_ENDPOINTS) {
      for (const client of [WORKER, HANGAR, PHONE]) {
        const sent = await send(concrete(p), { method, token: tokens[client], ...(method === "GET" ? {} : { body: {} }) });
        expect(sent.status, `${client} ${method} ${p}`).toBe(403);
        expect(errorCode(sent)).toBe("forbidden");
      }
    }
  });

  it("refuses a tokenless loopback request (the local person) on every endpoint, even carrying a relay token", async () => {
    for (const { method, path: p } of RELAY_ENDPOINTS) {
      for (const token of [null, tokens[RELAY_A]]) {
        const sent = await send(concrete(p), { method, token, host: `127.0.0.1:${port}`, ...(method === "GET" ? {} : { body: {} }) });
        expect(sent.status, `${method} ${p}`).toBe(403);
        expect(sent.json.error).toEqual({
          code: "forbidden",
          message: "Requests over loopback are treated as the local person; reach this API through the tailnet host or a proxy that sets X-Forwarded-For (docs/relay.md).",
        });
      }
    }
  });

  it("refuses every POST on a read-only server and still answers the GET", async () => {
    const id = await queued();
    among = [id];
    for (const { method, path: p } of RELAY_ENDPOINTS.filter((e) => e.method === "POST")) {
      const sent = await send(concrete(p), { port: readOnlyPort, token: tokens[RELAY_A], body: { version: "1", state: "done" } });
      expect(sent.status, p).toBe(403);
      expect(errorCode(sent), `${method} ${p}`).toBe("read_only");
    }
    among = [];
    expect((await getRelayAction(db, id))!.state).toBe("queued");
    expect((await send("/relay/v1/projects", { port: readOnlyPort, token: tokens[RELAY_A] })).status).toBe(200);
  });

  it("answers 404 for an unknown path or a trailing slash, and 405 with Allow for the wrong method", async () => {
    for (const p of ["/relay/v1/nope", "/relay/v1/claim/", "/relay/v1/actions/1"]) {
      const sent = await send(p, { token: tokens[RELAY_A], body: {} });
      expect(sent.status, p).toBe(404);
      expect(errorCode(sent)).toBe("not_found");
    }
    const getClaim = await send("/relay/v1/claim", { token: tokens[RELAY_A] });
    expect(getClaim.status).toBe(405);
    expect(getClaim.headers["allow"]).toBe("POST");
    expect((await send("/relay/v1/projects", { token: tokens[RELAY_A], body: {} })).headers["allow"]).toBe("GET");
  });

  it("caps every other body at 64 KiB and wants application/json", async () => {
    const big = await send("/relay/v1/check-in", { token: tokens[RELAY_A], raw: JSON.stringify({ version: "x".repeat(MAX_RELAY_BODY_BYTES) }) });
    expect(big.status).toBe(413);
    const text = await send("/relay/v1/check-in", { token: tokens[RELAY_A], raw: '{"version":"1"}', contentType: "text/plain" });
    expect(text.status).toBe(415);
    const badJson = await send("/relay/v1/check-in", { token: tokens[RELAY_A], raw: "{version:" });
    expect(errorCode(badJson)).toBe("invalid_json");
  });
});

// --- Long-poll ---------------------------------------------------------------------------------------

describe("long-poll", () => {
  it("a claim waiting 5 s answers within about 2 s of an enqueue", async () => {
    among = [];
    const pending = send("/relay/v1/claim", { token: tokens[RELAY_A], body: { wait_s: 5 } });
    await sleep(1200);
    const id = await queued();
    among = [id];
    const enqueuedAt = Date.now();
    const sent = await pending;
    among = [];
    expect(sent.status, sent.body).toBe(200);
    expect(sent.json["action"]).toMatchObject({ id, kind: "beads_reingest" });
    expect(Date.now() - enqueuedAt).toBeLessThan(2000);
  });

  it("an empty wait answers at its bound", async () => {
    among = [];
    const started = Date.now();
    const sent = await send("/relay/v1/claim", { token: tokens[RELAY_A], body: { wait_s: 1 } });
    expect(sent.json).toEqual({ action: null });
    expect(Date.now() - started).toBeGreaterThanOrEqual(950);
  });

  it("requeues a claim that commits after its caller's connection closed", async () => {
    const id = await queued();
    among = [id];
    onClaimAttempt = () => lastRequestSocket?.destroy();
    await expect(send("/relay/v1/claim", { token: tokens[RELAY_A], body: {} })).rejects.toThrow();
    among = [];
    let action = await getRelayAction(db, id);
    for (let tries = 0; tries < 30 && action?.error !== RELAY_CLAIMER_GONE_REASON; tries += 1) {
      await sleep(100);
      action = await getRelayAction(db, id);
    }
    expect(action).toMatchObject({ state: "queued", claimedBy: null, attempts: 0, error: RELAY_CLAIMER_GONE_REASON });
  });

  it("stops when the client goes away: an action enqueued after the disconnect is not claimed", async () => {
    among = [];
    const gone = send("/relay/v1/claim", { token: tokens[RELAY_A], body: { wait_s: 5 }, abortAfterMs: 300 });
    await expect(gone).rejects.toThrow();
    const id = await queued();
    among = [id];
    await sleep(2500);
    among = [];
    expect((await getRelayAction(db, id))!.state).toBe("queued");
  });

  it(`refuses a client's ${MAX_CONCURRENT_RELAY_LONG_POLLS + 1}th open claim with 429 too_many_waiters, Retry-After 1`, async () => {
    among = [];
    const waitClaim = (): Promise<Sent> => send("/relay/v1/claim", { token: tokens[RELAY_B], body: { wait_s: 5 }, abortAfterMs: 1500 });
    const held = Array.from({ length: MAX_CONCURRENT_RELAY_LONG_POLLS }, waitClaim);
    await sleep(400);
    const refused = await send("/relay/v1/claim", { token: tokens[RELAY_B], body: { wait_s: 5 } });
    expect(refused.status).toBe(429);
    expect(errorCode(refused)).toBe("too_many_waiters");
    expect(refused.headers["retry-after"]).toBe("1");
    expect((await send("/relay/v1/claim", { token: tokens[RELAY_B], body: { wait_s: 0 } })).json).toEqual({ action: null });
    expect((await send("/relay/v1/claim", { token: tokens[RELAY_A], body: { wait_s: 1 } })).status).toBe(200);
    await Promise.allSettled(held);
    await sleep(200);
    expect((await send("/relay/v1/claim", { token: tokens[RELAY_B], body: { wait_s: 1 } })).status).toBe(200);
  });
});
