import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@breakdown/db";
import { edges, ingestRuns, nodes } from "@breakdown/db";
import { upsertEdges } from "./edges.js";
import { closeIngestRun, getIngestRunContents, openIngestRun } from "./ingest-runs.js";
import { upsertNodes } from "./nodes.js";
import { connectTestDb, type TestPool, uniqueSuffix } from "./test-helpers.js";

let pool: TestPool;
let db: Database;

beforeAll(() => {
  ({ pool, db } = connectTestDb());
});

afterAll(async () => {
  await pool.end();
});

/** Deletes everything (edges, then nodes, then the run itself) attributed to one or more runs. */
async function cleanupRuns(sourceSystems: string[], runIds: string[]) {
  await db.delete(edges).where(inArray(edges.sourceSystem, sourceSystems));
  await db.delete(nodes).where(inArray(nodes.sourceSystem, sourceSystems));
  await db.delete(ingestRuns).where(inArray(ingestRuns.id, runIds));
}

describe("openIngestRun / closeIngestRun", () => {
  it("rejects an empty source system", async () => {
    await expect(openIngestRun(db, "  ")).rejects.toThrow(/non-empty/);
  });

  it("records finished_at and node/edge counts recomputed from what the run actually wrote", async () => {
    const run = await openIngestRun(db, `test-src-${uniqueSuffix()}`);
    try {
      const suffix = uniqueSuffix();
      const nodesResult = await upsertNodes(db, run, [
        { nodeType: "t", sourceSystem: run.sourceSystem, externalId: `n1-${suffix}` },
        { nodeType: "t", sourceSystem: run.sourceSystem, externalId: `n2-${suffix}` },
      ]);
      const [a, b] = nodesResult.rows;
      if (!a || !b) throw new Error("setup failed to upsert nodes");

      await upsertEdges(db, run, [
        { srcId: a.id, dstId: b.id, edgeType: "mentions", sourceSystem: run.sourceSystem },
      ]);

      const closed = await closeIngestRun(db, run);

      expect(closed.id).toBe(run.id);
      expect(closed.sourceSystem).toBe(run.sourceSystem);
      expect(closed.nodeCount).toBe(2);
      expect(closed.edgeCount).toBe(1);
      expect(closed.finishedAt).toBeInstanceOf(Date);
    } finally {
      await cleanupRuns([run.sourceSystem], [run.id]);
    }
  });

  it("is idempotent: closing an already-closed run recomputes the same counts without erroring", async () => {
    const run = await openIngestRun(db, `test-src-${uniqueSuffix()}`);
    try {
      await upsertNodes(db, run, [
        { nodeType: "t", sourceSystem: run.sourceSystem, externalId: `n-${uniqueSuffix()}` },
      ]);

      const first = await closeIngestRun(db, run);
      const second = await closeIngestRun(db, run);

      expect(second.nodeCount).toBe(first.nodeCount);
      expect(second.edgeCount).toBe(first.edgeCount);
    } finally {
      await cleanupRuns([run.sourceSystem], [run.id]);
    }
  });
});

describe("actor (spec: writes are attributable to an ingest run)", () => {
  it("opening a run with only a source system records no actor and closeIngestRun reports actor null (spec: a run opened without an actor)", async () => {
    const run = await openIngestRun(db, `test-src-${uniqueSuffix()}`);
    try {
      const [row] = await db.select({ actor: ingestRuns.actor }).from(ingestRuns).where(eq(ingestRuns.id, run.id));
      expect(row?.actor).toBeNull();

      const closed = await closeIngestRun(db, run);
      expect(closed.actor).toBeNull();
    } finally {
      await cleanupRuns([run.sourceSystem], [run.id]);
    }
  });

  it("records the actor as given, trimmed, and treats an empty/whitespace actor as none rather than refusing the run", async () => {
    const withActor = await openIngestRun(db, `test-src-${uniqueSuffix()}`, { actor: "  claude-code 2.1.0  " });
    const blank = await openIngestRun(db, `test-src-${uniqueSuffix()}`, { actor: "   " });
    try {
      expect((await closeIngestRun(db, withActor)).actor).toBe("claude-code 2.1.0");
      expect((await closeIngestRun(db, blank)).actor).toBeNull();
    } finally {
      await cleanupRuns([withActor.sourceSystem, blank.sourceSystem], [withActor.id, blank.id]);
    }
  });

  it("two runs under one source system with different actors each record their own actor, and a node written by one is attributed to that run only (spec: two agents writing under one source system)", async () => {
    const sourceSystem = `test-src-${uniqueSuffix()}`;
    const runA = await openIngestRun(db, sourceSystem, { actor: "claude-code 2.1.0" });
    const runB = await openIngestRun(db, sourceSystem, { actor: "cursor 1.4.0" });
    try {
      const written = await upsertNodes(db, runA, [{ nodeType: "t", sourceSystem, externalId: `n-${uniqueSuffix()}` }]);
      const nodeId = written.rows[0]?.id;
      if (!nodeId) throw new Error("setup failed to upsert node");

      const closedA = await closeIngestRun(db, runA);
      const closedB = await closeIngestRun(db, runB);
      expect(closedA.sourceSystem).toBe(sourceSystem);
      expect(closedB.sourceSystem).toBe(sourceSystem);
      expect(closedA.actor).toBe("claude-code 2.1.0");
      expect(closedB.actor).toBe("cursor 1.4.0");
      expect(closedA.nodeCount).toBe(1);
      expect(closedB.nodeCount).toBe(0);

      const [node] = await db.select({ ingestRunId: nodes.ingestRunId }).from(nodes).where(eq(nodes.id, nodeId));
      expect(node?.ingestRunId).toBe(runA.id);
      expect((await getIngestRunContents(db, runB.id)).nodes).toEqual([]);
    } finally {
      await cleanupRuns([sourceSystem], [runA.id, runB.id]);
    }
  });
});

describe("getIngestRunContents", () => {
  it("returns exactly the nodes and edges a run produced, distinguishable from other runs (auditing a bad load)", async () => {
    const runA = await openIngestRun(db, `test-src-a-${uniqueSuffix()}`);
    const runB = await openIngestRun(db, `test-src-b-${uniqueSuffix()}`);
    try {
      const suffixA = uniqueSuffix();
      const aNodes = await upsertNodes(db, runA, [
        { nodeType: "t", sourceSystem: runA.sourceSystem, externalId: `a1-${suffixA}` },
        { nodeType: "t", sourceSystem: runA.sourceSystem, externalId: `a2-${suffixA}` },
      ]);
      const [a1, a2] = aNodes.rows;
      if (!a1 || !a2) throw new Error("setup failed to upsert nodes for run A");
      await upsertEdges(db, runA, [
        { srcId: a1.id, dstId: a2.id, edgeType: "mentions", sourceSystem: runA.sourceSystem },
      ]);

      const suffixB = uniqueSuffix();
      await upsertNodes(db, runB, [
        { nodeType: "t", sourceSystem: runB.sourceSystem, externalId: `b1-${suffixB}` },
      ]);

      const contentsA = await getIngestRunContents(db, runA.id);
      const contentsB = await getIngestRunContents(db, runB.id);

      expect(contentsA.nodes).toHaveLength(2);
      expect(contentsA.edges).toHaveLength(1);
      expect(new Set(contentsA.nodes.map((n) => n.externalId))).toEqual(
        new Set([`a1-${suffixA}`, `a2-${suffixA}`]),
      );

      expect(contentsB.nodes).toHaveLength(1);
      expect(contentsB.edges).toHaveLength(0);
      expect(contentsB.nodes[0]?.externalId).toBe(`b1-${suffixB}`);
    } finally {
      await cleanupRuns([runA.sourceSystem, runB.sourceSystem], [runA.id, runB.id]);
    }
  });
});

