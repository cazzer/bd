import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@breakdown/db";
import { upsertEdges } from "./edges.js";
import { InboxCardChangedError, InboxDecisionConflictError, InvalidInboxItemError, NotAnInboxItemError } from "./errors.js";
import {
  carryForwardInboxDecisions,
  completeInboxItem,
  decideInboxItem,
  handOffInboxItem,
  inboxItemDigested,
  releaseInboxItem,
  requestInboxItem,
  INBOX_ITEM_NODE_TYPE,
  listInbox,
  loadStoredInboxMetadata,
  normalizeInboxItemMetadata,
  unlinkInboxWorkContext,
} from "./inbox.js";
import { mergeNodes } from "./merge.js";
import { normalizeWorkItemMetadata, WORK_ITEM_NODE_TYPE } from "./work-items.js";
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
    expect(normalizeInboxItemMetadata({ source: "Gmail" })).toEqual({ source: "gmail", status: "pending", action: "none", priority: 2, links: [], read: [], feedback: [] });
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

describe("revision and close reason (inbox-follow-through)", () => {
  it("keeps them as trimmed text, drops blanks, and refuses a wrong type or length", () => {
    const m = normalizeInboxItemMetadata({ source: "slack", revision: "  dropped the alias line ", close_reason: "already sent a message, close this" });
    expect(m["revision"]).toBe("dropped the alias line");
    expect(m["close_reason"]).toBe("already sent a message, close this");
    expect(normalizeInboxItemMetadata({ source: "slack", revision: "  " })).not.toHaveProperty("revision");
    expect(() => normalizeInboxItemMetadata({ source: "slack", revision: "x".repeat(201) })).toThrow(/revision/);
    expect(() => normalizeInboxItemMetadata({ source: "slack", revision: "two\nlines" })).toThrow(/revision/);
    expect(() => normalizeInboxItemMetadata({ source: "slack", close_reason: 7 })).toThrow(/close_reason/);
    expect(() => normalizeInboxItemMetadata({ source: "slack", close_reason: "x".repeat(501) })).toThrow(/close_reason/);
  });

  it("serves both, and the next person decision clears revision but not close_reason", async () => {
    const id = await write("slack:C1/1", { source: "slack", revision: "rewrote the reply", close_reason: "kept from an earlier close" });
    let item = (await mine()).find((i) => i.id === id)!;
    expect([item.revision, item.closeReason]).toEqual(["rewrote the reply", "kept from an earlier close"]);
    await decideInboxItem(db, id, { decision: "accept" });
    item = (await mine()).find((i) => i.id === id)!;
    expect([item.revision, item.closeReason]).toEqual([null, "kept from an earlier close"]);
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

const PR = "https://github.com/acme/app/pull/971";
const CARD = {
  question: "Track or ignore these action items?",
  options: [
    { id: "track", label: "Track them" },
    { id: "ignore", label: "Ignore", risk: "lose a real ask" },
  ],
  recommend: "ignore",
  on_accept: ["close the batch"],
};

describe("inbox decision cards", () => {
  it("normalizes a card through the review card rules and reads it as fields", () => {
    const meta = normalizeInboxItemMetadata({ source: "fathom", ...CARD, question: "  Track or ignore these action items?  " });
    expect(meta).toMatchObject(CARD);
    expect(normalizeInboxItemMetadata(meta)).toEqual(meta);
  });

  it("refuses a broken card naming the field", () => {
    expect(() => normalizeInboxItemMetadata({ source: "x", ...CARD, recommend: "C" }, { itemLabel: "(inbox/k)" })).toThrow(/\(inbox\/k\): recommend/);
    expect(() => normalizeInboxItemMetadata({ source: "x", options: [{ id: "A", label: "a" }] })).toThrow(/: options/);
    expect(() => normalizeInboxItemMetadata({ source: "x", on_accept: "do it" })).toThrow(/: on_accept/);
    expect(() => normalizeInboxItemMetadata({ source: "x", question: 4 })).toThrow(/: question/);
  });

  it("accepts with an offered option, records it, and refuses one the card does not offer", async () => {
    const id = await write("fathom:card/1", { source: "fathom", ...CARD });
    await expect(decideInboxItem(db, id, { decision: "accept" })).rejects.toThrow(InboxCardChangedError);
    await expect(decideInboxItem(db, id, { decision: "accept", option: "B" })).rejects.toThrow(/does not offer option "B"/);
    await expect(decideInboxItem(db, id, { decision: "changes", message: "x", option: "track" })).rejects.toThrow(/only with accept/);
    expect(await decideInboxItem(db, id, { decision: "accept", option: "track" })).toMatchObject({ after: "accepted" });
    const item = (await mine()).find((i) => i.id === id)!;
    expect(item.feedback.at(-1)).toMatchObject({ decision: "accept", option: "track" });
    expect(item).toMatchObject({ question: CARD.question, recommend: "ignore", onAccept: ["close the batch"] });
  });

  it("keeps a plain item's accept as before, and refuses an option on it", async () => {
    const id = await write("gmail:card/2", { source: "gmail" });
    await expect(decideInboxItem(db, id, { decision: "accept", option: "A" })).rejects.toThrow(/changed since it was opened|does not offer/);
    expect(await decideInboxItem(db, id, { decision: "accept" })).toMatchObject({ after: "accepted" });
    const item = (await mine()).find((i) => i.id === id)!;
    expect(item.feedback.at(-1)!.option).toBeUndefined();
    expect(item).toMatchObject({ question: null, options: [], recommend: null, onAccept: [] });
  });
});

describe("inbox digestion", () => {
  it("normalizes read and refuses a bad entry", () => {
    expect(normalizeInboxItemMetadata({ source: "github", read: [{ ref: `${PR}/files`, depth: "full" }] })["read"]).toEqual([{ ref: `${PR}/files`, depth: "full" }]);
    expect(() => normalizeInboxItemMetadata({ source: "github", read: [{ ref: PR, depth: "glanced" }] })).toThrow(/read\[0\]\.depth/);
    expect(() => normalizeInboxItemMetadata({ source: "github", read: [{ depth: "full" }] })).toThrow(/read\[0\]\.ref/);
  });

  it("covers the url by an equal ref or one under it, not a sibling", () => {
    const meta = (read: string[]) => normalizeInboxItemMetadata({ source: "github", url: PR, read: read.map((ref) => ({ ref, depth: "full" })) });
    expect(inboxItemDigested(meta([PR]))).toBe(true);
    expect(inboxItemDigested(meta([`${PR}/files`]))).toBe(true);
    expect(inboxItemDigested(meta([`${PR}/`]))).toBe(true);
    expect(inboxItemDigested(meta([`${PR}0`]))).toBe(false);
    expect(inboxItemDigested(meta([]))).toBe(false);
    expect(inboxItemDigested(normalizeInboxItemMetadata({ source: "session" }))).toBe(true);
  });

  it("covers a position in a resource by a read of the whole resource, not of another one", () => {
    const call = "https://fathom.video/calls/100000001";
    const at = (url: string, read: string[]) => inboxItemDigested(normalizeInboxItemMetadata({ source: "fathom", url, read: read.map((ref) => ({ ref, depth: "full" })) }));
    expect(at(`${call}?timestamp=99`, [call])).toBe(true);
    expect(at(`${call}#t=99`, [`${call}/`])).toBe(true);
    expect(at(`${call}?timestamp=99`, ["https://fathom.video/calls/100000002"])).toBe(false);
    expect(at(`${call}?timestamp=99`, ["https://fathom.video/calls"])).toBe(false);
  });

  it("holds a new item that skipped its url, releases it on a covering re-write, and never pulls a pending one back", () => {
    const skipped = normalizeInboxItemMetadata({ source: "github", url: PR });
    const read = normalizeInboxItemMetadata({ source: "github", url: PR, read: [{ ref: `${PR}/files`, depth: "full" }] });
    expect(carryForwardInboxDecisions(skipped, null)["status"]).toBe("undigested");
    expect(carryForwardInboxDecisions(read, null)["status"]).toBe("pending");
    const held = { ...skipped, status: "undigested" };
    expect(carryForwardInboxDecisions(skipped, held)["status"]).toBe("undigested");
    expect(carryForwardInboxDecisions(read, held)["status"]).toBe("pending");
    expect(carryForwardInboxDecisions(skipped, read)["status"]).toBe("pending");
    expect(carryForwardInboxDecisions({ ...skipped, status: "changes" }, null)["status"]).toBe("changes");
  });

  it("holds a session-queued PR it did not read, lists it only on request, and lets the person release or dismiss it", async () => {
    const key = `session:digest-${SRC}`;
    const queued = await requestInboxItem(db, { externalId: key, title: "Review #971", content: "I haven't read the diff.", metadata: { source: "github", url: PR, action: "review" } });
    try {
      expect((await listInbox(db, { ids: [queued.id] })).items).toHaveLength(0);
      const [held] = (await listInbox(db, { ids: [queued.id], statuses: ["undigested"] })).items;
      expect(held!.status).toBe("undigested");
      await expect(decideInboxItem(db, queued.id, { decision: "accept" })).rejects.toThrow(InboxDecisionConflictError);
      expect(await releaseInboxItem(db, queued.id)).toMatchObject({ before: "undigested", after: "pending" });
      const [released] = (await listInbox(db, { ids: [queued.id] })).items;
      expect(released!.feedback.at(-1)!.decision).toBe("release");
      await expect(releaseInboxItem(db, queued.id)).rejects.toThrow(InboxDecisionConflictError);

      const again = await requestInboxItem(db, { externalId: `${key}-2`, title: "Review #972", content: "x", metadata: { source: "github", url: `${PR}2` } });
      expect(await decideInboxItem(db, again.id, { decision: "dismiss" })).toMatchObject({ before: "undigested", after: "dismissed" });
      const digested = await requestInboxItem(db, {
        externalId: `${key}-2`,
        title: "Review #972",
        content: "Read the diff: two issues.",
        metadata: { source: "github", url: `${PR}2`, read: [{ ref: `${PR}2/files`, depth: "full" }] },
      });
      expect((await listInbox(db, { ids: [digested.id], statuses: ["dismissed"] })).items).toHaveLength(1);
    } finally {
      await db.execute(sql`DELETE FROM nodes WHERE source_system = 'inbox' AND external_id IN (${key}, ${`${key}-2`})`);
    }
  });
});

describe("work context (inbox-follow-through)", () => {
  async function work(externalId: string, title: string, project: string): Promise<string> {
    const result = await upsertNodes(db, run, [
      { nodeType: WORK_ITEM_NODE_TYPE, sourceSystem: SRC, externalId, title, content: "", metadata: normalizeWorkItemMetadata({ project }) },
    ]);
    return result.rows[0]!.id;
  }

  it("serves the heaviest about target, folds a merged one to its survivor, and unlinks", async () => {
    const rfi = await work("work:vendor-rfi", "Vendor RFI", "vendor-rfi");
    const other = await work("work:other", "Other", "other");
    const item = await write("slack:C9/1", { source: "slack" });
    const plain = await write("slack:C9/2", { source: "slack" });
    await upsertEdges(db, run, [
      { srcId: item, dstId: rfi, edgeType: "about", sourceSystem: SRC, weight: 0.9 },
      { srcId: item, dstId: other, edgeType: "about", sourceSystem: SRC, weight: 0.4 },
    ]);

    let items = await mine();
    expect(items.find((i) => i.id === item)?.about).toEqual({ id: rfi, title: "Vendor RFI", project: "vendor-rfi" });
    expect(items.find((i) => i.id === plain)?.about).toBeNull();

    const dupe = await work("work:vendor-rfi-dupe", "Vendor RFI (dupe)", "vendor-rfi");
    const third = await write("slack:C9/3", { source: "slack" });
    await upsertEdges(db, run, [{ srcId: third, dstId: dupe, edgeType: "about", sourceSystem: SRC }]);
    await mergeNodes(db, dupe, rfi, run);
    items = await mine();
    expect(items.find((i) => i.id === third)?.about?.id).toBe(rfi);

    expect(await unlinkInboxWorkContext(db, item)).toEqual({ id: item, removed: 2 });
    items = await mine();
    const after = items.find((i) => i.id === item)!;
    expect(after.about).toBeNull();
    expect(after.status).toBe("pending");
    expect(await unlinkInboxWorkContext(db, item)).toEqual({ id: item, removed: 0 });
    await expect(unlinkInboxWorkContext(db, rfi)).rejects.toThrow(NotAnInboxItemError);
  });
});

describe("the actor the person's inbox writes record (tailnet-hosting decision 4)", () => {
  async function runOf(ingestRunId: string): Promise<{ actor: string | null; source_system: string } | undefined> {
    return (await db.execute<{ actor: string | null; source_system: string }>(sql`SELECT actor, source_system FROM ingest_runs WHERE id = ${ingestRunId}`)).rows[0];
  }

  it("is `human` by default and the named client when the caller passes one", async () => {
    const plain = await write("slack:C9/actor-default", { source: "slack" });
    const decidedPlain = await decideInboxItem(db, plain, { decision: "dismiss" });
    expect(await runOf(decidedPlain.ingestRunId)).toEqual({ actor: "human", source_system: "human" });

    const fromPhone = await write("slack:C9/actor-phone", { source: "slack" });
    const decided = await decideInboxItem(db, fromPhone, { decision: "accept" }, { actor: "phone" });
    expect(await runOf(decided.ingestRunId)).toEqual({ actor: "phone", source_system: "human" });

    const held = await write("github:actor-held", { source: "github", status: "undigested" });
    const released = await releaseInboxItem(db, held, {}, { actor: "phone" });
    expect(released.before).toBe("undigested");
    expect(await runOf(released.ingestRunId)).toEqual({ actor: "phone", source_system: "human" });

    const handed = await handOffInboxItem(db, held, { pane: "w9:p3", socket: "/tmp/herdr.sock", tab: "w9:t3" }, { actor: "phone" });
    expect(await runOf(handed.ingestRunId)).toEqual({ actor: "phone", source_system: "human" });
  });
});
