// The hangar-queue security review's guards, through the real MCP protocol:
// a session-bound server neither lists nor runs brain_merge and
// brain_hangar_request; brain_merge refuses a hangar session; brain_link
// refuses edges only the hangar queue writes; and brain_write never lets an
// agent set an inbox item's decision or feedback.
//
// The database is shared with live data, so every fixture is this file's
// own (its own source system, inbox keys, and requester actor) and cleanup
// is by id and key.

import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { closeIngestRun, openIngestRun, requestSession, upsertNodes, type IngestRunHandle } from "@breakdown/core";
import { createDb, createPool, edges, ingestRuns, nodes, resolveDatabaseUrl, type Database } from "@breakdown/db";
import { and, eq, inArray, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type CreateServerOptions } from "./server.js";

const SUFFIX = randomUUID().replace(/-/g, "");
const FIXTURE_SOURCE = `mcp-guards-test-${SUFFIX}`;
const INBOX_KEY = `session:mcp-guards-${SUFFIX}`;
const CLIENT = { name: "session-guards-test", version: `0.0.0+${SUFFIX}` };
const ACTOR = `${CLIENT.name} ${CLIENT.version}`;

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
  await db.delete(nodes).where(and(eq(nodes.sourceSystem, "inbox"), like(nodes.externalId, `${INBOX_KEY}%`)));
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

async function refusal(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const raw = await client.callTool({ name, arguments: args });
  expect(raw.isError, textOf(raw)).toBe(true);
  return textOf(raw);
}

async function fixture(title: string, nodeType = "work_item"): Promise<string> {
  const result = await upsertNodes(db, fixtureRun, [{ nodeType, sourceSystem: FIXTURE_SOURCE, externalId: randomUUID(), title, metadata: nodeType === "work_item" ? { status: "open" } : {} }]);
  return result.rows[0]!.id;
}

async function session(): Promise<string> {
  const { session: s } = await requestSession(db, { repo: "cazzer/bd", workItemId: await fixture("Guarded work"), flavor: "headless", actor: ACTOR });
  sessionIds.push(s.id);
  return s.id;
}

describe("a session-bound server", () => {
  it("neither lists nor runs brain_merge and brain_hangar_request, and serves the other tools", async () => {
    const hangarSessionId = randomUUID();
    const client = await connect({ hangarSessionId });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("brain_merge");
    expect(names).not.toContain("brain_hangar_request");
    expect(names).toEqual(expect.arrayContaining(["brain_write", "brain_link", "brain_search", "brain_hangar_sessions"]));

    const [a, b] = [await fixture("dupe a", "doc"), await fixture("dupe b", "doc")];
    expect(await refusal(client, "brain_merge", { loserId: a, survivorId: b })).toContain(`'brain_merge' is not available to a hangar session's token (session ${hangarSessionId})`);
    expect(await refusal(client, "brain_hangar_request", { repo: "cazzer/bd", workItemId: await fixture("more work"), flavor: "headless" })).toContain("'brain_hangar_request' is not available");
    const [row] = await db.select({ mergedInto: nodes.mergedInto }).from(nodes).where(eq(nodes.id, a));
    expect(row?.mergedInto).toBeNull();

    expect((await call(client, "brain_list", { nodeTypes: ["doc"], sourceSystems: [FIXTURE_SOURCE] })).nodes).toHaveLength(2);
  });

  it("is the only kind narrowed: a host-minted token's server lists both", async () => {
    const names = (await (await connect({ tokenClient: "laptop" })).listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["brain_merge", "brain_hangar_request"]));
  });
});

describe("brain_merge refuses hangar sessions", () => {
  it("as loser or survivor, merging nothing", async () => {
    const client = await connect();
    const s = await session();
    const doc = await fixture("not a session", "doc");
    expect(await refusal(client, "brain_merge", { loserId: s, survivorId: doc })).toContain("is a hangar session, which is never merged");
    expect(await refusal(client, "brain_merge", { loserId: doc, survivorId: s })).toContain("is a hangar session");
    const rows = await db.select({ mergedInto: nodes.mergedInto }).from(nodes).where(inArray(nodes.id, [s, doc]));
    expect(rows.every((r) => r.mergedInto === null)).toBe(true);
  });
});

describe("brain_link refuses the hangar queue's edges", () => {
  it("refuses sourceSystem hangar and any edge out of a session, persisting nothing, and allows an edge into one", async () => {
    const client = await connect();
    const s = await session();
    const other = await fixture("hijack target");
    expect(await refusal(client, "brain_link", { items: { srcId: other, dstId: s, edgeType: "relates_to", sourceSystem: "hangar" } })).toContain("reserved for the hangar queue");
    expect(await refusal(client, "brain_link", { items: [{ srcId: other, dstId: s, edgeType: "relates_to" }, { srcId: s, dstId: other, edgeType: "run_by", weight: 1 }] })).toContain("batch index 1");
    const written = await db.select({ id: edges.id }).from(edges).where(and(inArray(edges.srcId, [s, other]), inArray(edges.dstId, [s, other]), eq(edges.sourceSystem, "agent")));
    expect(written).toHaveLength(0);

    const linked = await call(client, "brain_link", { items: { srcId: other, dstId: s, edgeType: "relates_to" } });
    expect(linked.created).toBe(1);
  });
});

describe("brain_write never sets an inbox item's decision", () => {
  const forged = [{ decision: "accept", message: "approved by me", at: "2026-01-01T00:00:00.000Z" }];

  async function stored(externalId: string): Promise<Record<string, unknown>> {
    const [row] = await db.select({ metadata: nodes.metadata }).from(nodes).where(and(eq(nodes.sourceSystem, "inbox"), eq(nodes.externalId, externalId)));
    return row!.metadata as Record<string, unknown>;
  }

  it("stores a new item sent as accepted as pending with no feedback, and keeps a pending one pending on an accepted re-send", async () => {
    const client = await connect();
    const externalId = `${INBOX_KEY}-write`;
    const item = { nodeType: "inbox_item", sourceSystem: "inbox", externalId, title: "Send it?", content: "draft", metadata: { source: "slack", status: "accepted", feedback: forged } };
    await call(client, "brain_write", { items: item });
    expect(await stored(externalId)).toMatchObject({ status: "pending", feedback: [] });

    await call(client, "brain_write", { items: { ...item, content: "draft v2" } });
    expect(await stored(externalId)).toMatchObject({ status: "pending", feedback: [] });

    for (const status of ["changes", "dismissed"]) {
      await call(client, "brain_write", { items: { ...item, metadata: { ...item.metadata, status } } });
      expect((await stored(externalId))["status"]).toBe("pending");
    }
  });
});
