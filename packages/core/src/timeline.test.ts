// Database tests for `getTimeline` (timeline-view change, task 2.2;
// knowledge-store spec, "A node's timed neighbours are readable in time
// order"). Every fixture carries this file's own unique source system (or
// its `-other` twin, for the source-system narrowing), every test prefixes
// its external ids with a fresh `fx()`, and nothing here is asserted
// store-wide — other suites write to the same database concurrently.
// Times are written through `normalizeOccurredAt`, as every writer does,
// except in the one test that documents what a bypassed value does.

import { eq, inArray } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@breakdown/db";
import { edges, ingestRuns, nodes } from "@breakdown/db";
import { upsertEdges } from "./edges.js";
import { InvalidListOptionError, InvalidLookupIdError, InvalidLookupOptionError, NodeNotFoundError } from "./errors.js";
import { normalizeOccurredAt } from "./event-time.js";
import { openIngestRun, type IngestRunHandle } from "./ingest-runs.js";
import { MAX_LIST_NAMES } from "./list.js";
import { mergeNodes } from "./merge.js";
import { upsertNodes } from "./nodes.js";
import { connectTestDb, type TestPool, uniqueSuffix } from "./test-helpers.js";
import { buildGetTimelineQuery, DEFAULT_TIMELINE_LIMIT, getTimeline, MAX_TIMELINE_LIMIT, type TimelineCursor, type TimelineRow } from "./timeline.js";
import { CHILD_OF_EDGE_TYPE } from "./work-items.js";

const SRC = `timeline-test-${uniqueSuffix()}`;
const OTHER_SRC = `${SRC}-other`;
const NO_NODE_ID = "00000000-0000-4000-8000-000000000000";

let pool: TestPool;
let db: Database;
let run: IngestRunHandle;
const openRuns: string[] = [];

/** A unique prefix per test so fixtures never collide across tests in this file. */
const fx = () => `fx-${uniqueSuffix()}`;

async function writeNode(externalId: string, nodeType: string, metadata: Record<string, unknown> = {}, sourceSystem = SRC): Promise<string> {
  const result = await upsertNodes(db, run, [
    { nodeType, sourceSystem, externalId, title: `${nodeType} ${externalId}`, content: `content of ${externalId}`, metadata: normalizeOccurredAt(metadata) },
  ]);
  const row = result.rows[0];
  if (!row) throw new Error("fixture insert returned no row");
  return row.id;
}

/** A node with an event time, written through the contract. */
const timed = (externalId: string, nodeType: string, occurredAt: string, extra: Record<string, unknown> = {}, sourceSystem = SRC) =>
  writeNode(externalId, nodeType, { ...extra, occurred_at: occurredAt }, sourceSystem);

async function link(srcId: string, dstId: string, edgeType: string, weight?: number): Promise<void> {
  await upsertEdges(db, run, [{ srcId, dstId, edgeType, sourceSystem: SRC, weight }]);
}

const ids = (rows: readonly TimelineRow[]): string[] => rows.map((r) => r.id);

/** The error `promise` rejects with, asserted to be a `cls` naming `option`. */
async function rejectedOption(promise: Promise<unknown>, cls: new (...args: never[]) => { option: string }, option: string): Promise<void> {
  let thrown: unknown;
  try {
    await promise;
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(cls);
  expect((thrown as { option: string }).option).toBe(option);
}

beforeAll(async () => {
  ({ pool, db } = connectTestDb());
  run = await openIngestRun(db, SRC, { actor: "timeline-suite" });
  openRuns.push(run.id);
});

afterAll(async () => {
  await db.delete(edges).where(eq(edges.sourceSystem, SRC));
  await db.delete(nodes).where(inArray(nodes.sourceSystem, [SRC, OTHER_SRC]));
  await db.delete(ingestRuns).where(inArray(ingestRuns.id, openRuns));
  await pool.end();
});

describe("getTimeline", () => {
  it("lists timed neighbours newest first, ties broken by node id ascending, each row with its time, metadata, and relation and never content", async () => {
    const p = fx();
    const anchor = await writeNode(`${p}/repo`, "repo");
    const march = await timed(`${p}/march`, "gh-issue", "2026-03-01T00:00:00Z", { number: 1 });
    const juneA = await timed(`${p}/june-a`, "gh-issue", "2026-06-01T00:00:00Z");
    const juneB = await timed(`${p}/june-b`, "gh-issue", "2026-06-01T00:00:00Z");
    const september = await timed(`${p}/september`, "gh-issue", "2026-09-01T00:00:00Z");
    for (const id of [march, juneA, juneB, september]) await link(id, anchor, "belongs-to", 0.75);
    const [firstJune, secondJune] = [juneA, juneB].sort();

    const result = await getTimeline(db, anchor);
    expect(result.anchorId).toBe(anchor);
    expect(ids(result.rows)).toEqual([september, firstJune, secondJune, march]);
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
    expect(result.untimedCount).toBe(0);

    expect(result.rows[3]).toEqual({
      id: march,
      nodeType: "gh-issue",
      sourceSystem: SRC,
      externalId: `${p}/march`,
      title: `gh-issue ${p}/march`,
      occurredAt: "2026-03-01T00:00:00.000Z",
      metadata: { number: 1, occurred_at: "2026-03-01T00:00:00.000Z" },
      edgeType: "belongs-to",
      direction: "incoming",
      weight: 0.75,
    });
    for (const row of result.rows) {
      expect(row).not.toHaveProperty("content");
    }

    // Identical requests answer identically — the order is total.
    const again = await getTimeline(db, anchor);
    expect(ids(again.rows)).toEqual(ids(result.rows));
  });

  it("lists a node joined by two edges once, with the heaviest edge's type and direction; equal weights tie by type name (spec: Newest first, one row per node)", async () => {
    const p = fx();
    const anchor = await writeNode(`${p}/repo`, "repo");
    const single = await timed(`${p}/single`, "gh-issue", "2026-01-03T00:00:00Z");
    const doubly = await timed(`${p}/doubly`, "gh-issue", "2026-01-02T00:00:00Z");
    const tied = await timed(`${p}/tied`, "gh-issue", "2026-01-01T00:00:00Z");
    await link(single, anchor, "belongs-to", 0.75);
    // doubly: an incoming belongs-to at 0.75 and an outgoing mentions at 0.5.
    // (Weights float4 holds exactly — edges.weight is `real`.)
    await link(doubly, anchor, "belongs-to", 0.75);
    await link(anchor, doubly, "mentions", 0.5);
    // tied: two edges of equal weight — the lesser type name wins.
    await link(tied, anchor, "zeta", 0.5);
    await link(anchor, tied, "alpha", 0.5);

    const result = await getTimeline(db, anchor);
    expect(result.rows).toHaveLength(3);
    expect(ids(result.rows)).toEqual([single, doubly, tied]);
    expect(result.rows[1]).toMatchObject({ id: doubly, edgeType: "belongs-to", direction: "incoming", weight: 0.75 });
    expect(result.rows[2]).toMatchObject({ id: tied, edgeType: "alpha", direction: "outgoing", weight: 0.5 });
  });

  it("lists neighbours reached by an outgoing edge and by an incoming edge alike, each with its direction as seen from the anchor", async () => {
    const p = fx();
    const anchor = await writeNode(`${p}/epic`, "work_item", { status: "open" });
    const child = await timed(`${p}/child`, "work_item", "2026-02-01T00:00:00Z", { status: "open" });
    const blocker = await timed(`${p}/blocker`, "work_item", "2026-02-02T00:00:00Z", { status: "open" });
    await link(child, anchor, CHILD_OF_EDGE_TYPE, 1);
    await link(anchor, blocker, "blocks", 1);

    const result = await getTimeline(db, anchor);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({ id: blocker, edgeType: "blocks", direction: "outgoing" });
    expect(result.rows[1]).toMatchObject({ id: child, edgeType: CHILD_OF_EDGE_TYPE, direction: "incoming" });
  });

  it("excludes a neighbour without the key and counts it (spec: Untimed neighbours are counted); an anchor with only untimed neighbours answers no rows and the count", async () => {
    const p = fx();
    const anchor = await writeNode(`${p}/repo`, "repo");
    const timedIds = await Promise.all([1, 2, 3].map((i) => timed(`${p}/issue-${i}`, "gh-issue", `2026-0${i}-01T00:00:00Z`)));
    const file = await writeNode(`${p}/readme.md`, "file", { path: "readme.md" });
    for (const id of [...timedIds, file]) await link(id, anchor, "belongs-to");

    const result = await getTimeline(db, anchor);
    expect(result.rows).toHaveLength(3);
    expect(ids(result.rows)).not.toContain(file);
    expect(result.untimedCount).toBe(1);

    const bare = await writeNode(`${p}/bare`, "repo");
    const untimedA = await writeNode(`${p}/untimed-a`, "file");
    const untimedB = await writeNode(`${p}/untimed-b`, "file");
    await link(untimedA, bare, CHILD_OF_EDGE_TYPE);
    await link(untimedB, bare, CHILD_OF_EDGE_TYPE);
    const nothingTimed = await getTimeline(db, bare);
    expect(nothingTimed).toEqual({ anchorId: bare, rows: [], hasMore: false, nextCursor: null, untimedCount: 2 });

    // No neighbours at all is the same shape with zero.
    const lonely = await writeNode(`${p}/lonely`, "repo");
    expect(await getTimeline(db, lonely)).toEqual({ anchorId: lonely, rows: [], hasMore: false, nextCursor: null, untimedCount: 0 });
  });

  it("narrows by node type and by source system, the untimed count narrowed the same way (spec: Narrowing by type)", async () => {
    const p = fx();
    const anchor = await writeNode(`${p}/repo`, "repo");
    const issueA = await timed(`${p}/issue-a`, "gh-issue", "2026-05-01T00:00:00Z");
    const issueB = await timed(`${p}/issue-b`, "gh-issue", "2026-04-01T00:00:00Z");
    const issueUntimed = await writeNode(`${p}/issue-untimed`, "gh-issue");
    const item = await timed(`${p}/item`, "work_item", "2026-03-01T00:00:00Z", { status: "open" });
    const itemUntimed = await writeNode(`${p}/item-untimed`, "work_item", { status: "open" });
    const fileUntimed = await writeNode(`${p}/file`, "file");
    const other = await timed(`${p}/other`, "gh-issue", "2026-06-01T00:00:00Z", {}, OTHER_SRC);
    const otherUntimed = await writeNode(`${p}/other-untimed`, "gh-issue", {}, OTHER_SRC);
    for (const id of [issueA, issueB, issueUntimed, item, itemUntimed, fileUntimed, other, otherUntimed]) await link(id, anchor, "belongs-to");

    const all = await getTimeline(db, anchor);
    expect(ids(all.rows)).toEqual([other, issueA, issueB, item]);
    expect(all.untimedCount).toBe(4);

    const issues = await getTimeline(db, anchor, { nodeTypes: ["gh-issue"] });
    expect(ids(issues.rows)).toEqual([other, issueA, issueB]);
    expect(issues.untimedCount).toBe(2);

    const items = await getTimeline(db, anchor, { nodeTypes: ["work_item"] });
    expect(ids(items.rows)).toEqual([item]);
    expect(items.untimedCount).toBe(1);

    const both = await getTimeline(db, anchor, { nodeTypes: ["work_item", "gh-issue"] });
    expect(ids(both.rows)).toEqual([other, issueA, issueB, item]);
    expect(both.untimedCount).toBe(3);

    const files = await getTimeline(db, anchor, { nodeTypes: ["file"] });
    expect(files.rows).toEqual([]);
    expect(files.untimedCount).toBe(1);

    const otherOnly = await getTimeline(db, anchor, { sourceSystems: [OTHER_SRC] });
    expect(ids(otherOnly.rows)).toEqual([other]);
    expect(otherOnly.untimedCount).toBe(1);

    const thisSrcIssues = await getTimeline(db, anchor, { nodeTypes: ["gh-issue"], sourceSystems: [SRC] });
    expect(ids(thisSrcIssues.rows)).toEqual([issueA, issueB]);
    expect(thisSrcIssues.untimedCount).toBe(1);

    const none = await getTimeline(db, anchor, { nodeTypes: ["no-such-type"] });
    expect(none).toEqual({ anchorId: anchor, rows: [], hasMore: false, nextCursor: null, untimedCount: 0 });
  });

  it("folds a merged-away alias of the anchor: an edge attached to the loser counts for the survivor, and the loser's id answers the survivor's timeline (spec: Merged alias of the anchor)", async () => {
    const p = fx();
    const survivor = await writeNode(`${p}/repo`, "repo");
    const loser = await writeNode(`${p}/repo-dup`, "repo");
    const viaSurvivor = await timed(`${p}/issue-1`, "gh-issue", "2026-01-01T00:00:00Z");
    const viaLoser = await timed(`${p}/issue-2`, "gh-issue", "2026-02-01T00:00:00Z");
    await link(viaSurvivor, survivor, "belongs-to");
    await link(viaLoser, loser, "belongs-to");

    expect(ids((await getTimeline(db, survivor)).rows)).toEqual([viaSurvivor]);

    await mergeNodes(db, loser, survivor, run);

    const merged = await getTimeline(db, survivor);
    expect(merged.anchorId).toBe(survivor);
    expect(ids(merged.rows)).toEqual([viaLoser, viaSurvivor]);
    expect(merged.untimedCount).toBe(0);

    const byLoserId = await getTimeline(db, loser);
    expect(byLoserId.anchorId).toBe(survivor);
    expect(ids(byLoserId.rows)).toEqual([viaLoser, viaSurvivor]);
  });

  it("folds a merged-away neighbour onto its survivor — reported once, with the survivor's time and metadata, the heaviest of the folded edges", async () => {
    const p = fx();
    const anchor = await writeNode(`${p}/repo`, "repo");
    const survivor = await timed(`${p}/issue`, "gh-issue", "2026-03-01T00:00:00Z", { number: 7 });
    const loser = await timed(`${p}/issue-dup`, "gh-issue", "2026-04-01T00:00:00Z", { number: 7, dup: true });
    await link(loser, anchor, "belongs-to", 0.75);
    await link(anchor, survivor, "mentions", 0.25);

    const before = await getTimeline(db, anchor);
    expect(ids(before.rows)).toEqual([loser, survivor]);

    await mergeNodes(db, loser, survivor, run);

    const after = await getTimeline(db, anchor);
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0]).toMatchObject({
      id: survivor,
      occurredAt: "2026-03-01T00:00:00.000Z",
      metadata: { number: 7, occurred_at: "2026-03-01T00:00:00.000Z" },
      edgeType: "belongs-to",
      direction: "incoming",
      weight: 0.75,
    });
    expect(after.untimedCount).toBe(0);
  });

  it("excludes the merge-induced self-loop from the rows and from the untimed count", async () => {
    const p = fx();
    const survivor = await timed(`${p}/epic`, "work_item", "2026-01-01T00:00:00Z", { status: "open" });
    const loser = await timed(`${p}/epic-dup`, "work_item", "2026-01-02T00:00:00Z", { status: "open" });
    const child = await timed(`${p}/child`, "work_item", "2026-01-03T00:00:00Z", { status: "open" });
    await link(loser, survivor, CHILD_OF_EDGE_TYPE);
    await link(child, loser, CHILD_OF_EDGE_TYPE);

    await mergeNodes(db, loser, survivor, run);

    const result = await getTimeline(db, survivor);
    expect(ids(result.rows)).toEqual([child]);
    expect(result.untimedCount).toBe(0);

    // A survivor that itself carries no time: the folded self-loop must
    // not be counted as an untimed neighbour either.
    const bareSurvivor = await writeNode(`${p}/bare`, "repo");
    const bareLoser = await writeNode(`${p}/bare-dup`, "repo");
    await link(bareLoser, bareSurvivor, "same-as");
    await mergeNodes(db, bareLoser, bareSurvivor, run);
    expect(await getTimeline(db, bareSurvivor)).toEqual({ anchorId: bareSurvivor, rows: [], hasMore: false, nextCursor: null, untimedCount: 0 });
  });

  it("walks every page through nextCursor with no row repeated or skipped, across ties on the time (spec: Paging)", async () => {
    const p = fx();
    const anchor = await writeNode(`${p}/repo`, "repo");
    // Seven timed neighbours over three instants, so page cuts fall among ties.
    const times = ["2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z", "2026-02-01T00:00:00Z", "2026-03-01T00:00:00Z", "2026-03-01T00:00:00Z"];
    const neighbours = await Promise.all(times.map((t, i) => timed(`${p}/n${i}`, "gh-issue", t)));
    const untimed = await writeNode(`${p}/untimed`, "file");
    for (const id of [...neighbours, untimed]) await link(id, anchor, "belongs-to");

    const groundTruth = await getTimeline(db, anchor, { limit: DEFAULT_TIMELINE_LIMIT });
    expect(groundTruth.rows).toHaveLength(7);
    expect(groundTruth.hasMore).toBe(false);

    const collected: string[] = [];
    let cursor: TimelineCursor | null = null;
    let pages = 0;
    for (;;) {
      const page = await getTimeline(db, anchor, { limit: 3, cursor });
      expect(page.untimedCount).toBe(1); // the same on every page
      collected.push(...ids(page.rows));
      pages += 1;
      if (!page.hasMore) {
        expect(page.nextCursor).toBeNull();
        break;
      }
      expect(page.rows).toHaveLength(3);
      const last = page.rows[2]!;
      expect(page.nextCursor).toEqual({ occurredAt: last.occurredAt, id: last.id });
      cursor = page.nextCursor;
      if (pages > 7) throw new Error("pagination did not terminate");
    }

    expect(pages).toBe(3);
    expect(collected).toHaveLength(7);
    expect(new Set(collected).size).toBe(7);
    expect(collected).toEqual(ids(groundTruth.rows));

    // A page that ends exactly at the last row reports no more.
    const exact = await getTimeline(db, anchor, { limit: 7 });
    expect(exact.hasMore).toBe(false);
    expect(exact.nextCursor).toBeNull();
    const cut = await getTimeline(db, anchor, { limit: 6 });
    expect(cut.hasMore).toBe(true);
    expect(cut.rows).toHaveLength(6);
  });

  it("sorts a value written past the contract as text (design.md's first risk, documented): the read never parses, so a zoned string lands where its characters fall, and a JSON null under the key counts as no time", async () => {
    const p = fx();
    const anchor = await writeNode(`${p}/repo`, "repo");
    const nine = await timed(`${p}/nine`, "gh-issue", "2026-03-04T09:00:00Z");
    const eleven = await timed(`${p}/eleven`, "gh-issue", "2026-03-04T11:00:00Z");
    // Raw upsertNodes, no normalizer: the instant is 08:00Z, the oldest of
    // the three, but its text starts "2026-03-04T10" and sorts between the
    // other two. Every real writer runs normalizeOccurredAt; only a test
    // can do this. The null is the other bypass: the contract deletes the
    // key for null, so only a raw write leaves one under it.
    const bypassed = await upsertNodes(db, run, [
      { nodeType: "gh-issue", sourceSystem: SRC, externalId: `${p}/bypassed`, title: "bypassed", content: "", metadata: { occurred_at: "2026-03-04T10:00:00+02:00" } },
      { nodeType: "gh-issue", sourceSystem: SRC, externalId: `${p}/null-under-key`, title: "null under key", content: "", metadata: { occurred_at: null } },
    ]);
    const raw = bypassed.rows.find((r) => r.externalId === `${p}/bypassed`)!.id;
    const nullUnderKey = bypassed.rows.find((r) => r.externalId === `${p}/null-under-key`)!.id;
    for (const id of [nine, eleven, raw, nullUnderKey]) await link(id, anchor, "belongs-to");

    const result = await getTimeline(db, anchor);
    expect(ids(result.rows)).toEqual([eleven, raw, nine]);
    expect(result.rows[1]!.occurredAt).toBe("2026-03-04T10:00:00+02:00");
    // The null is neither listed (it would lead the page under DESC with no
    // time, and mint a cursor the read rejects) nor silent: it is counted.
    expect(ids(result.rows)).not.toContain(nullUnderKey);
    expect(result.untimedCount).toBe(1);

    // The cursor carries the text as the row held it, so paging across the
    // bypassed row still repeats and skips nothing.
    const first = await getTimeline(db, anchor, { limit: 1 });
    const second = await getTimeline(db, anchor, { limit: 1, cursor: first.nextCursor });
    expect(second.nextCursor).toEqual({ occurredAt: "2026-03-04T10:00:00+02:00", id: raw });
    const third = await getTimeline(db, anchor, { limit: 1, cursor: second.nextCursor });
    expect([...ids(first.rows), ...ids(second.rows), ...ids(third.rows)]).toEqual([eleven, raw, nine]);
    expect(third.hasMore).toBe(false);
  });

  it("throws NodeNotFoundError for a well-formed id that names no node (spec: Unknown anchor)", async () => {
    await expect(getTimeline(db, NO_NODE_ID)).rejects.toBeInstanceOf(NodeNotFoundError);
  });

  it("rejects a malformed anchor, a bad limit, a bad cursor, and a bad name list before any SQL runs (spec: Malformed anchor)", async () => {
    let executed = 0;
    const spy = {
      execute: async () => {
        executed += 1;
        return { rows: [] };
      },
    } as unknown as Database;

    await expect(getTimeline(spy, "not-a-uuid")).rejects.toBeInstanceOf(InvalidLookupIdError);
    await expect(getTimeline(spy, "")).rejects.toBeInstanceOf(InvalidLookupIdError);
    await expect(getTimeline(spy, undefined as unknown as string)).rejects.toBeInstanceOf(InvalidLookupIdError);

    for (const limit of [0, -1, 1.5, MAX_TIMELINE_LIMIT + 1, Number.NaN]) {
      await rejectedOption(getTimeline(spy, NO_NODE_ID, { limit }), InvalidLookupOptionError, "limit");
    }

    const badCursors: unknown[] = [{}, { occurredAt: "", id: NO_NODE_ID }, { occurredAt: "2026-01-01T00:00:00.000Z", id: "not-a-uuid" }, { occurredAt: 5, id: NO_NODE_ID }, "cursor"];
    for (const cursor of badCursors) {
      await rejectedOption(getTimeline(spy, NO_NODE_ID, { cursor: cursor as TimelineCursor }), InvalidLookupOptionError, "cursor");
    }

    const tooMany = Array.from({ length: MAX_LIST_NAMES + 1 }, (_, i) => `t${i}`);
    await rejectedOption(getTimeline(spy, NO_NODE_ID, { nodeTypes: tooMany }), InvalidListOptionError, "nodeTypes");
    await rejectedOption(getTimeline(spy, NO_NODE_ID, { sourceSystems: tooMany }), InvalidListOptionError, "sourceSystems");
    await rejectedOption(getTimeline(spy, NO_NODE_ID, { nodeTypes: [] }), InvalidListOptionError, "nodeTypes");
    await rejectedOption(getTimeline(spy, NO_NODE_ID, { sourceSystems: [""] }), InvalidListOptionError, "sourceSystems");

    expect(executed).toBe(0);
  });

  it("buildGetTimelineQuery is pure, one statement, and binds every parameter", () => {
    const dialect = new PgDialect();
    const base = { anchorId: NO_NODE_ID, nodeTypes: null, sourceSystems: null, limit: DEFAULT_TIMELINE_LIMIT, cursor: null };
    const a = dialect.sqlToQuery(buildGetTimelineQuery(base));
    const b = dialect.sqlToQuery(buildGetTimelineQuery(base));
    expect(a.sql).toBe(b.sql);
    expect(a.params).toEqual(b.params);
    expect(a.sql).not.toContain(";");
    expect(a.params).toContain(NO_NODE_ID);
    expect(a.params).toContain(DEFAULT_TIMELINE_LIMIT + 1);
    expect(a.params).toContain("occurred_at");
    expect(a.sql).toContain("NULL::text[]");
    expect(a.sql).toContain("NULL::text IS NULL");
    expect(a.sql).toContain("NULL::uuid");
    expect(a.sql).toContain("rn.other_id <> (SELECT canonical_id FROM self)");
    expect(a.sql).toContain("DISTINCT ON (f.node_id)");

    const cursor: TimelineCursor = { occurredAt: "2026-03-04T08:00:00.000Z", id: "9f1c2b3a-4d5e-4f60-8a71-0b2c3d4e5f60" };
    const narrowed = dialect.sqlToQuery(buildGetTimelineQuery({ anchorId: NO_NODE_ID, nodeTypes: ["gh-issue", "work_item"], sourceSystems: ["github"], limit: 3, cursor }));
    expect(narrowed.sql).not.toContain("NULL::text");
    expect(narrowed.sql).not.toContain("NULL::uuid");
    expect(narrowed.params).toEqual(expect.arrayContaining([NO_NODE_ID, "gh-issue", "work_item", "github", cursor.occurredAt, cursor.id, 4]));
    // Names and cursor values are parameters, never spliced into the text.
    for (const value of ["gh-issue", "work_item", "github", cursor.occurredAt, cursor.id]) {
      expect(narrowed.sql).not.toContain(value);
    }
  });
});
