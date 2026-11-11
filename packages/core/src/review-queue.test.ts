// DB-backed tests for `listPendingReviews` (review-queue, task 2.2).
//
// Isolation: every test uses its own project keys and this suite's own
// source system, and reads back only rows of those projects, so nothing
// asserts a store-wide count or the absence of another suite's rows. The
// queue is one store-wide window ordered by request time, so fixtures carry
// `occurred_at` instants far in the past (years 1000-1001) to sit inside any
// window a test reads; the cap tests use the oldest of all (1000-01), which
// only this file writes, and each test's work items are deleted after it so
// one test's rows never occupy another's window. Rows of this file left by a
// crashed run (its source-system and project-key prefixes, older than
// STALE_AFTER so a concurrent run is untouched) are deleted before the suite.
// Assertions on a limited read never assume which rows are oldest store-wide. The router suite
// (apps/web/server/routers/board.test.ts) writes a few at 1000-06, after
// the cap fixtures and before everything else here.

import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@breakdown/db";
import { ingestRuns, nodes } from "@breakdown/db";
import { InvalidLookupOptionError } from "./errors.js";
import { closeIngestRun, openIngestRun, type IngestRunHandle } from "./ingest-runs.js";
import { upsertEdges } from "./edges.js";
import { mergeNodes } from "./merge.js";
import { upsertNodes } from "./nodes.js";
import { listPendingReviews, MAX_PENDING_REVIEWS, MAX_REVIEW_SUMMARY_LINE_LENGTH, type PendingReviews } from "./review-queue.js";
import { connectTestDb, type TestPool, uniqueSuffix } from "./test-helpers.js";

const SUFFIX = uniqueSuffix().slice(0, 10);
const SRC_PREFIX = "review-queue-test-";
const KEY_PREFIX = "rvq-";
const SRC = `${SRC_PREFIX}${SUFFIX}`;
const STALE_AFTER = "10 minutes";

let pool: TestPool;
let db: Database;
let run: IngestRunHandle;
let beadsRun: IngestRunHandle;
let testNo = 0;
const registered: string[] = [];
const extraRunIds: string[] = [];

async function register(...keys: string[]): Promise<void> {
  registered.push(...keys);
  await upsertNodes(
    db,
    beadsRun,
    keys.map((k) => ({ nodeType: "beads_project", sourceSystem: "beads", externalId: `project:${k}`, title: k, content: "", metadata: { project: k, path: `/tmp/${k}` } })),
  );
}

beforeAll(async () => {
  ({ pool, db } = connectTestDb());
  await db.execute(sql`DELETE FROM nodes WHERE source_system LIKE ${`${SRC_PREFIX}%`} AND updated_at < now() - ${STALE_AFTER}::interval`);
  await db.execute(sql`DELETE FROM nodes WHERE source_system = 'beads' AND external_id LIKE ${`project:${KEY_PREFIX}%`} AND updated_at < now() - ${STALE_AFTER}::interval`);
  await db.execute(sql`
    DELETE FROM ingest_runs ir
    WHERE ir.source_system LIKE ${`${SRC_PREFIX}%`} AND ir.started_at < now() - ${STALE_AFTER}::interval
      AND NOT EXISTS (SELECT 1 FROM nodes n WHERE n.ingest_run_id = ir.id)
      AND NOT EXISTS (SELECT 1 FROM node_revisions v WHERE v.ingest_run_id = ir.id)
      AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.ingest_run_id = ir.id)`);
  run = await openIngestRun(db, SRC, { actor: "review-queue-test" });
  beadsRun = await openIngestRun(db, "beads", { actor: "review-queue-test" });
});

afterEach(async () => {
  await db.delete(nodes).where(eq(nodes.sourceSystem, SRC));
});

afterAll(async () => {
  await closeIngestRun(db, run);
  await closeIngestRun(db, beadsRun);
  await db.delete(nodes).where(eq(nodes.sourceSystem, SRC));
  await db.delete(nodes).where(and(eq(nodes.sourceSystem, "beads"), inArray(nodes.externalId, registered.map((k) => `project:${k}`))));
  await db.delete(ingestRuns).where(inArray(ingestRuns.id, [run.id, beadsRun.id, ...extraRunIds]));
  await pool.end();
});

/** Fresh project keys for one test: `a` and `b` registered, `u` not. */
async function scope() {
  testNo += 1;
  const tag = `${SUFFIX}-${testNo}`;
  const keys = { a: `${KEY_PREFIX}a-${tag}`, b: `${KEY_PREFIX}b-${tag}`, u: `${KEY_PREFIX}u-${tag}`, tag };
  await register(keys.a, keys.b);
  return keys;
}

interface Spec {
  ext: string;
  project: string;
  /** Omitted: written without a status key. */
  status?: string;
  labels?: unknown;
  review?: unknown;
  /** Omitted: written without `occurred_at`. */
  occurredAt?: string;
  title?: string;
}

/** Writes work items in one batch; returns external id -> node id. */
async function items(specs: Spec[]): Promise<Map<string, string>> {
  const result = await upsertNodes(
    db,
    run,
    specs.map((s) => ({
      nodeType: "work_item",
      sourceSystem: SRC,
      externalId: s.ext,
      title: s.title ?? s.ext,
      content: "",
      metadata: {
        project: s.project,
        priority: 2,
        labels: "labels" in s ? s.labels : ["review"],
        ...(s.status !== undefined ? { status: s.status } : {}),
        ...("review" in s ? { review: s.review } : {}),
        ...(s.occurredAt !== undefined ? { occurred_at: s.occurredAt } : {}),
      },
    })),
  );
  return new Map(result.rows.map((r) => [r.externalId, r.id]));
}

function mine(queue: PendingReviews, ...projects: string[]) {
  return queue.reviews.filter((r) => projects.includes(r.project));
}

describe("listPendingReviews membership", () => {
  it("lists open reviews of registered projects, oldest request first, across projects", async () => {
    const { a, b, tag } = await scope();
    const ids = await items([
      { ext: `${tag}-third`, project: a, status: "open", occurredAt: "1001-01-03T00:00:00.000Z" },
      { ext: `${tag}-first`, project: b, status: "in_progress", occurredAt: "1001-01-01T00:00:00.000Z" },
      { ext: `${tag}-second`, project: a, occurredAt: "1001-01-02T00:00:00.000Z" },
    ]);

    const queue = await listPendingReviews(db);
    const rows = mine(queue, a, b);

    expect(rows.map((r) => r.externalId)).toEqual([`${tag}-first`, `${tag}-second`, `${tag}-third`]);
    expect(rows[0]).toMatchObject({ id: ids.get(`${tag}-first`), project: b, title: `${tag}-first`, requestedAt: new Date("1001-01-01T00:00:00.000Z") });
    expect(queue.total).toBeGreaterThanOrEqual(3);
  });

  it("leaves out sent-back, closed, near-miss labels, and unregistered projects", async () => {
    const { a, u, tag } = await scope();
    const at = "1001-02-01T00:00:00.000Z";
    await items([
      { ext: `${tag}-pending`, project: a, status: "open", occurredAt: at },
      { ext: `${tag}-sentback`, project: a, status: "open", labels: ["review", "review:changes"], occurredAt: at },
      { ext: `${tag}-closed`, project: a, status: "closed", occurredAt: at },
      { ext: `${tag}-changes-only`, project: a, status: "open", labels: ["review:changes"], occurredAt: at },
      { ext: `${tag}-reviewed`, project: a, status: "open", labels: ["reviewed"], occurredAt: at },
      { ext: `${tag}-string-label`, project: a, status: "open", labels: "review", occurredAt: at },
      { ext: `${tag}-no-labels`, project: a, status: "open", labels: [], occurredAt: at },
      { ext: `${tag}-unregistered`, project: u, status: "open", occurredAt: at },
    ]);
    // A review-labelled node that is not a work item is not a review.
    await upsertNodes(db, run, [
      { nodeType: "note", sourceSystem: SRC, externalId: `${tag}-note`, title: "note", content: "", metadata: { project: a, labels: ["review"], occurred_at: at } },
    ]);

    const rows = mine(await listPendingReviews(db), a, u);

    expect(rows.map((r) => r.externalId)).toEqual([`${tag}-pending`]);
  });

  it("folds a merged-away review into its survivor", async () => {
    const { a, tag } = await scope();
    const ids = await items([
      { ext: `${tag}-survivor`, project: a, status: "open", occurredAt: "1001-03-02T00:00:00.000Z" },
      { ext: `${tag}-loser`, project: a, status: "open", occurredAt: "1001-03-01T00:00:00.000Z" },
      { ext: `${tag}-plain`, project: a, status: "open", labels: ["ui"], occurredAt: "1001-03-03T00:00:00.000Z" },
      { ext: `${tag}-into-plain`, project: a, status: "open", occurredAt: "1001-03-04T00:00:00.000Z" },
    ]);
    const mergeRun = await openIngestRun(db, SRC, { actor: "review-queue-test-merge" });
    try {
      await mergeNodes(db, ids.get(`${tag}-loser`)!, ids.get(`${tag}-survivor`)!, mergeRun);
      await mergeNodes(db, ids.get(`${tag}-into-plain`)!, ids.get(`${tag}-plain`)!, mergeRun);
    } finally {
      await closeIngestRun(db, mergeRun);
      extraRunIds.push(mergeRun.id);
    }

    const rows = mine(await listPendingReviews(db), a);

    expect(rows.map((r) => r.id)).toEqual([ids.get(`${tag}-survivor`)]);
  });

  it("creates, changes, and deletes nothing", async () => {
    const { a, tag } = await scope();
    await items([{ ext: `${tag}-r`, project: a, status: "open", occurredAt: "1001-04-01T00:00:00.000Z" }]);
    const snapshot = async () =>
      (await db.execute(sql`SELECT id, updated_at, metadata FROM nodes WHERE source_system = ${SRC} ORDER BY id`)).rows;
    const before = await snapshot();

    await listPendingReviews(db);

    expect(await snapshot()).toEqual(before);
  });
});

describe("listPendingReviews row fields", () => {
  it("carries the summary's first line, cut to the line cap, and the image count", async () => {
    const { a, tag } = await scope();
    const at = "1001-05-01T00:00:00.000Z";
    const images = ["/home/u/.local/share/breakdown/reviews/p/r/01-a.png", "/home/u/.local/share/breakdown/reviews/p/r/02-b.png"];
    await items([
      { ext: `${tag}-multi`, project: a, status: "open", occurredAt: at, review: { images, pane: "w1:p2", summary: "  Board header\nSecond line\nThird" } },
      { ext: `${tag}-long`, project: a, status: "open", occurredAt: "1001-05-02T00:00:00.000Z", review: { images: [], pane: null, summary: "x".repeat(300) } },
      { ext: `${tag}-empty`, project: a, status: "open", occurredAt: "1001-05-03T00:00:00.000Z", review: { images: [], pane: null, summary: "" } },
    ]);

    const rows = mine(await listPendingReviews(db), a);

    expect(rows.map((r) => [r.externalId, r.summaryLine, r.imageCount])).toEqual([
      [`${tag}-multi`, "Board header", 2],
      [`${tag}-long`, "x".repeat(MAX_REVIEW_SUMMARY_LINE_LENGTH), 0],
      [`${tag}-empty`, null, 0],
    ]);
  });

  it("carries a card's question as the line, its first line when it has several, and the summary's for a legacy review", async () => {
    const { a, tag } = await scope();
    const images = ["/home/u/.local/share/breakdown/reviews/p/r/01-a.png"];
    await items([
      {
        ext: `${tag}-card`,
        project: a,
        status: "open",
        occurredAt: "1001-05-11T00:00:00.000Z",
        review: { images, pane: null, summary: "Legacy summary line\nmore", question: "Drop omni_search v5–v8?", options: [{ id: "A", label: "Yes" }, { id: "B", label: "No" }], recommend: "A" },
      },
      { ext: `${tag}-multiline`, project: a, status: "open", occurredAt: "1001-05-12T00:00:00.000Z", review: { images: [], pane: null, summary: "s", question: "First\nSecond" } },
      { ext: `${tag}-legacy`, project: a, status: "open", occurredAt: "1001-05-13T00:00:00.000Z", review: { images, pane: null, summary: "Board header\nSecond" } },
      { ext: `${tag}-dangling`, project: a, status: "open", occurredAt: "1001-05-14T00:00:00.000Z", review: { images, summary: "s", question: "q?", options: [{ id: "A", label: "Yes" }, { id: "B", label: "No" }], recommend: "D" } },
    ]);

    const rows = mine(await listPendingReviews(db), a);

    expect(rows.map((r) => [r.externalId, r.summaryLine, r.imageCount])).toEqual([
      [`${tag}-card`, "Drop omni_search v5–v8?", 1],
      [`${tag}-multiline`, "First", 0],
      [`${tag}-legacy`, "Board header", 1],
      [`${tag}-dangling`, null, 0],
    ]);
  });

  it("keeps a review with invalid or missing review metadata, with no summary and no images", async () => {
    const { a, tag } = await scope();
    await items([
      { ext: `${tag}-bad`, project: a, status: "open", occurredAt: "1001-06-01T00:00:00.000Z", review: { images: "a.png", summary: "hidden" } },
      { ext: `${tag}-stored-invalid`, project: a, status: "open", occurredAt: "1001-06-02T00:00:00.000Z", review: { invalid: true } },
      { ext: `${tag}-null`, project: a, status: "open", occurredAt: "1001-06-03T00:00:00.000Z", review: null },
      { ext: `${tag}-absent`, project: a, status: "open", occurredAt: "1001-06-04T00:00:00.000Z" },
    ]);

    const rows = mine(await listPendingReviews(db), a);

    expect(rows.map((r) => [r.externalId, r.summaryLine, r.imageCount])).toEqual([
      [`${tag}-bad`, null, 0],
      [`${tag}-stored-invalid`, null, 0],
      [`${tag}-null`, null, 0],
      [`${tag}-absent`, null, 0],
    ]);
  });

  it("falls back to the row's creation time when occurred_at is missing or not in the stored form", async () => {
    const { a, tag } = await scope();
    const ids = await items([
      { ext: `${tag}-missing`, project: a, status: "open" },
      { ext: `${tag}-malformed`, project: a, status: "open", occurredAt: "yesterday" },
      { ext: `${tag}-between`, project: a, status: "open", occurredAt: "1001-07-02T00:00:00.000Z" },
      // Shape-valid but impossible: month 13 and hour 25 fail the SQL check.
      { ext: `${tag}-month13`, project: a, status: "open", occurredAt: "1001-13-01T00:00:00.000Z" },
      { ext: `${tag}-hour25`, project: a, status: "open", occurredAt: "1001-07-01T25:00:00.000Z" },
    ]);
    // Pin creation times so the fallback has a known value inside the window.
    const pin = (ext: string, at: string) => db.execute(sql`UPDATE nodes SET created_at = ${at}::timestamptz WHERE id = ${ids.get(`${tag}-${ext}`)!}`);
    await pin("missing", "1001-07-01T00:00:00Z");
    await pin("malformed", "1001-07-03T00:00:00Z");
    await pin("month13", "1001-07-04T00:00:00Z");
    await pin("hour25", "1001-07-05T00:00:00Z");

    const rows = mine(await listPendingReviews(db), a);

    expect(rows.map((r) => [r.externalId, r.requestedAt.toISOString()])).toEqual([
      [`${tag}-missing`, "1001-07-01T00:00:00.000Z"],
      [`${tag}-between`, "1001-07-02T00:00:00.000Z"],
      [`${tag}-malformed`, "1001-07-03T00:00:00.000Z"],
      [`${tag}-month13`, "1001-07-04T00:00:00.000Z"],
      [`${tag}-hour25`, "1001-07-05T00:00:00.000Z"],
    ]);
  });

  it("reports the creation time for a day the month does not have, which passes the SQL shape check", async () => {
    const { a, tag } = await scope();
    const ids = await items([{ ext: `${tag}-feb30`, project: a, status: "open", occurredAt: "1001-02-30T00:00:00.000Z" }]);
    await db.execute(sql`UPDATE nodes SET created_at = '1001-08-01T00:00:00Z' WHERE id = ${ids.get(`${tag}-feb30`)!}`);

    const [row] = mine(await listPendingReviews(db), a);

    expect(row?.externalId).toBe(`${tag}-feb30`);
    expect(row?.requestedAt.toISOString()).toBe("1001-08-01T00:00:00.000Z");
  });
});

describe("listPendingReviews cap", () => {
  it("returns the oldest `limit`, counts every pending review, and reports truncation", async () => {
    const { a, b, tag } = await scope();
    await items([
      { ext: `${tag}-3`, project: a, status: "open", occurredAt: "1000-01-01T00:00:03.000Z" },
      { ext: `${tag}-1`, project: b, status: "open", occurredAt: "1000-01-01T00:00:01.000Z" },
      { ext: `${tag}-2`, project: a, status: "open", occurredAt: "1000-01-01T00:00:02.000Z" },
    ]);

    const all = await listPendingReviews(db);
    expect(mine(all, a, b).map((r) => r.externalId)).toEqual([`${tag}-1`, `${tag}-2`, `${tag}-3`]);

    // Which rows are oldest store-wide is not this suite's to know: the
    // limited read is checked only against the full read.
    const cut = await listPendingReviews(db, { limit: 2 });
    expect(cut.reviews).toHaveLength(2);
    expect(cut.reviews.map((r) => r.id)).toEqual(all.reviews.slice(0, 2).map((r) => r.id));
    expect(cut.total).toBeGreaterThanOrEqual(3);
    expect(cut.truncated).toBe(true);
    expect(all.truncated).toBe(all.total > all.reviews.length);
    expect(all.reviews.length).toBeLessThanOrEqual(MAX_PENDING_REVIEWS);
  });

  it("reports truncation exactly when the total exceeds what was returned", async () => {
    const { a, tag } = await scope();
    await items([{ ext: `${tag}-only`, project: a, status: "open", occurredAt: "1000-01-02T00:00:00.000Z" }]);

    const queue = await listPendingReviews(db, { limit: MAX_PENDING_REVIEWS });

    expect(mine(queue, a).map((r) => r.externalId)).toEqual([`${tag}-only`]);
    expect(queue.truncated).toBe(queue.total > MAX_PENDING_REVIEWS);
    expect(queue.total).toBeGreaterThanOrEqual(queue.reviews.length);
  });

  it("rejects a limit outside 1..MAX_PENDING_REVIEWS", async () => {
    for (const limit of [0, -1, 1.5, MAX_PENDING_REVIEWS + 1]) {
      await expect(listPendingReviews(db, { limit })).rejects.toBeInstanceOf(InvalidLookupOptionError);
    }
  });
});

describe("listPendingReviews parent (split-review-decisions)", () => {
  const childOf = (srcId: string, dstId: string, weight = 1) => ({ srcId, dstId, edgeType: "child_of", sourceSystem: SRC, weight });

  it("carries the work item a review is a child of, and null for one with none", async () => {
    const { a, tag } = await scope();
    const ids = await items([
      { ext: `${tag}-epic`, project: a, status: "open", labels: [], title: "Launch a city" },
      { ext: `${tag}-city`, project: a, status: "open", occurredAt: "1002-01-01T00:00:00.000Z" },
      { ext: `${tag}-budget`, project: a, status: "open", occurredAt: "1002-01-01T00:00:01.000Z" },
      { ext: `${tag}-orphan`, project: a, status: "open", occurredAt: "1002-01-01T00:00:02.000Z" },
    ]);
    await upsertEdges(db, run, [childOf(ids.get(`${tag}-city`)!, ids.get(`${tag}-epic`)!), childOf(ids.get(`${tag}-budget`)!, ids.get(`${tag}-epic`)!)]);

    const rows = mine(await listPendingReviews(db), a);
    const epic = { id: ids.get(`${tag}-epic`), externalId: `${tag}-epic`, title: "Launch a city" };
    expect(rows.map((r) => [r.externalId, r.parent])).toEqual([
      [`${tag}-city`, epic],
      [`${tag}-budget`, epic],
      [`${tag}-orphan`, null],
    ]);
  });

  it("folds a merged-away parent to its survivor, and ignores a parent in another project", async () => {
    const { a, b, tag } = await scope();
    const ids = await items([
      { ext: `${tag}-old-epic`, project: a, status: "open", labels: [] },
      { ext: `${tag}-epic`, project: a, status: "open", labels: [], title: "Survivor" },
      { ext: `${tag}-foreign`, project: b, status: "open", labels: [] },
      { ext: `${tag}-r1`, project: a, status: "open", occurredAt: "1002-02-01T00:00:00.000Z" },
      { ext: `${tag}-r2`, project: a, status: "open", occurredAt: "1002-02-01T00:00:01.000Z" },
    ]);
    await upsertEdges(db, run, [childOf(ids.get(`${tag}-r1`)!, ids.get(`${tag}-old-epic`)!), childOf(ids.get(`${tag}-r2`)!, ids.get(`${tag}-foreign`)!)]);
    const mergeRun = await openIngestRun(db, SRC, { actor: "review-queue-test-merge" });
    try {
      await mergeNodes(db, ids.get(`${tag}-old-epic`)!, ids.get(`${tag}-epic`)!, mergeRun);
    } finally {
      await closeIngestRun(db, mergeRun);
      extraRunIds.push(mergeRun.id);
    }

    const rows = mine(await listPendingReviews(db), a);
    expect(rows.map((r) => [r.externalId, r.parent])).toEqual([
      [`${tag}-r1`, { id: ids.get(`${tag}-epic`), externalId: `${tag}-epic`, title: "Survivor" }],
      [`${tag}-r2`, null],
    ]);
  });

  it("prefers the heavier child_of edge when a review has two parents", async () => {
    const { a, tag } = await scope();
    const ids = await items([
      { ext: `${tag}-light`, project: a, status: "open", labels: [] },
      { ext: `${tag}-heavy`, project: a, status: "open", labels: [] },
      { ext: `${tag}-r`, project: a, status: "open", occurredAt: "1002-03-01T00:00:00.000Z" },
    ]);
    await upsertEdges(db, run, [childOf(ids.get(`${tag}-r`)!, ids.get(`${tag}-light`)!, 0.4), childOf(ids.get(`${tag}-r`)!, ids.get(`${tag}-heavy`)!, 0.9)]);

    const [row] = mine(await listPendingReviews(db), a);
    expect(row?.parent?.externalId).toBe(`${tag}-heavy`);
  });
});
