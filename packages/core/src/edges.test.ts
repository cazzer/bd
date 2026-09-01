import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@breakdown/db";
import { edges, ingestRuns, nodes } from "@breakdown/db";
import { DuplicateEdgeInBatchError, EdgeUpsertFailedError, InvalidEdgeWeightError } from "./errors.js";
import { openIngestRun, type IngestRunHandle } from "./ingest-runs.js";
import { upsertEdges } from "./edges.js";
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
    await db.delete(edges).where(inArray(edges.sourceSystem, usedSourceSystems));
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
  const run = await openIngestRun(db, `edges-test-${uniqueSuffix()}`);
  openRunIds.push(run.id);
  usedSourceSystems.push(run.sourceSystem);
  return run;
}

async function makeNodes(run: IngestRunHandle, count: number) {
  const suffix = uniqueSuffix();
  const input = Array.from({ length: count }, (_, i) => ({
    nodeType: "doc",
    sourceSystem: run.sourceSystem,
    externalId: `node-${suffix}-${i}`,
  }));
  const result = await upsertNodes(db, run, input);
  return result.rows.map((r) => r.id);
}

describe("upsertEdges", () => {
  it("collapses a duplicate edge asserted twice by the same source system to one row", async () => {
    const run = await newRun();
    const [a, b] = await makeNodes(run, 2);
    if (!a || !b) throw new Error("setup failed");
    // A distinct, uniquely-suffixed edge source_system (not the node run's
    // own, and not a shared literal like "github") — this table has no
    // "attributed to a run" scoping the way nodes/edges.ingest_run_id
    // does, and a hardcoded literal could collide with unrelated tests
    // (e.g. packages/db's schema tests) running against the same live
    // database at the same time.
    const edgeSourceSystem = `github-${uniqueSuffix()}`;
    usedSourceSystems.push(edgeSourceSystem);

    const first = await upsertEdges(db, run, [
      { srcId: a, dstId: b, edgeType: "mentions", sourceSystem: edgeSourceSystem, weight: 0.5 },
    ]);
    expect(first.created).toBe(1);

    const second = await upsertEdges(db, run, [
      { srcId: a, dstId: b, edgeType: "mentions", sourceSystem: edgeSourceSystem, weight: 0.9 },
    ]);
    expect(second.created).toBe(0);
    expect(second.updated).toBe(1);

    const rows = await db.select().from(edges).where(eq(edges.srcId, a));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.weight).toBeCloseTo(0.9);
  });

  it("rejects an out-of-range weight before hitting the database, naming the offending edge", async () => {
    const run = await newRun();
    const [a, b] = await makeNodes(run, 2);
    if (!a || !b) throw new Error("setup failed");

    let thrown: unknown;
    try {
      await upsertEdges(db, run, [
        { srcId: a, dstId: b, edgeType: "mentions", sourceSystem: run.sourceSystem, weight: 1.4 },
      ]);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(InvalidEdgeWeightError);
    const err = thrown as InvalidEdgeWeightError;
    expect(err.srcId).toBe(a);
    expect(err.dstId).toBe(b);
    expect(err.edgeType).toBe("mentions");
    expect(err.weight).toBe(1.4);
    expect(err.message).toContain(a);
    expect(err.message).toContain(b);

    const rows = await db.select().from(edges).where(eq(edges.srcId, a));
    expect(rows).toHaveLength(0);
  });

  it("rejects a batch with two rows sharing (src_id, dst_id, edge_type, source_system)", async () => {
    const run = await newRun();
    const [a, b] = await makeNodes(run, 2);
    if (!a || !b) throw new Error("setup failed");

    let thrown: unknown;
    try {
      await upsertEdges(db, run, [
        { srcId: a, dstId: b, edgeType: "mentions", sourceSystem: run.sourceSystem },
        { srcId: a, dstId: b, edgeType: "mentions", sourceSystem: run.sourceSystem },
      ]);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(DuplicateEdgeInBatchError);
    const rows = await db.select().from(edges).where(eq(edges.srcId, a));
    expect(rows).toHaveLength(0);
  });

  it("rolls back the whole multi-chunk batch when a later chunk hits a genuine database failure, naming the offending edge", async () => {
    const run = await newRun();
    // A handful of valid nodes reused across rows — edge_type is unique
    // per row (below) so no two rows collapse under the
    // (src_id, dst_id, edge_type, source_system) dedup key, keeping this
    // test isolated from the "duplicate edge in batch" boundary check.
    // Chunked at 20 rows/statement so the 500-row batch spans multiple
    // statements — chunks covering rows 0-299 are well-formed and would
    // succeed on their own; row 300's dst_id does not exist, which only
    // Postgres's foreign key constraint can catch (not boundary
    // validation). This proves the whole transaction — including chunks
    // already sent to the database — rolls back, not just the bad chunk.
    const nodeIds = await makeNodes(run, 10);
    const bogusId = randomUUID();

    const input = Array.from({ length: 500 }, (_, i) => {
      const src = nodeIds[i % nodeIds.length];
      const dst = nodeIds[(i + 1) % nodeIds.length];
      if (!src || !dst) throw new Error("setup failed");
      return {
        srcId: src,
        dstId: i === 300 ? bogusId : dst,
        edgeType: `rollback-test-${i}`,
        sourceSystem: run.sourceSystem,
        weight: 0.5,
      };
    });

    let thrown: unknown;
    try {
      await upsertEdges(db, run, input, { chunkSize: 20 });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(EdgeUpsertFailedError);
    const err = thrown as EdgeUpsertFailedError;
    expect(err.message).toContain(bogusId);

    const persisted = await db.select().from(edges).where(eq(edges.sourceSystem, run.sourceSystem));
    expect(persisted).toHaveLength(0);
  });

  it("returns an empty result for an empty batch without touching the database", async () => {
    const run = await newRun();
    const result = await upsertEdges(db, run, []);
    expect(result).toEqual({ created: 0, updated: 0, rows: [] });
  });
});
