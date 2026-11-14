// The hangar tools through the real MCP protocol (brain-mcp spec, "Hangar
// tools"; hangar-queue design decision 7): brain_hangar_request queues a
// session and answers hangar's status, brain_hangar_status counts,
// brain_hangar_sessions lists bounded, read-only mode refuses the request
// tool, and brain_write refuses hangar sessions outright.
//
// The database is shared with live data and with suites that check hangar
// in and queue sessions in parallel, so nothing here asserts on a global
// count or on which liveness state hangar is in: fixtures are this file's
// own work items, sessions are found by those work items, and cleanup is by
// id and by this file's actors. A session queued through the tool has no
// test seam for its request time, so `request` moves it to 2999 straight
// after: a real hangar claiming oldest first then reaches it last.

import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { closeIngestRun, listSessions, openIngestRun, upsertNodes, type HangarStatus, type IngestRunHandle } from "@breakdown/core";
import { createDb, createPool, ingestRuns, nodes, resolveDatabaseUrl, type Database } from "@breakdown/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type CreateServerOptions } from "./server.js";
import { hangarStatusText } from "./tools/hangar.js";

const SUFFIX = randomUUID().replace(/-/g, "");
const FIXTURE_SOURCE = `mcp-hangar-test-${SUFFIX}`;
const CLIENT = { name: "hangar-tools-test", version: `0.0.0+${SUFFIX}` };
const ACTOR = `${CLIENT.name} ${CLIENT.version}`;
const STATUS_TEXT = /^hangar (online|offline since \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z|has never checked in)$/;

let pool: ReturnType<typeof createPool>;
let db: Database;
let fixtureRun: IngestRunHandle;
const sessionIds: string[] = [];

beforeAll(async () => {
  pool = createPool(resolveDatabaseUrl());
  db = createDb(pool);
  fixtureRun = await openIngestRun(db, FIXTURE_SOURCE, { actor: ACTOR });
});

afterAll(async () => {
  if (sessionIds.length > 0) await db.delete(nodes).where(inArray(nodes.id, sessionIds));
  await db.delete(nodes).where(eq(nodes.sourceSystem, FIXTURE_SOURCE));
  await closeIngestRun(db, fixtureRun);
  await db.delete(ingestRuns).where(eq(ingestRuns.actor, ACTOR));
  await pool.end();
});

async function connect(opts?: CreateServerOptions): Promise<Client> {
  const server = createServer(db, opts);
  const client = new Client(CLIENT);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function textOf(raw: any): string {
  const first = raw.content?.[0];
  if (!first || first.type !== "text") throw new Error(`expected text content, got ${JSON.stringify(raw.content)}`);
  return first.text as string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const raw = await client.callTool({ name, arguments: args });
  if (raw.isError) throw new Error(`${name} failed: ${textOf(raw)}`);
  return JSON.parse(textOf(raw));
}

async function workItem(title: string, nodeType = "work_item"): Promise<string> {
  const result = await upsertNodes(db, fixtureRun, [{ nodeType, sourceSystem: FIXTURE_SOURCE, externalId: randomUUID(), title, metadata: nodeType === "work_item" ? { status: "open" } : {} }]);
  return result.rows[0]!.id;
}

async function request(client: Client, workItemId: string, flavor = "headless"): Promise<{ sessionId: string; state: string; hangar: { status: string; lastSeenAt: string | null; text: string } }> {
  const result = await call(client, "brain_hangar_request", { repo: "cazzer/bd", workItemId, flavor });
  sessionIds.push(result.sessionId);
  await db.execute(sql`UPDATE nodes SET metadata = metadata || '{"occurred_at": "2999-01-01T00:00:00.000Z"}'::jsonb WHERE id = ${result.sessionId}::uuid`);
  return result;
}

describe("brain_hangar_request", () => {
  it("queues a session for the work item, recorded as requested by this client, and answers hangar's status", async () => {
    const client = await connect();
    const item = await workItem("Hangar request fixture");
    const result = await request(client, item, "display-browser");

    expect(result.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.state).toBe("queued");
    expect(["online", "offline", "never"]).toContain(result.hangar.status);
    expect(result.hangar.text).toMatch(STATUS_TEXT);
    expect(result.hangar.lastSeenAt === null).toBe(result.hangar.status === "never");
    expect(Object.keys(result).sort()).toEqual(["hangar", "sessionId", "state"]);

    const { sessions } = await listSessions(db, { workItemId: item });
    expect(sessions.map((s) => s.id)).toEqual([result.sessionId]);
    expect(sessions[0]).toMatchObject({ state: "queued", flavor: "display-browser", repo: "cazzer/bd", workItemId: item, requestedBy: ACTOR, claimedBy: null });
  });

  it("refuses a node that is not a work item, a bad flavor, and a malformed id, queueing nothing", async () => {
    const client = await connect();
    const doc = await workItem("Not a work item", "doc");
    const notWorkItem = await client.callTool({ name: "brain_hangar_request", arguments: { repo: "cazzer/bd", workItemId: doc, flavor: "headless" } });
    expect(notWorkItem.isError).toBe(true);
    expect(textOf(notWorkItem)).toMatch(/not a work item/);
    expect(textOf(notWorkItem)).toMatch(/nothing was queued/i);

    const item = await workItem("Bad flavor fixture");
    const badFlavor = await client.callTool({ name: "brain_hangar_request", arguments: { repo: "cazzer/bd", workItemId: item, flavor: "gpu" } });
    expect(badFlavor.isError).toBe(true);
    expect(textOf(badFlavor)).toMatch(/flavor/);
    const badId = await client.callTool({ name: "brain_hangar_request", arguments: { repo: "cazzer/bd", workItemId: "W", flavor: "headless" } });
    expect(badId.isError).toBe(true);
    expect(textOf(badId)).toMatch(/workItemId/);

    expect((await listSessions(db, { workItemId: item })).sessions).toEqual([]);
  });

  it("is not advertised in read-only mode, and is refused when called anyway, queueing nothing", async () => {
    const client = await connect({ readOnly: true });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("brain_hangar_request");
    expect(names).toEqual(expect.arrayContaining(["brain_hangar_status", "brain_hangar_sessions"]));

    const item = await workItem("Read-only fixture");
    const raw = await client.callTool({ name: "brain_hangar_request", arguments: { repo: "cazzer/bd", workItemId: item, flavor: "headless" } });
    expect(raw.isError).toBe(true);
    expect(textOf(raw)).toMatch(/read-only/i);
    expect((await listSessions(db, { workItemId: item })).sessions).toEqual([]);

    const status = await call(client, "brain_hangar_status", {});
    expect(status.text).toMatch(STATUS_TEXT);
  });
});

describe("brain_hangar_status", () => {
  it("reports liveness, the last hangar's name and version, and the open session counts", async () => {
    const client = await connect();
    await request(client, await workItem("Status fixture"));
    const status = await call(client, "brain_hangar_status", {});
    expect(Object.keys(status).sort()).toEqual(["claimed", "hangar", "lastSeenAt", "queued", "running", "status", "text", "version"]);
    expect(["online", "offline", "never"]).toContain(status.status);
    expect(status.text).toMatch(STATUS_TEXT);
    for (const key of ["queued", "claimed", "running"]) expect(Number.isInteger(status[key])).toBe(true);
    // Our own session is queued; other suites may add or remove theirs.
    expect(status.queued).toBeGreaterThanOrEqual(1);
  });

  it("words each liveness state as the person reads it", () => {
    const base = { hangar: "h", version: "1", intervalS: 30, now: new Date(), counts: { queued: 0, claimed: 0, running: 0 } };
    const at = new Date("2026-11-14T09:00:00.000Z");
    expect(hangarStatusText({ ...base, state: "online", lastSeenAt: at } as HangarStatus)).toBe("hangar online");
    expect(hangarStatusText({ ...base, state: "offline", lastSeenAt: at } as HangarStatus)).toBe("hangar offline since 2026-11-14T09:00:00.000Z");
    expect(hangarStatusText({ ...base, hangar: null, version: null, state: "never", lastSeenAt: null } as HangarStatus)).toBe("hangar has never checked in");
  });
});

describe("brain_hangar_sessions", () => {
  it("filters by work item and state, honors limit with hasMore, and bounds the response with droppedSessionIds", async () => {
    const client = await connect();
    const item = await workItem("Sessions fixture");
    const ids: string[] = [];
    for (const flavor of ["headless", "display-godot", "display-browser"]) ids.push((await request(client, item, flavor)).sessionId);

    const all = await call(client, "brain_hangar_sessions", { workItemId: item });
    expect(all.sessions.map((s: { id: string }) => s.id).sort()).toEqual([...ids].sort());
    expect(all).toMatchObject({ hasMore: false, truncated: false, droppedSessionIds: [] });
    expect(all.sessions[0]).toMatchObject({ state: "queued", repo: "cazzer/bd", workItemId: item, requestedBy: ACTOR, requeueReason: null, failureReason: null });
    expect(JSON.stringify(all)).not.toMatch(/bdt_|token/i);

    const limited = await call(client, "brain_hangar_sessions", { workItemId: item, limit: 2 });
    expect(limited.sessions).toHaveLength(2);
    expect(limited).toMatchObject({ hasMore: true, truncated: true });

    const none = await call(client, "brain_hangar_sessions", { workItemId: item, states: ["running", "stopped"] });
    expect(none.sessions).toEqual([]);

    const small = await connect({ responseCharBudget: 900 });
    const bounded = await call(small, "brain_hangar_sessions", { workItemId: item });
    expect(bounded.truncated).toBe(true);
    expect(bounded.sessions.length + bounded.droppedSessionIds.length).toBe(3);
    expect(bounded.droppedSessionIds.length).toBeGreaterThan(0);
    expect(bounded.truncationNote).toMatch(/droppedSessionIds/);
  });

  it("refuses a limit over 100 and an unknown state at the argument schema", async () => {
    const client = await connect();
    const overLimit = await client.callTool({ name: "brain_hangar_sessions", arguments: { limit: 101 } });
    expect(overLimit.isError).toBe(true);
    expect(textOf(overLimit)).toMatch(/limit/);
    const badState = await client.callTool({ name: "brain_hangar_sessions", arguments: { states: ["paused"] } });
    expect(badState.isError).toBe(true);
    expect(textOf(badState)).toMatch(/states/);
  });
});

describe("brain_write refuses hangar sessions", () => {
  it("refuses a batch carrying a hangar_session node, naming the item, and persists nothing from it", async () => {
    const client = await connect();
    const externalId = `forged-${SUFFIX}`;
    const raw = await client.callTool({
      name: "brain_write",
      arguments: {
        items: [
          { nodeType: "doc", sourceSystem: FIXTURE_SOURCE, externalId: `fine-${SUFFIX}`, title: "would be fine alone" },
          { nodeType: "hangar_session", sourceSystem: FIXTURE_SOURCE, externalId, title: "forged", metadata: { state: "running", flavor: "headless", repo: "x/y" } },
        ],
      },
    });
    expect(raw.isError).toBe(true);
    expect(textOf(raw)).toContain(`batch index 1 (${FIXTURE_SOURCE}/${externalId})`);
    expect(textOf(raw)).toMatch(/nothing from this call was persisted/i);
    const stored = await db.select({ id: nodes.id }).from(nodes).where(inArray(nodes.externalId, [externalId, `fine-${SUFFIX}`]));
    expect(stored).toEqual([]);
  });

  it("refuses any node under source system hangar, whatever its type", async () => {
    const client = await connect();
    const externalId = `forged-src-${SUFFIX}`;
    const raw = await client.callTool({ name: "brain_write", arguments: { items: { nodeType: "doc", sourceSystem: "hangar", externalId, title: "forged" } } });
    expect(raw.isError).toBe(true);
    expect(textOf(raw)).toMatch(/reserved for the hangar queue/);
    const stored = await db.select({ id: nodes.id }).from(nodes).where(and(eq(nodes.sourceSystem, "hangar"), eq(nodes.externalId, externalId)));
    expect(stored).toEqual([]);
  });
});
