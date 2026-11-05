import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@breakdown/db";
import { upsertEdges } from "./edges.js";
import { InboxDecisionConflictError, InvalidInboxItemError, NotAnInboxItemError } from "./errors.js";
import { carryForwardInboxDecisions, completeInboxItem, decideInboxItem, handOffInboxItem, requestInboxItem, INBOX_ITEM_NODE_TYPE, listInbox, loadStoredInboxMetadata, normalizeInboxItemMetadata } from "./inbox.js";
import { closeIngestRun, openIngestRun, type IngestRunHandle } from "./ingest-runs.js";
import { upsertNodes } from "./nodes.js";
import { connectTestDb, type TestPool, uniqueSuffix } from "./test-helpers.js";

const SRC = `inbox-test-${uniqueSuffix().slice(0, 10)}`;

let pool: TestPool;
let db: Database;
let run: IngestRunHandle;

async function write(externalId: string, metadata: Record<string, unknown>, title = externalId): Promise<string> {
  const result = await upsertNodes(db, run, [
    { nodeType: INBOX_ITEM_NODE_TYPE, sourceSystem: SRC, externalId, title, content: `# ${title}\n\nDraft reply.`, metadata: normalizeInboxItemMetadata(metadata) },
  ]);
  return result.rows[0]!.id;
}

async function mine() {
  const all = await listInbox(db, { statuses: ["pending", "changes", "accepted", "dismissed", "done"] });
  const ids = new Set((await db.execute<{ id: string }>(sql`SELECT id FROM nodes WHERE source_system = ${SRC}`)).rows.map((r) => r.id));
  return all.items.filter((i) => ids.has(i.id));
}

beforeAll(async () => {
  ({ pool, db } = connectTestDb());
  run = await openIngestRun(db, SRC);
});

afterAll(async () => {
  await closeIngestRun(db, run);
  await db.execute(sql`DELETE FROM nodes WHERE source_system = ${SRC}`);
  await pool.end();
});

describe("normalizeInboxItemMetadata", () => {
  it("defaults status, action, priority, links, and feedback", () => {
    expect(normalizeInboxItemMetadata({ source: "Gmail" })).toEqual({ source: "gmail", status: "pending", action: "none", priority: 2, links: [], feedback: [] });
  });

  it("keeps unknown keys and is idempotent", () => {
    const once = normalizeInboxItemMetadata({ source: "asana", url: "https://app.asana.com/x", source_ids: ["a"], links: [{ label: "Task", url: "https://app.asana.com/x" }] });
    expect(normalizeInboxItemMetadata(once)).toEqual(once);
    expect(once["source_ids"]).toEqual(["a"]);
  });

  it("refuses a missing source, a bad status, a non-http url, and a bad priority", () => {
    expect(() => normalizeInboxItemMetadata({})).toThrow(InvalidInboxItemError);
    expect(() => normalizeInboxItemMetadata({ source: "x", status: "open" })).toThrow(/status/);
    expect(() => normalizeInboxItemMetadata({ source: "x", url: "javascript:alert(1)" })).toThrow(/url/);
    expect(() => normalizeInboxItemMetadata({ source: "x", priority: 9 })).toThrow(/priority/);
  });
});

describe("listInbox and decideInboxItem", () => {
  it("lists open items by priority, carries a batch parent, and moves status on decisions", async () => {
    const low = await write("gmail:thread/1", { source: "gmail", priority: 3, occurred_at: "2026-11-01T00:00:00.000Z" });
    const urgent = await write("asana:task/2", { source: "asana", priority: 0 });
    const batch = await write("fathom:rec/3", { source: "fathom", action: "decide" });
    const candidate = await write("fathom:rec/3#1", { source: "fathom", verdict: "not_actionable", action: "ignore" });
    await upsertEdges(db, run, [{ srcId: candidate, dstId: batch, edgeType: "child_of", sourceSystem: SRC }]);

    let items = await mine();
    expect(items.map((i) => i.id).slice(0, 1)).toEqual([urgent]);
    expect(items.find((i) => i.id === candidate)?.parentId).toBe(batch);
    expect(items.find((i) => i.id === low)?.receivedAt.toISOString()).toBe("2026-11-01T00:00:00.000Z");

    await expect(decideInboxItem(db, low, { decision: "changes" })).rejects.toThrow(/required/);
    expect(await decideInboxItem(db, low, { decision: "changes", message: "shorter" })).toMatchObject({ before: "pending", after: "changes" });
    await expect(decideInboxItem(db, low, { decision: "accept" })).rejects.toThrow(InboxDecisionConflictError);
    expect(await decideInboxItem(db, low, { decision: "dismiss" })).toMatchObject({ before: "changes", after: "dismissed" });
    expect(await decideInboxItem(db, urgent, { decision: "accept", message: "send it" })).toMatchObject({ after: "accepted" });

    items = await mine();
    const decided = items.find((i) => i.id === low)!;
    expect(decided.status).toBe("dismissed");
    expect(decided.feedback.map((f) => [f.decision, f.message])).toEqual([
      ["changes", "shorter"],
      ["dismiss", ""],
    ]);
    const open = await listInbox(db);
    expect(open.items.some((i) => i.id === low)).toBe(false);
    expect(open.items.some((i) => i.id === urgent)).toBe(true);
  });

  it("refuses a node that is not an inbox item", async () => {
    const other = (await upsertNodes(db, run, [{ nodeType: "note", sourceSystem: SRC, externalId: "note-1", title: "n", content: "" }])).rows[0]!.id;
    await expect(decideInboxItem(db, other, { decision: "accept" })).rejects.toThrow(NotAnInboxItemError);
  });
});

describe("re-ingest keeps the person's decisions", () => {
  const fb = [{ decision: "dismiss", message: "", at: "2026-11-05T00:00:00.000Z" }];

  it("keeps stored feedback and a settled status against an incoming pending", () => {
    const stored = normalizeInboxItemMetadata({ source: "gmail", status: "dismissed", feedback: fb });
    const incoming = normalizeInboxItemMetadata({ source: "gmail" });
    expect(carryForwardInboxDecisions(incoming, stored)).toMatchObject({ status: "dismissed", feedback: fb });
  });

  it("lets the agent move changes to pending and accepted to done", () => {
    const changes = normalizeInboxItemMetadata({ source: "gmail", status: "changes", feedback: fb });
    expect(carryForwardInboxDecisions(normalizeInboxItemMetadata({ source: "gmail", feedback: fb }), changes)["status"]).toBe("pending");
    const accepted = normalizeInboxItemMetadata({ source: "gmail", status: "accepted" });
    expect(carryForwardInboxDecisions(normalizeInboxItemMetadata({ source: "gmail", status: "done" }), accepted)["status"]).toBe("done");
  });

  it("lets an executor hand an accepted item back only with needs_you", () => {
    const accepted = normalizeInboxItemMetadata({ source: "slack", status: "accepted" });
    expect(carryForwardInboxDecisions(normalizeInboxItemMetadata({ source: "slack" }), accepted)["status"]).toBe("accepted");
    expect(carryForwardInboxDecisions(normalizeInboxItemMetadata({ source: "slack", needs_you: "which channel?" }), accepted)["status"]).toBe("pending");
  });

  it("loads stored metadata by (source system, external id)", async () => {
    await write("slack:C1/1.2", { source: "slack", status: "accepted" });
    const map = await loadStoredInboxMetadata(db, [{ sourceSystem: SRC, externalId: "slack:C1/1.2" }, { sourceSystem: SRC, externalId: "nope" }]);
    expect(map.size).toBe(1);
    expect(map.get(`${SRC}\u0000slack:C1/1.2`)?.["status"]).toBe("accepted");
  });
});

describe("session requests and completion", () => {
  const key = `session:test-${SRC}`;
  afterAll(async () => {
    await db.execute(sql`DELETE FROM nodes WHERE source_system = 'inbox' AND external_id = ${key}`);
  });

  it("queues, keeps the decision on re-request, reports the pane, and completes", async () => {
    const meta = { source: "session", action: "reply", pane: "w1:p1", socket: "/tmp/herdr.sock" };
    const first = await requestInboxItem(db, { externalId: key, title: "Ask ops", content: "draft", metadata: meta });
    expect(first.action).toBe("created");
    const decided = await decideInboxItem(db, first.id, { decision: "accept", message: "send it" });
    expect(decided).toMatchObject({ after: "accepted", pane: "w1:p1", socket: "/tmp/herdr.sock", title: "Ask ops" });

    await requestInboxItem(db, { externalId: key, title: "Ask ops", content: "draft v2", metadata: meta });
    const again = (await listInbox(db, { statuses: ["accepted"] })).items.find((i) => i.id === first.id)!;
    expect(again.status).toBe("accepted");
    expect(again.feedback).toHaveLength(1);

    await expect(completeInboxItem(db, first.id, "  ")).rejects.toThrow(InvalidInboxItemError);
    await completeInboxItem(db, first.id, "sent in #retail-ops");
    const done = (await listInbox(db, { statuses: ["done"] })).items.find((i) => i.id === first.id)!;
    expect(done.content.startsWith("**Done:** sent in #retail-ops")).toBe(true);
    await expect(completeInboxItem(db, first.id, "again")).rejects.toThrow(InboxDecisionConflictError);
  });
});

describe("handing an item to an interactive session", () => {
  const key = `session:handoff-${SRC}`;
  afterAll(async () => {
    await db.execute(sql`DELETE FROM nodes WHERE source_system = 'inbox' AND external_id = ${key}`);
  });

  it("moves it to session, survives a re-ingest, returns on the session's own re-request, and completes", async () => {
    const queued = await requestInboxItem(db, { externalId: key, title: "Review the RFP", content: "summary", metadata: { source: "gmail", action: "decide" } });
    const handed = await handOffInboxItem(db, queued.id, { pane: "w9:p1", socket: "/tmp/herdr.sock", tab: "w9:t1" });
    expect(handed.before).toBe("pending");

    let item = (await listInbox(db, { ids: [queued.id] })).items[0]!;
    expect(item).toMatchObject({ status: "session", sessionTab: "w9:t1" });
    expect(item.feedback.at(-1)).toMatchObject({ decision: "session" });

    // A re-ingest (no pane) leaves it with the session.
    await requestInboxItem(db, { externalId: key, title: "Review the RFP", content: "summary v2", metadata: { source: "gmail", action: "decide" } });
    item = (await listInbox(db, { ids: [queued.id] })).items[0]!;
    expect(item).toMatchObject({ status: "session", sessionTab: "w9:t1" });
    await expect(decideInboxItem(db, queued.id, { decision: "accept" })).rejects.toThrow(InboxDecisionConflictError);

    // The session re-queues its draft from the same pane: back to the person, still pointing at the session.
    await requestInboxItem(db, { externalId: key, title: "Review the RFP", content: "draft answer", metadata: { source: "session", action: "reply", pane: "w9:p1", socket: "/tmp/herdr.sock" } });
    item = (await listInbox(db, { ids: [queued.id] })).items[0]!;
    expect(item).toMatchObject({ status: "pending", sessionTab: "w9:t1" });
    expect(await decideInboxItem(db, queued.id, { decision: "accept" })).toMatchObject({ pane: "w9:p1" });
    await completeInboxItem(db, queued.id, "submitted");
  });

  it("refuses a closed item and lets a session close what it worked directly", async () => {
    const closed = await write("asana:task/closed-handoff", { source: "asana", status: "done" });
    await expect(handOffInboxItem(db, closed, { pane: "w9:p2", socket: "/tmp/herdr.sock", tab: "w9:t2" })).rejects.toThrow(InboxDecisionConflictError);
    const open = await write("asana:task/open-handoff", { source: "asana" });
    await handOffInboxItem(db, open, { pane: "w9:p2", socket: "/tmp/herdr.sock", tab: "w9:t2" });
    await completeInboxItem(db, open, "answered in the session");
    expect((await mine()).find((i) => i.id === open)?.status).toBe("done");
  });
});
