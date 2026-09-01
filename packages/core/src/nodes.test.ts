import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@breakdown/db";
import { ingestRuns, nodes } from "@breakdown/db";
import { ContentTooLargeError, DuplicateNodeInBatchError } from "./errors.js";
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
