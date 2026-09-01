import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@breakdown/db";
import { ingestRuns, nodes, resolvedNodes } from "@breakdown/db";
import { MergeFailedError, NodeNotFoundError, SelfMergeError } from "./errors.js";
import { openIngestRun, type IngestRunHandle } from "./ingest-runs.js";
import { mergeNodes } from "./merge.js";
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
    // merged_into has no ON DELETE action, but Postgres checks a plain
    // (non-deferrable) foreign key at the end of the statement, not
    // per-row — so one DELETE removing an entire merge chain (loser and
    // survivor together) is fine even though the loser references the
    // survivor.
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
  const run = await openIngestRun(db, `merge-test-${uniqueSuffix()}`);
  openRunIds.push(run.id);
  usedSourceSystems.push(run.sourceSystem);
  return run;
}

async function makeNodes(run: IngestRunHandle, count: number) {
  const suffix = uniqueSuffix();
  const input = Array.from({ length: count }, (_, i) => ({
    nodeType: "person",
    sourceSystem: run.sourceSystem,
    externalId: `node-${suffix}-${i}`,
  }));
  const result = await upsertNodes(db, run, input);
  return result.rows.map((r) => r.id);
}

describe("mergeNodes", () => {
  it("merges a loser directly into a canonical survivor", async () => {
    const run = await newRun();
    const [survivor, loser] = await makeNodes(run, 2);
    if (!survivor || !loser) throw new Error("setup failed");

    const result = await mergeNodes(db, loser, survivor);

    expect(result.survivorId).toBe(survivor);
    expect(result.mergedNodeIds).toEqual([loser]);

    const [row] = await db.select({ mergedInto: nodes.mergedInto }).from(nodes).where(eq(nodes.id, loser));
    expect(row?.mergedInto).toBe(survivor);

    // resolved_nodes (bd-vt2.2) follows merged_into: the loser must stop
    // appearing there, and the survivor must still be present.
    const resolvedLoser = await db.select({ id: resolvedNodes.id }).from(resolvedNodes).where(eq(resolvedNodes.id, loser));
    expect(resolvedLoser).toHaveLength(0);
    const resolvedSurvivor = await db
      .select({ id: resolvedNodes.id })
      .from(resolvedNodes)
      .where(eq(resolvedNodes.id, survivor));
    expect(resolvedSurvivor).toHaveLength(1);
  });

  it("collapses a merge chain: merging C into B then B into A leaves both B and C pointing directly at A", async () => {
    const run = await newRun();
    const [a, b, c] = await makeNodes(run, 3);
    if (!a || !b || !c) throw new Error("setup failed");

    const m1 = await mergeNodes(db, c, b);
    expect(m1.survivorId).toBe(b);
    expect(m1.mergedNodeIds).toEqual([c]);

    const m2 = await mergeNodes(db, b, a);
    expect(m2.survivorId).toBe(a);
    expect(new Set(m2.mergedNodeIds)).toEqual(new Set([b, c]));

    const rows = await db
      .select({ id: nodes.id, mergedInto: nodes.mergedInto })
      .from(nodes)
      .where(inArray(nodes.id, [a, b, c]));
    const byId = new Map(rows.map((r) => [r.id, r.mergedInto]));

    expect(byId.get(a)).toBeNull();
    expect(byId.get(b)).toBe(a);
    expect(byId.get(c)).toBe(a);
  });

  it("is idempotent: merging an already-merged node into the same (resolved) survivor changes nothing", async () => {
    const run = await newRun();
    const [survivor, loser] = await makeNodes(run, 2);
    if (!survivor || !loser) throw new Error("setup failed");

    const first = await mergeNodes(db, loser, survivor);
    expect(first.mergedNodeIds).toEqual([loser]);

    const [before] = await db.select({ mergedInto: nodes.mergedInto }).from(nodes).where(eq(nodes.id, loser));

    const second = await mergeNodes(db, loser, survivor);
    expect(second.survivorId).toBe(survivor);
    expect(second.mergedNodeIds).toEqual([]);

    const [after] = await db.select({ mergedInto: nodes.mergedInto }).from(nodes).where(eq(nodes.id, loser));
    expect(after?.mergedInto).toBe(before?.mergedInto);
  });

  it("is idempotent through a chain: re-merging C into B (B now resolved to A) is a no-op", async () => {
    const run = await newRun();
    const [a, b, c] = await makeNodes(run, 3);
    if (!a || !b || !c) throw new Error("setup failed");

    await mergeNodes(db, c, b);
    await mergeNodes(db, b, a);

    const again = await mergeNodes(db, c, b);
    expect(again.survivorId).toBe(a);
    expect(again.mergedNodeIds).toEqual([]);

    const [row] = await db.select({ mergedInto: nodes.mergedInto }).from(nodes).where(eq(nodes.id, c));
    expect(row?.mergedInto).toBe(a);
  });

  it("rejects merging a node into itself", async () => {
    const run = await newRun();
    const [a] = await makeNodes(run, 1);
    if (!a) throw new Error("setup failed");

    await expect(mergeNodes(db, a, a)).rejects.toBeInstanceOf(SelfMergeError);
  });

  it("rejects a merge that resolves into a self-merge (survivor already transitively merged into the loser)", async () => {
    const run = await newRun();
    const [a, b] = await makeNodes(run, 2);
    if (!a || !b) throw new Error("setup failed");

    // b is merged into a.
    await mergeNodes(db, b, a);

    // Now try to merge a into b — b resolves to a, so this is
    // asking to merge a into a.
    await expect(mergeNodes(db, a, b)).rejects.toBeInstanceOf(SelfMergeError);
  });

  it("rejects a merge naming a node that does not exist", async () => {
    const run = await newRun();
    const [a] = await makeNodes(run, 1);
    if (!a) throw new Error("setup failed");
    const bogus = "00000000-0000-0000-0000-000000000000";

    await expect(mergeNodes(db, bogus, a)).rejects.toBeInstanceOf(NodeNotFoundError);
    await expect(mergeNodes(db, a, bogus)).rejects.toBeInstanceOf(NodeNotFoundError);
  });

  it("wraps a genuine database failure as MergeFailedError, not a raw driver error", async () => {
    // A malformed uuid isn't caught by any validation in merge.ts (unlike
    // edges.ts, mergeNodes doesn't pre-validate id shape) — it reaches
    // Postgres and fails there (22P02, "invalid input syntax for type
    // uuid"). That's exactly the kind of failure this test needs: not one
    // of the two intentional validation errors (NodeNotFoundError,
    // SelfMergeError), so it must come back wrapped, with the original
    // error preserved as `cause`, per the bd-vt2.3 review ("a deadlock
    // surfaces as a raw driver error with no KnowledgeStoreError hook").
    const run = await newRun();
    const [a] = await makeNodes(run, 1);
    if (!a) throw new Error("setup failed");

    let thrown: unknown;
    try {
      await mergeNodes(db, "not-a-uuid", a);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(MergeFailedError);
    const err = thrown as MergeFailedError;
    expect(err.loserId).toBe("not-a-uuid");
    expect(err.survivorId).toBe(a);
    expect(err.cause).toBeDefined();
  });

  it("lets the merged-away node's original source keep updating it, with the merge still in effect", async () => {
    const run = await newRun();
    const suffix = uniqueSuffix();
    const [survivorResult, loserResult] = await Promise.all([
      upsertNodes(db, run, [{ nodeType: "person", sourceSystem: run.sourceSystem, externalId: `survivor-${suffix}` }]),
      upsertNodes(db, run, [{ nodeType: "person", sourceSystem: run.sourceSystem, externalId: `loser-${suffix}`, content: "v1" }]),
    ]);
    const survivor = survivorResult.rows[0]?.id;
    const loserExternalId = `loser-${suffix}`;
    if (!survivor) throw new Error("setup failed");
    const loser = loserResult.rows[0]?.id;
    if (!loser) throw new Error("setup failed");

    await mergeNodes(db, loser, survivor);

    // The original source (same source_system/external_id) writes the
    // merged-away node again with new content.
    await upsertNodes(db, run, [
      { nodeType: "person", sourceSystem: run.sourceSystem, externalId: loserExternalId, content: "v2" },
    ]);

    const [row] = await db
      .select({ content: nodes.content, mergedInto: nodes.mergedInto })
      .from(nodes)
      .where(eq(nodes.id, loser));
    expect(row?.content).toBe("v2");
    expect(row?.mergedInto).toBe(survivor);
  });
});
