import { inArray } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@breakdown/db";
import { ingestRuns, nodeRevisions, nodes } from "@breakdown/db";
import { InvalidLookupIdError, InvalidLookupOptionError, NodeNotFoundError } from "./errors.js";
import { buildNodeHistoryQuery, getNodeHistory, MAX_HISTORY_LIMIT } from "./history.js";
import { openIngestRun, type IngestRunHandle, type OpenIngestRunOptions } from "./ingest-runs.js";
import { mergeNodes } from "./merge.js";
import { upsertNodes, type NodeInput } from "./nodes.js";
import { connectTestDb, type TestPool, uniqueSuffix } from "./test-helpers.js";

/**
 * Integration tests for getNodeHistory over the real trigger-written
 * `node_revisions` rows (knowledge-store spec, "A node's history is
 * readable with what changed"). Every test writes through the real write
 * path (upsertNodes / mergeNodes) under its own unique source system so
 * the trigger, not the test, produces the revisions being read.
 */

let pool: TestPool;
let db: Database;
const openRunIds: string[] = [];
const usedSourceSystems: string[] = [];

beforeAll(() => {
  ({ pool, db } = connectTestDb());
});

afterEach(async () => {
  if (usedSourceSystems.length > 0) {
    // One DELETE per source system removes losers and survivors together;
    // merged_into's FK is checked at statement end, and node_revisions
    // cascades.
    await db.delete(nodes).where(inArray(nodes.sourceSystem, usedSourceSystems));
    usedSourceSystems.length = 0;
  }
  if (openRunIds.length > 0) {
    await db.delete(ingestRuns).where(inArray(ingestRuns.id, openRunIds));
    openRunIds.length = 0;
  }
});

afterAll(async () => {
  await pool.end();
});

const BOGUS_ID = "00000000-0000-0000-0000-000000000000";

/** One fixture source system per test, shared by every run that test opens, so a later run's re-write hits the same (source_system, external_id) row. */
function newSourceSystem(): string {
  const sourceSystem = `history-test-${uniqueSuffix()}`;
  usedSourceSystems.push(sourceSystem);
  return sourceSystem;
}

async function newRun(sourceSystem: string, options?: OpenIngestRunOptions): Promise<IngestRunHandle> {
  const run = await openIngestRun(db, sourceSystem, options);
  openRunIds.push(run.id);
  return run;
}

async function writeOne(run: IngestRunHandle, sourceSystem: string, spec: Omit<NodeInput, "sourceSystem">): Promise<string> {
  const result = await upsertNodes(db, run, [{ ...spec, sourceSystem }]);
  const id = result.rows[0]?.id;
  if (!id) throw new Error("setup failed to upsert node");
  return id;
}

/** Wraps `db.execute` to count how many statements `fn` actually sends — retrieval.test.ts's device for proving "rejected before any SQL runs". */
async function countExecuteCalls<T>(fn: () => Promise<T>): Promise<{ result: T; count: number }> {
  const original = db.execute.bind(db);
  let count = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (db as any).execute = (...args: unknown[]) => {
    count += 1;
    return (original as (...a: unknown[]) => unknown)(...args);
  };
  try {
    const result = await fn();
    return { result, count };
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any).execute = original;
  }
}

// --- buildNodeHistoryQuery: pure function ------------------------------------

describe("buildNodeHistoryQuery", () => {
  const dialect = new PgDialect();

  it("is pure: identical params produce identical SQL text and params", () => {
    const params = { id: BOGUS_ID, limit: 5, before: 7, includeContent: true };
    const a = dialect.sqlToQuery(buildNodeHistoryQuery(params));
    const b = dialect.sqlToQuery(buildNodeHistoryQuery(params));
    expect(a.sql).toBe(b.sql);
    expect(a.params).toEqual(b.params);
  });

  it("contains no semicolon — it is exactly one statement", () => {
    const { sql: text } = dialect.sqlToQuery(buildNodeHistoryQuery({ id: BOGUS_ID, limit: 20, before: null, includeContent: false }));
    expect(text).not.toContain(";");
  });

  it("reads node_revisions and never resolved_nodes — history is per node as stored, not merge-folded", () => {
    const { sql: text } = dialect.sqlToQuery(buildNodeHistoryQuery({ id: BOGUS_ID, limit: 20, before: null, includeContent: false }));
    expect(text).toContain("node_revisions");
    expect(text).not.toContain("resolved_nodes");
  });
});

// --- getNodeHistory -------------------------------------------------------------

describe("getNodeHistory", () => {
  it("writing the same batch twice under two runs leaves every node with exactly one revision (spec: unchanged re-load)", async () => {
    const sourceSystem = newSourceSystem();
    const batch: NodeInput[] = [1, 2, 3].map((i) => ({
      nodeType: "doc",
      sourceSystem,
      externalId: `n${i}`,
      title: `Title ${i}`,
      content: `content ${i}`,
      metadata: { i },
    }));

    const runA = await newRun(sourceSystem);
    const first = await upsertNodes(db, runA, batch);
    const runB = await newRun(sourceSystem);
    const second = await upsertNodes(db, runB, batch);
    expect(second.unchanged).toBe(3);

    const ids = first.rows.map((r) => r.id);
    for (const id of ids) {
      const history = await getNodeHistory(db, id);
      expect(history.revisions).toHaveLength(1);
      expect(history.revisions[0]?.ingestRun.id).toBe(runA.id);
      expect(history.hasMore).toBe(false);
    }
    // Belt and braces, straight from the table: three nodes, three rows.
    const rows = await db.select({ id: nodeRevisions.id }).from(nodeRevisions).where(inArray(nodeRevisions.nodeId, ids));
    expect(rows).toHaveLength(3);
  });

  it("a metadata status flip reports only metadata changed, names status with before open and after closed, and leaves an untouched key out (spec: reading a status change)", async () => {
    const sourceSystem = newSourceSystem();
    const runA = await newRun(sourceSystem, { actor: "ingest:beads" });
    const id = await writeOne(runA, sourceSystem, {
      nodeType: "work_item",
      externalId: "wi-1",
      title: "Fix login",
      content: "The login form rejects valid passwords.",
      metadata: { status: "open", priority: "high" },
    });

    const runB = await newRun(sourceSystem, { actor: "human" });
    await writeOne(runB, sourceSystem, {
      nodeType: "work_item",
      externalId: "wi-1",
      title: "Fix login",
      content: "The login form rejects valid passwords.",
      metadata: { status: "closed", priority: "high" },
    });

    const history = await getNodeHistory(db, id);
    expect(history.nodeId).toBe(id);
    expect(history.hasMore).toBe(false);
    expect(history.nextBefore).toBeNull();
    expect(history.revisions.map((r) => r.revisionNo)).toEqual([2, 1]);

    const [newest, first] = history.revisions;
    expect(newest?.changedFields).toEqual(["metadata"]);
    expect(newest?.metadataChanges).toEqual({ status: { before: "open", after: "closed" } });
    expect(newest?.metadata).toEqual({ status: "closed", priority: "high" });
    expect(newest?.ingestRun).toEqual({ id: runB.id, sourceSystem, actor: "human" });
    expect(newest?.title).toBe("Fix login");
    expect(newest?.contentHash).toBe(first?.contentHash);
    expect(newest?.recordedAt).toBeInstanceOf(Date);
    expect(newest!.recordedAt.getTime()).toBeGreaterThanOrEqual(first!.recordedAt.getTime());
    expect(first?.ingestRun).toEqual({ id: runA.id, sourceSystem, actor: "ingest:beads" });

    // A key added and a key removed in one revision: the absent side reads
    // as null (see MetadataKeyChange).
    const runC = await newRun(sourceSystem, { actor: "human" });
    await writeOne(runC, sourceSystem, {
      nodeType: "work_item",
      externalId: "wi-1",
      title: "Fix login",
      content: "The login form rejects valid passwords.",
      metadata: { status: "closed", assignee: "caleb" },
    });
    const third = (await getNodeHistory(db, id)).revisions[0];
    expect(third?.revisionNo).toBe(3);
    expect(third?.changedFields).toEqual(["metadata"]);
    expect(third?.metadataChanges).toEqual({
      assignee: { before: null, after: "caleb" },
      priority: { before: "high", after: null },
    });
  });

  it("the first revision lists nodeType, title, content, and metadata as changed, and mergedInto only once set", async () => {
    const sourceSystem = newSourceSystem();
    const run = await newRun(sourceSystem);
    const id = await writeOne(run, sourceSystem, { nodeType: "doc", externalId: "d1", title: "A", content: "c", metadata: { a: 1 } });
    // Empty title/content are still values (NOT NULL columns), so they are
    // present — and reported — on a first revision too.
    const bare = await writeOne(run, sourceSystem, { nodeType: "doc", externalId: "d2" });
    const survivor = await writeOne(run, sourceSystem, { nodeType: "doc", externalId: "d3", title: "S" });

    const created = (await getNodeHistory(db, id)).revisions[0];
    expect(created?.revisionNo).toBe(1);
    expect(created?.changedFields).toEqual(["nodeType", "title", "content", "metadata"]);
    expect(created?.metadataChanges).toEqual({ a: { before: null, after: 1 } });
    expect(created?.mergedInto).toBeNull();

    const bareCreated = (await getNodeHistory(db, bare)).revisions[0];
    expect(bareCreated?.changedFields).toEqual(["nodeType", "title", "content", "metadata"]);
    expect(bareCreated?.title).toBe("");
    expect(bareCreated?.metadataChanges).toEqual({});

    const mergingRun = await newRun(sourceSystem);
    await mergeNodes(db, id, survivor, mergingRun);
    const merged = (await getNodeHistory(db, id)).revisions[0];
    expect(merged?.revisionNo).toBe(2);
    expect(merged?.changedFields).toEqual(["mergedInto"]);
    expect(merged?.mergedInto).toBe(survivor);
    expect(merged?.metadataChanges).toEqual({});
  });

  it("content is absent by default but contentHash is present; includeContent returns it (spec: reading history without content)", async () => {
    const sourceSystem = newSourceSystem();
    const run = await newRun(sourceSystem);
    const big = "x".repeat(5000);
    const id = await writeOne(run, sourceSystem, { nodeType: "doc", externalId: "big", title: "Big", content: big });

    const withoutContent = await getNodeHistory(db, id);
    const revision = withoutContent.revisions[0]!;
    expect("content" in revision).toBe(false);
    expect(typeof revision.contentHash).toBe("string");
    expect(revision.contentHash.length).toBeGreaterThan(0);

    const withContent = await getNodeHistory(db, id, { includeContent: true });
    expect(withContent.revisions[0]?.content).toBe(big);
  });

  it("a title-only change reports title changed and content unchanged, even though contentHash covers both", async () => {
    const sourceSystem = newSourceSystem();
    const runA = await newRun(sourceSystem);
    const id = await writeOne(runA, sourceSystem, { nodeType: "doc", externalId: "t", title: "Old title", content: "same body" });
    const runB = await newRun(sourceSystem);
    await writeOne(runB, sourceSystem, { nodeType: "doc", externalId: "t", title: "New title", content: "same body" });

    const [newest, first] = (await getNodeHistory(db, id)).revisions;
    expect(newest?.changedFields).toEqual(["title"]);
    expect(newest?.contentHash).not.toBe(first?.contentHash);
  });

  it("paging a six-revision history with limit 4 returns 6..3 then 2..1 with no repeat or gap, and the oldest revision on the first page reports only what actually changed (spec: paging through a long history)", async () => {
    const sourceSystem = newSourceSystem();
    const run = await newRun(sourceSystem);
    let id = "";
    for (let i = 1; i <= 6; i += 1) {
      id = await writeOne(run, sourceSystem, { nodeType: "doc", externalId: "p", title: "P", content: `v${i}` });
    }

    const page1 = await getNodeHistory(db, id, { limit: 4 });
    expect(page1.revisions.map((r) => r.revisionNo)).toEqual([6, 5, 4, 3]);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextBefore).toBe(3);
    // Revision 3 is the oldest on this page but not the oldest overall:
    // its predecessor (revision 2) is outside the page, and it must still
    // be compared against it — the LAG-before-page guarantee.
    expect(page1.revisions[3]?.changedFields).toEqual(["content"]);

    const page2 = await getNodeHistory(db, id, { limit: 4, before: page1.nextBefore });
    expect(page2.revisions.map((r) => r.revisionNo)).toEqual([2, 1]);
    expect(page2.hasMore).toBe(false);
    expect(page2.nextBefore).toBeNull();
    expect(page2.revisions[1]?.changedFields).toEqual(["nodeType", "title", "content", "metadata"]);

    // A page that exactly exhausts the remainder is not "more".
    const exact = await getNodeHistory(db, id, { limit: 2, before: 3 });
    expect(exact.revisions.map((r) => r.revisionNo)).toEqual([2, 1]);
    expect(exact.hasMore).toBe(false);

    const past = await getNodeHistory(db, id, { before: 1 });
    expect(past.revisions).toEqual([]);
    expect(past.hasMore).toBe(false);
    expect(past.nextBefore).toBeNull();
  });

  it("a merged-away node returns its own revisions including the merge revision, attributed to the merging run, not its survivor's", async () => {
    const sourceSystem = newSourceSystem();
    const runA = await newRun(sourceSystem, { actor: "ingest:github" });
    const survivor = await writeOne(runA, sourceSystem, { nodeType: "doc", externalId: "s", title: "Survivor", content: "s" });
    const loser = await writeOne(runA, sourceSystem, { nodeType: "doc", externalId: "l", title: "Loser", content: "l" });

    const runB = await newRun(sourceSystem, { actor: "claude-code 2.1.0" });
    await mergeNodes(db, loser, survivor, runB);

    const history = await getNodeHistory(db, loser);
    expect(history.nodeId).toBe(loser);
    expect(history.revisions.map((r) => r.revisionNo)).toEqual([2, 1]);
    const [merge, created] = history.revisions;
    expect(merge?.changedFields).toEqual(["mergedInto"]);
    expect(merge?.mergedInto).toBe(survivor);
    expect(merge?.title).toBe("Loser");
    expect(merge?.ingestRun).toEqual({ id: runB.id, sourceSystem, actor: "claude-code 2.1.0" });
    expect(created?.ingestRun).toEqual({ id: runA.id, sourceSystem, actor: "ingest:github" });

    // The survivor was not written by the merge.
    const survivorHistory = await getNodeHistory(db, survivor);
    expect(survivorHistory.revisions).toHaveLength(1);
  });

  it("an id naming no node throws NodeNotFoundError carrying that id; a malformed id throws InvalidLookupIdError (spec: history of an unknown node)", async () => {
    let thrown: unknown;
    try {
      await getNodeHistory(db, BOGUS_ID);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(NodeNotFoundError);
    expect((thrown as NodeNotFoundError).nodeId).toBe(BOGUS_ID);
    expect((thrown as NodeNotFoundError).message).toContain(BOGUS_ID);

    await expect(getNodeHistory(db, "not-a-uuid")).rejects.toBeInstanceOf(InvalidLookupIdError);
    await expect(getNodeHistory(db, "")).rejects.toBeInstanceOf(InvalidLookupIdError);
  });

  it("limit 0, limit above MAX_HISTORY_LIMIT, and before 0 each throw InvalidLookupOptionError naming the option before any SQL runs", async () => {
    const sourceSystem = newSourceSystem();
    const run = await newRun(sourceSystem);
    const id = await writeOne(run, sourceSystem, { nodeType: "doc", externalId: "opt", title: "O", content: "o" });

    const cases: { options: Parameters<typeof getNodeHistory>[2]; option: string }[] = [
      { options: { limit: 0 }, option: "limit" },
      { options: { limit: -1 }, option: "limit" },
      { options: { limit: 1.5 }, option: "limit" },
      { options: { limit: MAX_HISTORY_LIMIT + 1 }, option: "limit" },
      { options: { limit: 2147483647 }, option: "limit" },
      { options: { before: 0 }, option: "before" },
      { options: { before: -3 }, option: "before" },
      { options: { before: 2.5 }, option: "before" },
      { options: { before: 2147483648 }, option: "before" },
    ];
    for (const { options, option } of cases) {
      const { result: rejection, count } = await countExecuteCalls(() => getNodeHistory(db, id, options).catch((err: unknown) => err));
      expect(rejection, JSON.stringify(options)).toBeInstanceOf(InvalidLookupOptionError);
      expect((rejection as InvalidLookupOptionError).option).toBe(option);
      expect(count, JSON.stringify(options)).toBe(0);
    }

    // The ceiling itself is accepted.
    await expect(getNodeHistory(db, id, { limit: MAX_HISTORY_LIMIT })).resolves.toBeDefined();
  });
});
