import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@breakdown/db";
import { ingestRuns, nodes } from "@breakdown/db";
import { ContentTooLargeError, DuplicateNodeInBatchError, InvalidNodeContentError, NodeUpsertFailedError } from "./errors.js";
import { openIngestRun, type IngestRunHandle } from "./ingest-runs.js";
import { upsertNodes } from "./nodes.js";
import { connectTestDb, type TestPool, uniqueSuffix } from "./test-helpers.js";

let pool: TestPool;
let db: Database;
const openRunIds: string[] = [];
const usedSourceSystems: string[] = [];

beforeAll(() => {
  ({ pool, db } = connectTestDb());
});

afterEach(async () => {
  if (usedSourceSystems.length > 0) {
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

async function newRun(): Promise<IngestRunHandle> {
  const run = await openIngestRun(db, `nodes-test-${uniqueSuffix()}`);
  openRunIds.push(run.id);
  usedSourceSystems.push(run.sourceSystem);
  return run;
}

describe("upsertNodes", () => {
  it("re-running an unchanged batch creates no duplicates, advances no updated_at, and reports all-unchanged", async () => {
    const run = await newRun();
    const suffix = uniqueSuffix();
    const input = [
      { nodeType: "doc", sourceSystem: run.sourceSystem, externalId: `n1-${suffix}`, title: "T1", content: "C1" },
      { nodeType: "doc", sourceSystem: run.sourceSystem, externalId: `n2-${suffix}`, title: "T2", content: "C2" },
    ];

    const first = await upsertNodes(db, run, input);
    expect(first.created).toBe(2);
    expect(first.updated).toBe(0);
    expect(first.unchanged).toBe(0);

    const beforeRows = await db
      .select({ id: nodes.id, updatedAt: nodes.updatedAt, createdAt: nodes.createdAt })
      .from(nodes)
      .where(eq(nodes.sourceSystem, run.sourceSystem));

    // Second write of the exact same batch — same title/content, so the
    // same content_hash.
    const second = await upsertNodes(db, run, input);
    expect(second.created).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.unchanged).toBe(2);
    expect(second.rows.every((r) => r.action === "unchanged")).toBe(true);

    const afterRows = await db
      .select({ id: nodes.id, updatedAt: nodes.updatedAt, createdAt: nodes.createdAt })
      .from(nodes)
      .where(eq(nodes.sourceSystem, run.sourceSystem));

    expect(afterRows).toHaveLength(2);
    const beforeById = new Map(beforeRows.map((r) => [r.id, r]));
    for (const row of afterRows) {
      const before = beforeById.get(row.id);
      expect(before).toBeDefined();
      expect(row.updatedAt.getTime()).toBe(before?.updatedAt.getTime());
      expect(row.createdAt.getTime()).toBe(before?.createdAt.getTime());
    }
  });

  it("reports a changed node as updated and advances its updated_at", async () => {
    const run = await newRun();
    const externalId = `n-${uniqueSuffix()}`;

    const first = await upsertNodes(db, run, [
      { nodeType: "doc", sourceSystem: run.sourceSystem, externalId, title: "Original", content: "original content" },
    ]);
    expect(first.created).toBe(1);
    const [before] = await db
      .select({ updatedAt: nodes.updatedAt })
      .from(nodes)
      .where(eq(nodes.sourceSystem, run.sourceSystem));

    // Ensure a measurable clock tick between the two writes.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const second = await upsertNodes(db, run, [
      { nodeType: "doc", sourceSystem: run.sourceSystem, externalId, title: "Original", content: "different content now" },
    ]);
    expect(second.created).toBe(0);
    expect(second.updated).toBe(1);
    expect(second.unchanged).toBe(0);
    expect(second.rows[0]?.action).toBe("updated");

    const [after] = await db
      .select({ updatedAt: nodes.updatedAt, content: nodes.content })
      .from(nodes)
      .where(eq(nodes.sourceSystem, run.sourceSystem));

    expect(after?.content).toBe("different content now");
    expect(after?.updatedAt.getTime()).toBeGreaterThan(before?.updatedAt.getTime() ?? 0);
  });

  it("reports a metadata-only change as updated and advances updated_at, even though content_hash is unchanged", async () => {
    // Regression for bd-vt2.3 review: content_hash only covers
    // title/content, so gating the created/updated/unchanged
    // classification on content_hash alone let a metadata-only correction
    // silently report "unchanged" and leave updated_at frozen — exactly
    // the column bd-vt2.4's "updated since" retrieval filter builds on.
    const run = await newRun();
    const externalId = `meta-${uniqueSuffix()}`;

    const first = await upsertNodes(db, run, [
      {
        nodeType: "doc",
        sourceSystem: run.sourceSystem,
        externalId,
        title: "Same title",
        content: "Same content",
        metadata: { status: "draft" },
      },
    ]);
    expect(first.created).toBe(1);
    const [before] = await db
      .select({ updatedAt: nodes.updatedAt, metadata: nodes.metadata })
      .from(nodes)
      .where(eq(nodes.sourceSystem, run.sourceSystem));
    expect(before?.metadata).toEqual({ status: "draft" });

    await new Promise((resolve) => setTimeout(resolve, 20));

    // Identical title/content (same content_hash), only metadata differs.
    const second = await upsertNodes(db, run, [
      {
        nodeType: "doc",
        sourceSystem: run.sourceSystem,
        externalId,
        title: "Same title",
        content: "Same content",
        metadata: { status: "published" },
      },
    ]);
    expect(second.created).toBe(0);
    expect(second.updated).toBe(1);
    expect(second.unchanged).toBe(0);
    expect(second.rows[0]?.action).toBe("updated");

    const [after] = await db
      .select({ updatedAt: nodes.updatedAt, metadata: nodes.metadata })
      .from(nodes)
      .where(eq(nodes.sourceSystem, run.sourceSystem));
    expect(after?.metadata).toEqual({ status: "published" });
    expect(after?.updatedAt.getTime()).toBeGreaterThan(before?.updatedAt.getTime() ?? 0);
  });

  it("reports a node_type-only change as updated, even though content_hash is unchanged", async () => {
    const run = await newRun();
    const externalId = `type-${uniqueSuffix()}`;

    await upsertNodes(db, run, [
      { nodeType: "issue", sourceSystem: run.sourceSystem, externalId, title: "T", content: "C" },
    ]);
    const second = await upsertNodes(db, run, [
      { nodeType: "pull_request", sourceSystem: run.sourceSystem, externalId, title: "T", content: "C" },
    ]);

    expect(second.updated).toBe(1);
    expect(second.unchanged).toBe(0);

    const [after] = await db.select({ nodeType: nodes.nodeType }).from(nodes).where(eq(nodes.sourceSystem, run.sourceSystem));
    expect(after?.nodeType).toBe("pull_request");
  });

  it("rejects a node whose content contains a NUL byte, naming the node and position", async () => {
    const run = await newRun();
    const externalId = `nul-${uniqueSuffix()}`;

    let thrown: unknown;
    try {
      await upsertNodes(db, run, [
        {
          nodeType: "doc",
          sourceSystem: run.sourceSystem,
          externalId,
          content: `before${String.fromCharCode(0)}after`,
        },
      ]);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(InvalidNodeContentError);
    const err = thrown as InvalidNodeContentError;
    expect(err.sourceSystem).toBe(run.sourceSystem);
    expect(err.externalId).toBe(externalId);
    expect(err.field).toBe("content");
    expect(err.charPosition).toBe(6);
    expect(err.codePoint).toBe(0);
    expect(err.message).toContain(externalId);

    const persisted = await db.select({ id: nodes.id }).from(nodes).where(eq(nodes.sourceSystem, run.sourceSystem));
    expect(persisted).toHaveLength(0);
  });

  it("rejects a node whose title contains a control character other than NUL", async () => {
    const run = await newRun();
    const externalId = `ctrl-${uniqueSuffix()}`;

    let thrown: unknown;
    try {
      await upsertNodes(db, run, [
        {
          nodeType: "doc",
          sourceSystem: run.sourceSystem,
          externalId,
          title: `bad${String.fromCharCode(7)}title`, // BEL
        },
      ]);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(InvalidNodeContentError);
    const err = thrown as InvalidNodeContentError;
    expect(err.field).toBe("title");
    expect(err.codePoint).toBe(7);

    const persisted = await db.select({ id: nodes.id }).from(nodes).where(eq(nodes.sourceSystem, run.sourceSystem));
    expect(persisted).toHaveLength(0);
  });

  it("allows tab, newline, and carriage return in content", async () => {
    const run = await newRun();
    const externalId = `whitespace-${uniqueSuffix()}`;

    const result = await upsertNodes(db, run, [
      {
        nodeType: "doc",
        sourceSystem: run.sourceSystem,
        externalId,
        content: "line one\nline two\ttabbed\r\nCRLF",
      },
    ]);

    expect(result.created).toBe(1);
  });

  it("rolls back the whole multi-chunk batch when a later chunk hits a genuine database failure not caught by boundary validation", async () => {
    // nodes has no per-row-varying foreign key the way edges does (its
    // only FK, ingest_run_id, is uniform across a whole call), so
    // constructing a genuine, per-row database-only failure here needs a
    // different mechanism than edges.test.ts's FK violation. This uses a
    // real Postgres quirk: jsonb rejects a literal NUL Unicode escape
    // (" ") inside a JSON string value (error 22P05, "unsupported
    // Unicode escape sequence") even though JSON.stringify happily
    // produces that exact escape — so nothing in prepareNodes catches it
    // (JSON.stringify never throws, and this is a different failure
    // surface than the raw-NUL-byte check above, which only screens
    // title/content, not metadata — see the comment on CONTROL_CHAR
    // screening in nodes.ts for why metadata is deliberately out of that
    // check's scope). It is exactly the kind of failure this test needs:
    // unreachable by any of our own validation, only by Postgres itself.
    const run = await newRun();
    const suffix = uniqueSuffix();
    const badMetadata = { note: `embedded${String.fromCharCode(0)}nul` };

    const input = Array.from({ length: 200 }, (_, i) => ({
      nodeType: "doc",
      sourceSystem: run.sourceSystem,
      externalId: `rollback-${suffix}-${i}`,
      content: "fine content",
      metadata: i === 130 ? badMetadata : {},
    }));

    let thrown: unknown;
    try {
      // Small chunkSize so rows 0-119 (chunks 0-5) genuinely execute and
      // succeed within the transaction before chunk 6 (rows 120-139,
      // containing the bad row at index 130) fails at the database.
      await upsertNodes(db, run, input, { chunkSize: 20 });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(NodeUpsertFailedError);

    const persisted = await db.select({ id: nodes.id }).from(nodes).where(eq(nodes.sourceSystem, run.sourceSystem));
    expect(persisted).toHaveLength(0);
  });

  // This proves boundary validation catches a bad row anywhere in a large
  // batch before any SQL runs at all — 500 rows fits in the default
  // single chunk (1000), so it does not exercise cross-chunk transaction
  // rollback. The genuine-database-failure test above (small chunkSize,
  // a failure only Postgres can catch) is what proves that.
  it("rejects a whole 500-row batch when row 300 has content over the limit, naming the offending node, and persists nothing", async () => {
    const run = await newRun();
    const suffix = uniqueSuffix();
    const maxContentLength = 50;

    const input = Array.from({ length: 500 }, (_, i) => ({
      nodeType: "doc",
      sourceSystem: run.sourceSystem,
      externalId: `bad-batch-${suffix}-${i}`,
      title: `Title ${i}`,
      content: i === 300 ? "x".repeat(maxContentLength + 1) : "short content",
    }));

    let thrown: unknown;
    try {
      await upsertNodes(db, run, input, { maxContentLength });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ContentTooLargeError);
    const err = thrown as ContentTooLargeError;
    expect(err.index).toBe(300);
    expect(err.externalId).toBe(`bad-batch-${suffix}-300`);
    expect(err.maxLength).toBe(maxContentLength);

    const persisted = await db
      .select({ id: nodes.id })
      .from(nodes)
      .where(eq(nodes.sourceSystem, run.sourceSystem));
    expect(persisted).toHaveLength(0);
  });

  it("rejects content over the configured limit by name on a single-node batch", async () => {
    const run = await newRun();
    const externalId = `too-long-${uniqueSuffix()}`;

    let thrown: unknown;
    try {
      await upsertNodes(
        db,
        run,
        [{ nodeType: "doc", sourceSystem: run.sourceSystem, externalId, content: "y".repeat(100) }],
        { maxContentLength: 10 },
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ContentTooLargeError);
    const err = thrown as ContentTooLargeError;
    expect(err.sourceSystem).toBe(run.sourceSystem);
    expect(err.externalId).toBe(externalId);
    expect(err.length).toBe(100);
    expect(err.maxLength).toBe(10);
    expect(err.message).toContain(externalId);

    const persisted = await db.select({ id: nodes.id }).from(nodes).where(eq(nodes.sourceSystem, run.sourceSystem));
    expect(persisted).toHaveLength(0);
  });

  it("rejects a batch with two rows sharing (source_system, external_id)", async () => {
    const run = await newRun();
    const externalId = `dup-${uniqueSuffix()}`;

    let thrown: unknown;
    try {
      await upsertNodes(db, run, [
        { nodeType: "doc", sourceSystem: run.sourceSystem, externalId, content: "first" },
        { nodeType: "doc", sourceSystem: run.sourceSystem, externalId, content: "second" },
      ]);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(DuplicateNodeInBatchError);
    const persisted = await db.select({ id: nodes.id }).from(nodes).where(eq(nodes.sourceSystem, run.sourceSystem));
    expect(persisted).toHaveLength(0);
  });

  it("returns an empty result for an empty batch without touching the database", async () => {
    const run = await newRun();
    const result = await upsertNodes(db, run, []);
    expect(result).toEqual({ created: 0, updated: 0, unchanged: 0, rows: [] });
  });
});
