import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@breakdown/db";
import { upsertEdges } from "./edges.js";
import { HangarOutcomeRefusedError, ReservedInboxItemError, InboxCardChangedError, InboxDecisionConflictError, InboxItemNotThisSessionError, InboxItemSessionEndedError, InvalidInboxItemError, NotAnInboxItemError } from "./errors.js";
import {
  assertNoHangarOutcomeKeys,
  HANGAR_OUTCOME_OPTIONS,
  assertSessionCreatedAbsentKeys,
  assertSessionMayWriteInboxItems,
  carryForwardInboxDecisions,
  completeInboxItem,
  decideInboxItem,
  handOffInboxItem,
  inboxItemDigested,
  inboxNotifyText,
  releaseInboxItem,
  requestHangarOutcome,
  requestInboxItem,
  INBOX_ITEM_NODE_TYPE,
  listInbox,
  loadStoredInboxMetadata,
  MAX_SHOWN_HANGAR_REPO,
  normalizeInboxItemMetadata,
  quoteHangarRepo,
  unlinkInboxWorkContext,
} from "./inbox.js";
import { listSessions } from "./hangar.js";
import { getNodeHistory } from "./history.js";
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

  it("refuses to complete through a merged-away id, leaving the canonical item accepted", async () => {
    const canonical = await write("merge-complete-canonical", { source: "agent", status: "accepted" });
    const merged = await write("merge-complete-merged", { source: "agent", status: "accepted" });
    await db.execute(sql`UPDATE nodes SET merged_into = ${canonical}::uuid WHERE id = ${merged}::uuid`);
    try {
      const refused = await completeInboxItem(db, merged, "sent").catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(InboxCardChangedError);
      expect((refused as InboxCardChangedError).mergedInto).toBe(canonical);
      expect((await mine()).find((i) => i.id === canonical)?.status).toBe("accepted");
      await completeInboxItem(db, canonical, "sent");
    } finally {
      await db.execute(sql`UPDATE nodes SET merged_into = NULL WHERE id = ${merged}::uuid`);
    }
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
    // A new item's status is never the agent's: "changes" is the person's.
    expect(carryForwardInboxDecisions({ ...skipped, status: "changes" }, null)["status"]).toBe("undigested");
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

// hangar-queue decisions 6 and 9: an item a remote session filed is bound to
// that session (from its token, never the body), and the person's decision,
// release, or hand-off on it becomes that session's message while the
// session is live; once it has ended, nothing is sent and the item turns
// local.
describe("items a hangar session filed", () => {
  const key = `session:hangar-${SRC}`;
  const sessions: string[] = [];
  const sessionNodes: string[] = [];
  /** A session id with no session node behind it: what an ended-and-gone session looks like. */
  const session = (): string => {
    const id = randomUUID();
    sessions.push(id);
    return id;
  };
  /**
   * A hangar session node in `state`, written straight to the store (not
   * through the queue). Never queued, so no real hangar can claim it, and
   * claimed by a `test-` name no real hangar lists.
   */
  async function sessionNode(state: string): Promise<string> {
    const result = await upsertNodes(db, run, [
      { nodeType: "hangar_session", sourceSystem: "hangar", externalId: randomUUID(), title: "test session", metadata: { state, flavor: "headless", repo: "test/repo", claimed_by: `test-${SRC}` } },
    ]);
    const id = result.rows[0]!.id;
    sessions.push(id);
    sessionNodes.push(id);
    return id;
  }
  afterAll(async () => {
    await db.execute(sql`DELETE FROM nodes WHERE source_system = 'inbox' AND external_id LIKE ${`${key}%`}`);
    if (sessions.length > 0) await db.execute(sql`DELETE FROM hangar_messages WHERE session_id = ANY(${`{${sessions.join(",")}}`}::uuid[])`);
    if (sessionNodes.length > 0) await db.execute(sql`DELETE FROM nodes WHERE id = ANY(${`{${sessionNodes.join(",")}}`}::uuid[])`);
  });

  async function messagesFor(sessionId: string): Promise<{ kind: string; body: Record<string, unknown> }[]> {
    return (await db.execute<{ kind: string; body: Record<string, unknown> }>(sql`SELECT kind, body FROM hangar_messages WHERE session_id = ${sessionId}::uuid ORDER BY id`)).rows;
  }

  async function messagesAbout(itemId: string): Promise<number> {
    return (await db.execute(sql`SELECT 1 FROM hangar_messages WHERE body->>'item_id' = ${itemId}`)).rows.length;
  }

  it("validates `session` as a uuid and reads it as hangarSession", () => {
    const id = randomUUID();
    const normalized = normalizeInboxItemMetadata({ source: "session", session: id.toUpperCase() });
    expect(normalized["session"]).toBe(id);
    expect(normalizeInboxItemMetadata({ source: "session", session: null })).not.toHaveProperty("session");
    expect(() => normalizeInboxItemMetadata({ source: "session", session: "w1:p1" })).toThrow(InvalidInboxItemError);
  });

  it("never takes `session` from a writer: carry-forward drops the incoming one and keeps the stored one", () => {
    const stored = normalizeInboxItemMetadata({ source: "session", session: randomUUID() });
    const forged = normalizeInboxItemMetadata({ source: "session", session: randomUUID() });
    expect(carryForwardInboxDecisions(forged, null)).not.toHaveProperty("session");
    expect(carryForwardInboxDecisions(forged, stored)["session"]).toBe(stored["session"]);
    expect(carryForwardInboxDecisions(normalizeInboxItemMetadata({ source: "session" }), stored)["session"]).toBe(stored["session"]);
  });

  it("stamps the server-supplied session, drops pane and socket, and ignores a body's session for a local caller", async () => {
    const s = session();
    const filed = await requestInboxItem(db, {
      externalId: `${key}-stamp`,
      title: "Ship it?",
      content: "plan",
      metadata: { source: "session", pane: "w1:p1", socket: "/tmp/herdr.sock", session: randomUUID() },
      session: s,
    });
    expect(filed.session).toBe(s);
    const [item] = (await listInbox(db, { ids: [filed.id] })).items;
    expect(item).toMatchObject({ hangarSession: s, pane: null });

    const local = await requestInboxItem(db, { externalId: `${key}-local`, title: "Local", content: "x", metadata: { source: "session", session: "not even a uuid", pane: "w1:p2" } });
    expect(local.session).toBeNull();
    expect((await listInbox(db, { ids: [local.id] })).items[0]).toMatchObject({ hangarSession: null, pane: "w1:p2" });

    // A local re-request of the session's item keeps it bound to the session.
    const again = await requestInboxItem(db, { externalId: `${key}-stamp`, title: "Ship it?", content: "plan v2", metadata: { source: "session" } });
    expect(again.session).toBe(s);
  });

  it("appends exactly one message per decision and per release, with the decision's body", async () => {
    const s = await sessionNode("running");
    const card = { question: "Which?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] };
    const filed = await requestInboxItem(db, { externalId: `${key}-decide`, title: "Pick one", content: "x", metadata: { source: "session", ...card }, session: s });
    const decided = await decideInboxItem(db, filed.id, { decision: "accept", option: "b", message: " go " });
    expect(decided).toMatchObject({ session: s, endedSession: null, pane: null, after: "accepted" });
    const expectedText = inboxNotifyText({ id: filed.id, title: "Pick one", after: "accepted" }, "go", "b");
    expect(await messagesFor(s)).toEqual([
      { kind: "inbox_decision", body: { item_id: filed.id, title: "Pick one", decision: "accept", outcome: "accepted", option: "b", message: "go", text: expectedText } },
    ]);

    const s2 = await sessionNode("claimed");
    const held = await requestInboxItem(db, { externalId: `${key}-release`, title: "Read it", content: "x", metadata: { source: "github", url: "https://github.com/a/b/pull/9" }, session: s2 });
    expect(held.status).toBe("undigested");
    expect(await releaseInboxItem(db, held.id)).toMatchObject({ session: s2, after: "pending" });
    const released = await messagesFor(s2);
    expect(released).toHaveLength(1);
    expect(released[0]!.body).toMatchObject({ item_id: held.id, decision: "release", outcome: "pending", message: "", text: expect.stringContaining("Released") });
    expect(released[0]!.body).not.toHaveProperty("option");
  });

  it("tells the session on hand-off and clears it, so later decisions go to the local pane", async () => {
    const s = await sessionNode("running");
    const filed = await requestInboxItem(db, { externalId: `${key}-handoff`, title: "Deep one", content: "x", metadata: { source: "session" }, session: s });
    const handed = await handOffInboxItem(db, filed.id, { pane: "w9:p7", socket: "/tmp/herdr.sock", tab: "w9:t7" });
    expect(handed.session).toBe(s);
    const told = await messagesFor(s);
    expect(told).toHaveLength(1);
    expect(told[0]!.body).toMatchObject({ item_id: filed.id, decision: "session", outcome: "session", text: expect.stringContaining("stop work on it") });
    expect((await listInbox(db, { ids: [filed.id] })).items[0]).toMatchObject({ hangarSession: null, pane: "w9:p7" });

    // The local session re-queues its draft; the person's decision is the pane's, not a message.
    await requestInboxItem(db, { externalId: `${key}-handoff`, title: "Deep one", content: "draft", metadata: { source: "session", pane: "w9:p7", socket: "/tmp/herdr.sock" } });
    expect(await decideInboxItem(db, filed.id, { decision: "dismiss" })).toMatchObject({ session: null, pane: "w9:p7" });
    expect(await messagesFor(s)).toHaveLength(1);
  });

  it("refuses accept and send-back once the session has ended (stopped, failed, merged away, or gone), writing nothing", async () => {
    const survivor = await sessionNode("running");
    const merged = await sessionNode("running");
    await db.execute(sql`UPDATE nodes SET merged_into = ${survivor}::uuid WHERE id = ${merged}::uuid`);
    const ended: [string, string][] = [
      ["stopped", await sessionNode("stopped")],
      ["failed", await sessionNode("failed")],
      ["merged", merged],
      ["gone", session()],
    ];
    for (const [label, s] of ended) {
      const filed = await requestInboxItem(db, { externalId: `${key}-ended-${label}`, title: `Ended ${label}`, content: "x", metadata: { source: "session" }, session: s });
      expect(filed.session).toBe(s);
      const revisions = async () => Number((await db.execute<{ n: string }>(sql`SELECT count(*) AS n FROM node_revisions WHERE node_id = ${filed.id}::uuid`)).rows[0]!.n);
      const before = await revisions();
      for (const decision of ["accept", "changes"] as const) {
        const refused = await decideInboxItem(db, filed.id, { decision, message: "go" }).catch((e: unknown) => e);
        expect(refused, `${label} ${decision}`).toBeInstanceOf(InboxItemSessionEndedError);
        expect(refused, `${label} ${decision}`).toMatchObject({ nodeId: filed.id, sessionId: s });
      }
      expect(await revisions(), label).toBe(before);
      expect(await messagesFor(s), label).toEqual([]);
      // Still the remote session's, still in front of the person: never routed to a local executor.
      const [item] = (await listInbox(db, { ids: [filed.id] })).items;
      expect(item, label).toMatchObject({ status: "pending", hangarSession: s, feedback: [] });

      // Dismiss is the person's explicit choice: it works, sends nothing, and clears the session.
      expect(await decideInboxItem(db, filed.id, { decision: "dismiss" }), label).toMatchObject({ session: null, endedSession: s, after: "dismissed" });
      expect(await messagesFor(s), label).toEqual([]);
      expect((await listInbox(db, { ids: [filed.id], statuses: ["dismissed"] })).items[0], label).toMatchObject({ hangarSession: null });
    }
    expect(await messagesFor(survivor)).toEqual([]);

    // Release clears the session too; a later accept is then an ordinary local accept.
    const stopped = await sessionNode("stopped");
    const held = await requestInboxItem(db, { externalId: `${key}-ended-release`, title: "Held", content: "x", metadata: { source: "github", url: "https://github.com/a/b/pull/7" }, session: stopped });
    expect(await releaseInboxItem(db, held.id)).toMatchObject({ session: null, endedSession: stopped, after: "pending" });
    expect((await listInbox(db, { ids: [held.id] })).items[0]).toMatchObject({ status: "pending", hangarSession: null });
    expect(await decideInboxItem(db, held.id, { decision: "accept" })).toMatchObject({ session: null, endedSession: null, after: "accepted" });

    // Hand-off works and takes the item local.
    const handedOver = await requestInboxItem(db, { externalId: `${key}-ended-handoff`, title: "Deep", content: "x", metadata: { source: "session" }, session: stopped });
    expect(await handOffInboxItem(db, handedOver.id, { pane: "w9:p8", socket: "/tmp/herdr.sock", tab: "w9:t8" })).toMatchObject({ session: null });
    expect(await messagesFor(stopped)).toEqual([]);
    expect((await listInbox(db, { ids: [handedOver.id], statuses: ["session"] })).items[0]).toMatchObject({ hangarSession: null, pane: "w9:p8" });
  });

  it("rolls back a session-bound batch when a key its unlocked pre-read found absent was inserted before the upsert", async () => {
    const s = await sessionNode("running");
    const raced = `${key}-race`;
    const fresh = `${key}-race-fresh`;
    const keys = [raced, fresh].map((externalId) => ({ nodeType: INBOX_ITEM_NODE_TYPE, sourceSystem: "inbox", externalId }));
    // brain_write trims keys before the pre-read; the pre-read matches them trimmed either way.
    const absent = await assertSessionMayWriteInboxItems(db, s, [{ ...keys[0]!, externalId: ` ${raced} ` }, keys[1]!]);
    expect(absent.size).toBe(2);

    // A local pane files the same key between the read and the write.
    const local = await requestInboxItem(db, { externalId: raced, title: "Local ask", content: "mine", metadata: { source: "session", pane: "w1:p2", socket: "/tmp/herdr.sock" } });
    const batch = keys.map((k) => ({ ...k, title: "Taken", content: "x", metadata: normalizeInboxItemMetadata({ source: "session", session: s }) }));
    const refused = await upsertNodes(db, run, batch, { beforeCommit: (r) => assertSessionCreatedAbsentKeys(s, absent, r.rows) }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(InboxItemNotThisSessionError);
    expect(refused).toMatchObject({ nodeId: local.id, sessionId: s });

    // Nothing from the batch: the local item as it was, the fresh key never created.
    expect((await listInbox(db, { ids: [local.id] })).items[0]).toMatchObject({ title: "Local ask", hangarSession: null, pane: "w1:p2" });
    expect((await db.execute(sql`SELECT 1 FROM nodes WHERE source_system = 'inbox' AND external_id = ${fresh}`)).rows).toEqual([]);

    // Without a racing writer the same check passes and the batch commits.
    const clean = await assertSessionMayWriteInboxItems(db, s, [keys[1]!]);
    const written = await upsertNodes(db, run, [batch[1]!], { beforeCommit: (r) => assertSessionCreatedAbsentKeys(s, clean, r.rows) });
    expect(written.created).toBe(1);
  });

  it("appends nothing for a local item", async () => {
    const filed = await requestInboxItem(db, { externalId: `${key}-plain`, title: "Local ask", content: "x", metadata: { source: "session", pane: "w1:p3", socket: "/tmp/herdr.sock" } });
    expect(await decideInboxItem(db, filed.id, { decision: "accept" })).toMatchObject({ session: null, endedSession: null, pane: "w1:p3" });
    expect(await messagesAbout(filed.id)).toBe(0);
  });

  it("lets a session complete only its own items", async () => {
    const mine = await sessionNode("running");
    const filed = await requestInboxItem(db, { externalId: `${key}-complete`, title: "Do it", content: "x", metadata: { source: "session" }, session: mine });
    await decideInboxItem(db, filed.id, { decision: "accept" });
    await expect(completeInboxItem(db, filed.id, "done", { session: session() })).rejects.toThrow(InboxItemNotThisSessionError);
    const local = await requestInboxItem(db, { externalId: `${key}-complete-local`, title: "Local", content: "x", metadata: { source: "session" } });
    await decideInboxItem(db, local.id, { decision: "accept" });
    await expect(completeInboxItem(db, local.id, "done", { session: mine })).rejects.toThrow(InboxItemNotThisSessionError);
    await completeInboxItem(db, filed.id, "done", { session: mine.toUpperCase() });
    expect((await listInbox(db, { ids: [filed.id], statuses: ["done"] })).items).toHaveLength(1);
  });
});

// hangar-queue security review: a session-bound worker cannot take another
// session's (or a local pane's) item, and no agent write approves anything.
describe("a session-bound request cannot take an item it did not file", () => {
  const key = `session:takeover-${SRC}`;
  const sessions: string[] = [];
  const session = (): string => {
    const id = randomUUID();
    sessions.push(id);
    return id;
  };
  afterAll(async () => {
    await db.execute(sql`DELETE FROM nodes WHERE source_system = 'inbox' AND external_id LIKE ${`${key}%`}`);
    if (sessions.length > 0) await db.execute(sql`DELETE FROM hangar_messages WHERE session_id = ANY(${`{${sessions.join(",")}}`}::uuid[])`);
  });

  async function stored(id: string): Promise<{ content: string; metadata: Record<string, unknown> }> {
    return (await db.execute<{ content: string; metadata: Record<string, unknown> }>(sql`SELECT content, metadata FROM nodes WHERE id = ${id}::uuid`)).rows[0]!;
  }

  it("refuses worker A re-sending worker B's item, writing nothing", async () => {
    const a = session();
    const b = session();
    const filed = await requestInboxItem(db, { externalId: `${key}-b`, title: "B's ask", content: "B's draft", metadata: { source: "session" }, session: b });
    const before = await stored(filed.id);
    await expect(requestInboxItem(db, { externalId: `${key}-b`, title: "B's ask", content: "A's draft", metadata: { source: "session" }, session: a })).rejects.toThrow(InboxItemNotThisSessionError);
    expect(await stored(filed.id)).toEqual(before);
    expect(before.metadata["session"]).toBe(b);
  });

  it("refuses a worker re-sending a local pane's item, or an ingest's, writing nothing", async () => {
    const a = session();
    const pane = await requestInboxItem(db, { externalId: `${key}-pane`, title: "Local", content: "local draft", metadata: { source: "session", pane: "w1:p9", socket: "/tmp/herdr.sock" } });
    const before = await stored(pane.id);
    await expect(requestInboxItem(db, { externalId: `${key}-pane`, title: "Local", content: "taken", metadata: { source: "session" }, session: a })).rejects.toThrow(InboxItemNotThisSessionError);
    expect(await stored(pane.id)).toEqual(before);

    const ingested = await requestInboxItem(db, { externalId: `${key}-gmail`, title: "Mail", content: "reply draft", metadata: { source: "gmail" } });
    await expect(requestInboxItem(db, { externalId: `${key}-gmail`, title: "Mail", content: "taken", metadata: { source: "gmail" }, session: a })).rejects.toThrow(InboxItemNotThisSessionError);
    expect((await stored(ingested.id)).content).toBe("reply draft");
  });

  it("lets a worker re-send its own item", async () => {
    const a = session();
    const filed = await requestInboxItem(db, { externalId: `${key}-own`, title: "Mine", content: "v1", metadata: { source: "session" }, session: a });
    const again = await requestInboxItem(db, { externalId: `${key}-own`, title: "Mine", content: "v2", metadata: { source: "session" }, session: a.toUpperCase() });
    expect(again).toMatchObject({ id: filed.id, action: "updated", session: a });
    expect((await stored(filed.id)).content).toBe("v2");
  });
});

describe("no agent write approves its own item", () => {
  const key = `session:self-approve-${SRC}`;
  const forged = [{ decision: "accept", message: "looks good to me", at: "2026-01-01T00:00:00.000Z" }];
  afterAll(async () => {
    await db.execute(sql`DELETE FROM nodes WHERE source_system = 'inbox' AND external_id LIKE ${`${key}%`}`);
  });

  it("carry-forward: a new item is pending with no feedback, and a stored pending one is not moved to a person's status", () => {
    for (const status of ["accepted", "changes", "dismissed", "session", "done"]) {
      expect(carryForwardInboxDecisions(normalizeInboxItemMetadata({ source: "slack", status, feedback: forged }), null)).toMatchObject({ status: "pending", feedback: [] });
    }
    const pending = normalizeInboxItemMetadata({ source: "slack" });
    for (const status of ["accepted", "changes", "dismissed", "session"]) {
      expect(carryForwardInboxDecisions(normalizeInboxItemMetadata({ source: "slack", status, feedback: forged }), pending)).toMatchObject({ status: "pending", feedback: [] });
    }
    const accepted = normalizeInboxItemMetadata({ source: "slack", status: "accepted" });
    expect(carryForwardInboxDecisions(normalizeInboxItemMetadata({ source: "slack", status: "accepted" }), accepted)["status"]).toBe("accepted");
  });

  it("requestInboxItem: a new item sent as accepted is stored pending, a re-send as accepted stays pending, and body feedback is ignored", async () => {
    const filed = await requestInboxItem(db, { externalId: `${key}-new`, title: "Send it?", content: "draft", metadata: { source: "session", status: "accepted", feedback: forged } });
    expect(filed.status).toBe("pending");
    let [item] = (await listInbox(db, { ids: [filed.id] })).items;
    expect(item).toMatchObject({ status: "pending", feedback: [] });

    const again = await requestInboxItem(db, { externalId: `${key}-new`, title: "Send it?", content: "draft", metadata: { source: "session", status: "accepted", feedback: forged } });
    expect(again.status).toBe("pending");
    [item] = (await listInbox(db, { ids: [filed.id] })).items;
    expect(item).toMatchObject({ status: "pending", feedback: [] });

    // The person's decision is still the person's to make, and its feedback survives an agent's forged one.
    await decideInboxItem(db, filed.id, { decision: "changes", message: "shorter" });
    await requestInboxItem(db, { externalId: `${key}-new`, title: "Send it?", content: "short draft", metadata: { source: "session", status: "accepted", feedback: forged } });
    [item] = (await listInbox(db, { ids: [filed.id], statuses: ["changes"] })).items;
    expect(item!.feedback.map((f) => f.message)).toEqual(["shorter"]);
  });

  it("requestInboxItem ignores a malformed body feedback rather than refusing it", async () => {
    const filed = await requestInboxItem(db, { externalId: `${key}-junk`, title: "Junk", content: "x", metadata: { source: "session", feedback: "not an array" } });
    expect(filed.status).toBe("pending");
  });
});

// hangar-release: an agent asks for a session's outcome through an inbox
// item; only the person's decision sets it, in the decision's transaction.
describe("hangar outcome requests", () => {
  const AGENT = `${SRC}-agent`;
  const PERSON = `${SRC}-person`;
  const sessionNodes: string[] = [];
  /** A hangar session node written straight to the store (never queued, so no real hangar claims it). */
  async function sessionNode(state: string, extra: Record<string, unknown> = { disk_path: "/disks/test.img" }): Promise<string> {
    const result = await upsertNodes(db, run, [
      { nodeType: "hangar_session", sourceSystem: "hangar", externalId: randomUUID(), title: "Hangar headless session: test", metadata: { state, flavor: "headless", repo: "test/repo", claimed_by: `test-${SRC}`, ...extra } },
    ]);
    const id = result.rows[0]!.id;
    sessionNodes.push(id);
    return id;
  }
  const sessionMetadata = async (id: string): Promise<Record<string, unknown>> => (await db.execute<{ metadata: Record<string, unknown> }>(sql`SELECT metadata FROM nodes WHERE id = ${id}::uuid`)).rows[0]!.metadata;
  const itemOf = async (id: string) => (await listInbox(db, { ids: [id], statuses: ["pending", "accepted", "dismissed", "done"] })).items[0];
  const ask = (sessionId: string, outcome = "tabled") => requestHangarOutcome(db, { sessionId, outcome, note: "The PR merged; nothing left on the disk.", actor: AGENT });

  afterAll(async () => {
    if (sessionNodes.length > 0) {
      await db.execute(sql`DELETE FROM nodes WHERE source_system = 'inbox' AND external_id = ANY(${`{${sessionNodes.map((id) => `hangar-outcome:${id}`).join(",")}}`}::text[])`);
      await db.execute(sql`DELETE FROM nodes WHERE id = ANY(${`{${sessionNodes.join(",")}}`}::uuid[])`);
    }
    await db.execute(sql`DELETE FROM ingest_runs WHERE actor LIKE ${`${SRC}-%`}`);
  });

  it("files a pending item bound to the session with Accept and Table, setting no outcome", async () => {
    const id = await sessionNode("stopped");
    const filed = await ask(id);
    expect(filed).toMatchObject({ status: "pending", action: "created", sessionId: id, requested: "tabled", session: null });
    const item = await itemOf(filed.id);
    expect(item).toMatchObject({ status: "pending", source: "hangar", action: "hangar_outcome", recommend: "table", hangarOutcome: { sessionId: id, requested: "tabled" } });
    expect(item!.options.map((o) => o.id)).toEqual(["accept", "table"]);
    expect(item!.content).toContain("The PR merged");
    expect((await sessionMetadata(id))["outcome"]).toBeUndefined();
    expect((await listSessions(db, { releasable: true, limit: 200 })).sessions.map((s) => s.id)).not.toContain(id);

    // A repeat request while it waits updates the same item.
    const again = await ask(id, "accepted");
    expect(again).toMatchObject({ id: filed.id, status: "pending", requested: "accepted" });
    expect(await itemOf(filed.id)).toMatchObject({ recommend: "accept", hangarOutcome: { sessionId: id, requested: "accepted" } });
  });

  it("the person's Table sets the outcome, attributed to them, and closes the item done", async () => {
    const id = await sessionNode("failed");
    const filed = await ask(id, "accepted");
    const decided = await decideInboxItem(db, filed.id, { decision: "accept", option: "table" }, { actor: PERSON });
    expect(decided).toMatchObject({ after: "done", sessionOutcome: { sessionId: id, outcome: "tabled", changed: true } });
    expect(await sessionMetadata(id)).toMatchObject({ state: "failed", outcome: "tabled", outcome_by: PERSON });
    const [latest] = (await getNodeHistory(db, id)).revisions;
    expect(latest!.ingestRun).toMatchObject({ actor: PERSON, sourceSystem: "hangar" });
    expect((await itemOf(filed.id))!.feedback.at(-1)).toMatchObject({ decision: "accept", option: "table" });
    expect((await listSessions(db, { releasable: true, limit: 200 })).sessions.map((s) => s.id)).toContain(id);
  });

  it("a dismiss leaves the outcome unset", async () => {
    const id = await sessionNode("stopped");
    const filed = await ask(id);
    expect((await decideInboxItem(db, filed.id, { decision: "dismiss" }, { actor: PERSON })).sessionOutcome).toBeNull();
    expect((await sessionMetadata(id))["outcome"]).toBeUndefined();
  });

  it("refuses to file for a session that has not ended, or that hangar has released", async () => {
    for (const [state, extra] of [["running", {}], ["stopped", { outcome: "accepted" }]] as const) {
      const id = await sessionNode(state, extra);
      await expect(ask(id)).rejects.toBeInstanceOf(HangarOutcomeRefusedError);
      expect((await db.execute(sql`SELECT 1 FROM nodes WHERE source_system = 'inbox' AND external_id = ${`hangar-outcome:${id}`}`)).rows).toEqual([]);
    }
    await expect(requestHangarOutcome(db, { sessionId: await sessionNode("stopped"), outcome: "shelved", note: "x", actor: AGENT })).rejects.toBeInstanceOf(InvalidInboxItemError);
    await expect(requestHangarOutcome(db, { sessionId: await sessionNode("stopped"), outcome: "tabled", note: " ", actor: AGENT })).rejects.toBeInstanceOf(InvalidInboxItemError);
  });

  it("fails the decision, writing nothing, when the session can no longer take the outcome", async () => {
    const id = await sessionNode("stopped");
    const filed = await ask(id);
    // Hangar released it after another path tabled it: an outcome and no disk.
    await upsertNodes(db, run, [{ nodeType: "hangar_session", sourceSystem: "hangar", externalId: (await db.execute<{ external_id: string }>(sql`SELECT external_id FROM nodes WHERE id = ${id}::uuid`)).rows[0]!.external_id, title: "Hangar headless session: test", metadata: { state: "stopped", flavor: "headless", repo: "test/repo", claimed_by: `test-${SRC}`, outcome: "tabled" } }]);
    const refused = await decideInboxItem(db, filed.id, { decision: "accept", option: "accept" }, { actor: PERSON }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(HangarOutcomeRefusedError);
    expect((refused as Error).message).toContain("already released");
    expect(await itemOf(filed.id)).toMatchObject({ status: "pending", feedback: [] });
    expect((await sessionMetadata(id))["outcome"]).toBe("tabled");
  });

  it("no other writer binds or rebinds an item: an incoming hangar_outcome is dropped and the stored one kept", async () => {
    const id = await sessionNode("stopped");
    const binding = { session_id: id, requested: "tabled" };
    expect(carryForwardInboxDecisions(normalizeInboxItemMetadata({ source: "agent", hangar_outcome: binding }), null)["hangar_outcome"]).toBeUndefined();
    expect(() => normalizeInboxItemMetadata({ source: "agent", hangar_outcome: { session_id: "S", requested: "tabled" } })).toThrow(/hangar_outcome/);

    const key = `session:outcome-${SRC}`;
    const forged = await requestInboxItem(db, { externalId: key, title: "Table it", content: "", metadata: { source: "agent", hangar_outcome: binding }, actor: AGENT });
    expect((await itemOf(forged.id))!.hangarOutcome).toBeNull();
    await db.execute(sql`DELETE FROM nodes WHERE source_system = 'inbox' AND external_id = ${key}`);

    const filed = await ask(id);
    const other = await sessionNode("stopped");
    const rewrite = requestInboxItem(db, { externalId: `hangar-outcome:${id}`, title: "Rewritten", content: "", metadata: { source: "agent", hangar_outcome: { session_id: other, requested: "accepted" } }, actor: AGENT });
    await expect(rewrite).rejects.toBeInstanceOf(ReservedInboxItemError);
    expect(await itemOf(filed.id)).toMatchObject({ title: `Table hangar session ${id.slice(0, 8)} (repo "test/repo")`, hangarOutcome: { sessionId: id, requested: "tabled" } });
  });

  /** An item written straight to the store under `inbox`, as no generic writer can any more (a stand-in for a bypass or a legacy row). */
  async function rawInboxItem(externalId: string, metadata: Record<string, unknown>, title = "Raw"): Promise<string> {
    const written = await upsertNodes(db, run, [{ nodeType: INBOX_ITEM_NODE_TYPE, sourceSystem: "inbox", externalId, title, content: "raw", metadata: normalizeInboxItemMetadata(metadata) }]);
    return written.rows[0]!.id;
  }
  const rowCount = async (externalId: string) => (await db.execute(sql`SELECT 1 FROM nodes WHERE source_system = 'inbox' AND external_id = ${externalId}`)).rows.length;

  it("requestInboxItem refuses any hangar-outcome: key, session-bound or not, writing nothing", async () => {
    const id = await sessionNode("stopped");
    const key = `hangar-outcome:${id}`;
    const card = { source: "agent", question: "Accept or table this hangar session?", options: HANGAR_OUTCOME_OPTIONS, recommend: "accept" };
    await expect(requestInboxItem(db, { externalId: key, title: "Accept", content: "Safe to click.", metadata: card, actor: AGENT })).rejects.toBeInstanceOf(ReservedInboxItemError);
    // A session token pre-creating its own session's key, to be bound later, is refused the same way.
    await expect(requestInboxItem(db, { externalId: key, title: "Accept", content: "Safe", metadata: card, actor: `session-${id}`, session: id })).rejects.toBeInstanceOf(ReservedInboxItemError);
    await expect(requestInboxItem(db, { externalId: ` ${key} `, title: "Accept", content: "x", metadata: card, actor: AGENT })).rejects.toBeInstanceOf(ReservedInboxItemError);
    expect(await rowCount(key)).toBe(0);
    expect(() => assertNoHangarOutcomeKeys([{ sourceSystem: "inbox", externalId: "hangar-outcome:anything" }])).toThrow(ReservedInboxItemError);
    expect(() => assertNoHangarOutcomeKeys([{ sourceSystem: "agent", externalId: "hangar-outcome:anything" }, { sourceSystem: "inbox", externalId: "session:x" }])).not.toThrow();

    // And the agent's own request then files a clean one.
    const filed = await ask(id, "accepted");
    expect(filed).toMatchObject({ action: "created", session: null });
  });

  it("a generic writer is refused on a stored item carrying a binding, whatever its key", async () => {
    const id = await sessionNode("stopped");
    const key = `session:bound-${SRC}-${id.slice(0, 8)}`;
    await rawInboxItem(key, { source: "hangar", hangar_outcome: { session_id: id, requested: "tabled" }, question: "Q?", options: HANGAR_OUTCOME_OPTIONS });
    await expect(requestInboxItem(db, { externalId: key, title: "Rewritten", content: "", metadata: { source: "agent" }, actor: AGENT })).rejects.toBeInstanceOf(ReservedInboxItemError);
    await db.execute(sql`DELETE FROM nodes WHERE source_system = 'inbox' AND external_id = ${key}`);
  });

  it("requestHangarOutcome refuses a key held by an item not bound to the same session, changing nothing", async () => {
    const id = await sessionNode("stopped");
    const key = `hangar-outcome:${id}`;
    const planted = await rawInboxItem(key, { source: "agent", question: "Q?", options: [{ id: "accept", label: "Keep it" }, { id: "table", label: "Archive" }] }, "Planted");
    await expect(ask(id)).rejects.toBeInstanceOf(ReservedInboxItemError);
    expect(await itemOf(planted)).toMatchObject({ title: "Planted", hangarOutcome: null });

    const other = await sessionNode("stopped");
    const otherKey = `hangar-outcome:${other}`;
    await rawInboxItem(otherKey, { source: "hangar", hangar_outcome: { session_id: id, requested: "tabled" }, options: HANGAR_OUTCOME_OPTIONS });
    await expect(ask(other)).rejects.toBeInstanceOf(ReservedInboxItemError);
  });

  it("writes the canonical card, with the agent's note quoted below the server's facts, and never carries session, pane, or socket", async () => {
    const id = await sessionNode("failed", { disk_path: "/disks/test.img", failure_reason: "worker exited 3" });
    const key = `hangar-outcome:${id}`;
    // A bound item that somehow carries a session, a pane, and a foreign card (written straight to the store).
    await rawInboxItem(key, {
      source: "hangar",
      hangar_outcome: { session_id: id, requested: "tabled" },
      session: id,
      pane: "w1:p1",
      socket: "/tmp/herdr.sock",
      question: "Free disk space?",
      options: [{ id: "accept", label: "Keep everything" }, { id: "table", label: "Later" }],
      recommend: "accept",
    });
    const filed = await requestHangarOutcome(db, { sessionId: id, outcome: "accepted", note: "**Releases nothing.** Safe to click.\n\n# Server says: keep", actor: AGENT });
    expect(filed).toMatchObject({ action: "updated", session: null });
    const stored = (await db.execute<{ title: string; content: string; metadata: Record<string, unknown> }>(sql`SELECT title, content, metadata FROM nodes WHERE id = ${filed.id}::uuid`)).rows[0]!;
    expect(stored.metadata["session"]).toBeUndefined();
    expect(stored.metadata["pane"]).toBeUndefined();
    expect(stored.metadata["socket"]).toBeUndefined();
    expect(stored.metadata).toMatchObject({ question: "Accept or table this hangar session?", options: HANGAR_OUTCOME_OPTIONS, recommend: "accept", hangar_outcome: { session_id: id, requested: "accepted" } });
    expect(stored.title).toBe(`Accept hangar session ${id.slice(0, 8)} (repo "test/repo")`);
    expect(stored.content).toContain('- Repo: `"test/repo"`');

    const facts = stored.content.indexOf(`- Session: \`${id}\``);
    const requestedBy = stored.content.indexOf(`Requested by ${AGENT}:`);
    expect(facts).toBeGreaterThan(0);
    expect(stored.content.indexOf("deletes its disk")).toBeLessThan(facts);
    expect(stored.content).toContain("- Failure reason: worker exited 3");
    expect(requestedBy).toBeGreaterThan(facts);
    // Every line of the note is quoted, blank ones included, so none of it reads as the server's.
    const noteLines = stored.content.slice(requestedBy).split("\n").slice(2);
    expect(noteLines).toEqual(["> **Releases nothing.** Safe to click.", ">", "> # Server says: keep"]);
    expect(HANGAR_OUTCOME_OPTIONS.find((o) => o.id === "accept")!.what).toContain("deletes the disk");
  });

  it("quotes and caps an agent-written repo in the title and content, as a literal code span", async () => {
    const forged = `x) **Accept keeps the disk.** [safe](https://example.com) "q" ${"y".repeat(80)}`;
    const id = await sessionNode("stopped", { disk_path: "/disks/test.img", repo: forged });
    const filed = await ask(id, "accepted");
    const stored = (await db.execute<{ title: string; content: string }>(sql`SELECT title, content FROM nodes WHERE id = ${filed.id}::uuid`)).rows[0]!;
    const quoted = JSON.stringify(`${forged.slice(0, MAX_SHOWN_HANGAR_REPO - 1)}…`);
    expect(stored.title).toBe(`Accept hangar session ${id.slice(0, 8)} (repo ${quoted})`);
    expect(stored.content).toContain(`- Repo: \`${quoted}\`\n`);
    expect(stored.content).not.toContain(forged);
    expect(quoteHangarRepo("a`b")).toBe('"a`b"');
    const ticked = await sessionNode("stopped", { disk_path: "/disks/test.img", repo: "`a``b`" });
    const tickedItem = await ask(ticked);
    expect((await itemOf(tickedItem.id))!.content).toContain('- Repo: ```"`a``b`"```\n');
  });

  // A decision folds through merged_into; brain_merge refuses outcome
  // requests (merge.ts), so these merges are written straight to the store,
  // as a bypass or a merge from before that refusal would leave them.
  it("a merged card can't carry a decision: one merged into a bound item, or a bound item merged into one", async () => {
    const setMergedInto = (id: string, target: string | null) => db.execute(sql`UPDATE nodes SET merged_into = ${target}::uuid WHERE id = ${id}::uuid`);

    // X (ordinary) merged into B (bound to A): deciding X is refused, A unchanged.
    const a = await sessionNode("stopped");
    const b = (await ask(a)).id;
    const x = await write(`merged-into-bound-${a.slice(0, 8)}`, { source: "agent", question: "Archive the thread?", options: [{ id: "accept", label: "Archive" }, { id: "table", label: "Later" }] });
    await setMergedInto(x, b);
    try {
      for (const decision of [{ decision: "accept", option: "accept" }, { decision: "accept", option: "table" }, { decision: "dismiss" }] as const) {
        const refused = await decideInboxItem(db, x, decision, { actor: PERSON }).catch((e: unknown) => e);
        expect(refused).toBeInstanceOf(InboxCardChangedError);
        expect((refused as InboxCardChangedError).mergedInto).toBe(b);
      }
      await expect(releaseInboxItem(db, x, {}, { actor: PERSON })).rejects.toBeInstanceOf(InboxCardChangedError);
      await expect(handOffInboxItem(db, x, { pane: "w9:p1", socket: "/tmp/herdr.sock", tab: "w9:t1" })).rejects.toBeInstanceOf(InboxCardChangedError);
      expect((await sessionMetadata(a))["outcome"]).toBeUndefined();
      expect(await itemOf(b)).toMatchObject({ status: "pending", feedback: [] });
      // The card the person did see still decides: the canonical id works.
      const decided = await decideInboxItem(db, b, { decision: "accept", option: "table" }, { actor: PERSON });
      expect(decided.sessionOutcome).toMatchObject({ sessionId: a, outcome: "tabled" });
    } finally {
      await setMergedInto(x, null);
    }

    // B2 (bound to A2) merged into Y (ordinary): deciding B2 is refused, nothing executed.
    const a2 = await sessionNode("stopped");
    const b2 = (await ask(a2, "accepted")).id;
    const y = await write(`bound-merged-into-${a2.slice(0, 8)}`, { source: "agent", question: "Send it?", options: [{ id: "accept", label: "Send" }, { id: "table", label: "Later" }] });
    await setMergedInto(b2, y);
    try {
      const refused = await decideInboxItem(db, b2, { decision: "accept", option: "accept" }, { actor: PERSON }).catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(InboxCardChangedError);
      expect((refused as InboxCardChangedError).mergedInto).toBe(y);
      expect((await sessionMetadata(a2))["outcome"]).toBeUndefined();
      const [yItem] = (await listInbox(db, { ids: [y] })).items;
      expect(yItem).toMatchObject({ status: "pending", feedback: [] });
    } finally {
      await setMergedInto(b2, null);
    }
    expect(await itemOf(b2)).toMatchObject({ status: "pending", feedback: [] });
  });

  it("carry-forward pins a bound card to the stored one", () => {
    const binding = { session_id: randomUUID(), requested: "tabled" };
    const stored = normalizeInboxItemMetadata({ source: "hangar", hangar_outcome: binding, question: "Accept or table this hangar session?", options: HANGAR_OUTCOME_OPTIONS, recommend: "table" });
    const incoming = normalizeInboxItemMetadata({ source: "agent", question: "Keep the disk?", options: [{ id: "accept", label: "Keep" }, { id: "table", label: "Later" }], recommend: "accept", on_accept: ["nothing happens"] });
    const merged = carryForwardInboxDecisions(incoming, stored);
    expect(merged).toMatchObject({ question: stored["question"], options: HANGAR_OUTCOME_OPTIONS, recommend: "table", hangar_outcome: binding });
    expect(merged["on_accept"]).toBeUndefined();
    // An unbound item's card is the writer's, as before.
    const unbound = carryForwardInboxDecisions(incoming, normalizeInboxItemMetadata({ source: "agent", question: "Old?" }));
    expect(unbound).toMatchObject({ question: "Keep the disk?", recommend: "accept" });
  });

  it("an accept is refused on relabelled options, setting no outcome", async () => {
    const id = await sessionNode("stopped");
    const relabelled = HANGAR_OUTCOME_OPTIONS.map((o) => (o.id === "table" ? { ...o, label: "Keep the disk" } : o));
    const item = await rawInboxItem(`hangar-outcome:${id}`, { source: "hangar", hangar_outcome: { session_id: id, requested: "tabled" }, question: "Q?", options: relabelled, recommend: "table" });
    await expect(decideInboxItem(db, item, { decision: "accept", option: "table" }, { actor: PERSON })).rejects.toBeInstanceOf(InboxCardChangedError);
    expect((await sessionMetadata(id))["outcome"]).toBeUndefined();
    expect(await itemOf(item)).toMatchObject({ status: "pending", feedback: [] });
  });
});
