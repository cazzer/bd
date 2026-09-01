import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, createPool, type Database } from "./client.js";
import { resolveDatabaseUrl } from "./env.js";
import { edges, ingestRuns, nodes, resolvedNodes } from "./schema.js";

/**
 * Integration tests against the real Postgres instance (no mocking) —
 * they exercise the constraints, generated columns, and trigger the
 * migration in ./migrations/0000_*.sql creates, per bd-vt2.2. Every test
 * creates and tears down its own rows so the suite is re-runnable.
 *
 * `nodes.ingest_run_id` and `edges.ingest_run_id` are NOT NULL, so every
 * test attributes its rows to one shared ingest run created in
 * beforeAll/torn down in afterAll — the same shape the real write path
 * uses (open a run, write attributed to it).
 */

let pool: Pool;
let db: Database;
let testRunId: string;

beforeAll(async () => {
  pool = createPool(resolveDatabaseUrl());
  db = createDb(pool);

  const [run] = await db
    .insert(ingestRuns)
    .values({ sourceSystem: "schema-test-suite" })
    .returning();
  if (!run) throw new Error("setup failed to insert ingest run");
  testRunId = run.id;
});

afterAll(async () => {
  await db.delete(ingestRuns).where(eq(ingestRuns.id, testRunId));
  await pool.end();
});

/** Builds a valid, uniquely-identified `nodes` insert row for a test. */
function nodeRow(
  overrides: Partial<typeof nodes.$inferInsert> = {},
): typeof nodes.$inferInsert {
  const suffix = randomUUID();
  return {
    nodeType: "test_node",
    sourceSystem: `test-src-${suffix}`,
    externalId: `test-ext-${suffix}`,
    content: "",
    contentHash: `test-hash-${suffix}`,
    ingestRunId: testRunId,
    ...overrides,
  };
}

describe("edges", () => {
  it("collapses a duplicate edge from the same source system to one row", async () => {
    const [a] = await db.insert(nodes).values(nodeRow()).returning();
    const [b] = await db.insert(nodes).values(nodeRow()).returning();
    if (!a || !b) throw new Error("setup failed to insert nodes");

    try {
      const target = [
        edges.srcId,
        edges.dstId,
        edges.edgeType,
        edges.sourceSystem,
      ];

      // Simulates the write path's upsert (bd-vt2.3): the same assertion
      // arriving twice from the same source system.
      await db
        .insert(edges)
        .values({
          srcId: a.id,
          dstId: b.id,
          edgeType: "mentions",
          sourceSystem: "github",
          weight: 0.5,
          ingestRunId: testRunId,
        })
        .onConflictDoUpdate({ target, set: { weight: 0.5 } });
      await db
        .insert(edges)
        .values({
          srcId: a.id,
          dstId: b.id,
          edgeType: "mentions",
          sourceSystem: "github",
          weight: 0.9,
          ingestRunId: testRunId,
        })
        .onConflictDoUpdate({ target, set: { weight: 0.9 } });

      const rows = await db
        .select()
        .from(edges)
        .where(
          and(
            eq(edges.srcId, a.id),
            eq(edges.dstId, b.id),
            eq(edges.edgeType, "mentions"),
            eq(edges.sourceSystem, "github"),
          ),
        );

      expect(rows).toHaveLength(1);
      expect(rows[0]?.weight).toBeCloseTo(0.9);
    } finally {
      await db.delete(nodes).where(inArray(nodes.id, [a.id, b.id]));
    }
  });

  it("keeps both when the same edge is asserted by two different source systems", async () => {
    const [a] = await db.insert(nodes).values(nodeRow()).returning();
    const [b] = await db.insert(nodes).values(nodeRow()).returning();
    if (!a || !b) throw new Error("setup failed to insert nodes");

    try {
      await db.insert(edges).values([
        {
          srcId: a.id,
          dstId: b.id,
          edgeType: "mentions",
          sourceSystem: "github",
          ingestRunId: testRunId,
        },
        {
          srcId: a.id,
          dstId: b.id,
          edgeType: "mentions",
          sourceSystem: "slack",
          ingestRunId: testRunId,
        },
      ]);

      const rows = await db
        .select()
        .from(edges)
        .where(
          and(
            eq(edges.srcId, a.id),
            eq(edges.dstId, b.id),
            eq(edges.edgeType, "mentions"),
          ),
        );

      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((r) => r.sourceSystem))).toEqual(
        new Set(["github", "slack"]),
      );
    } finally {
      await db.delete(nodes).where(inArray(nodes.id, [a.id, b.id]));
    }
  });

  it("rejects an edge with weight 1.4", async () => {
    const [a] = await db.insert(nodes).values(nodeRow()).returning();
    const [b] = await db.insert(nodes).values(nodeRow()).returning();
    if (!a || !b) throw new Error("setup failed to insert nodes");

    try {
      let thrown: unknown;
      try {
        await db.insert(edges).values({
          srcId: a.id,
          dstId: b.id,
          edgeType: "mentions",
          sourceSystem: "github",
          weight: 1.4,
          ingestRunId: testRunId,
        });
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeDefined();
      const cause = (thrown as { cause?: { constraint?: string } }).cause;
      expect(cause?.constraint).toBe("edges_weight_range_check");

      const rows = await db
        .select()
        .from(edges)
        .where(and(eq(edges.srcId, a.id), eq(edges.dstId, b.id)));
      expect(rows).toHaveLength(0);
    } finally {
      await db.delete(nodes).where(inArray(nodes.id, [a.id, b.id]));
    }
  });
});

describe("nodes.search (generated tsvector)", () => {
  it("stops matching a term removed from content", async () => {
    const term = `distinctiveterm${randomUUID().replace(/-/g, "")}`;
    const [node] = await db
      .insert(nodes)
      .values(nodeRow({ content: `a discussion of ${term} in context` }))
      .returning();
    if (!node) throw new Error("setup failed to insert node");

    try {
      const before = await db.execute<{ id: string }>(sql`
        SELECT id FROM nodes
        WHERE id = ${node.id} AND search @@ websearch_to_tsquery('english', ${term})
      `);
      expect(before.rows).toHaveLength(1);

      await db
        .update(nodes)
        .set({ content: "completely unrelated content now" })
        .where(eq(nodes.id, node.id));

      const after = await db.execute<{ id: string }>(sql`
        SELECT id FROM nodes
        WHERE id = ${node.id} AND search @@ websearch_to_tsquery('english', ${term})
      `);
      expect(after.rows).toHaveLength(0);
    } finally {
      await db.delete(nodes).where(eq(nodes.id, node.id));
    }
  });

  it("ranks a title match above a body match for the same term", async () => {
    const term = `rankterm${randomUUID().replace(/-/g, "")}`;
    const [titleNode] = await db
      .insert(nodes)
      .values(
        nodeRow({
          title: `${term} announcement`,
          content: "no relevant body text here",
        }),
      )
      .returning();
    const [bodyNode] = await db
      .insert(nodes)
      .values(
        nodeRow({
          title: "unrelated title",
          content: `deep in the body text: ${term}`,
        }),
      )
      .returning();
    if (!titleNode || !bodyNode) throw new Error("setup failed to insert nodes");

    try {
      const result = await db.execute<{ id: string; rank: number }>(sql`
        SELECT id, ts_rank_cd(search, websearch_to_tsquery('english', ${term})) AS rank
        FROM nodes
        WHERE id IN (${titleNode.id}, ${bodyNode.id})
        ORDER BY rank DESC
      `);

      expect(result.rows).toHaveLength(2);
      expect(result.rows[0]?.id).toBe(titleNode.id);
      expect(Number(result.rows[0]?.rank)).toBeGreaterThan(
        Number(result.rows[1]?.rank),
      );
    } finally {
      await db.delete(nodes).where(inArray(nodes.id, [titleNode.id, bodyNode.id]));
    }
  });
});

describe("resolved_nodes", () => {
  it("excludes a node once its merged_into is set, and keeps the survivor", async () => {
    const [survivor] = await db.insert(nodes).values(nodeRow()).returning();
    const [loser] = await db.insert(nodes).values(nodeRow()).returning();
    if (!survivor || !loser) throw new Error("setup failed to insert nodes");

    try {
      const beforeMerge = await db
        .select({ id: resolvedNodes.id })
        .from(resolvedNodes)
        .where(eq(resolvedNodes.id, loser.id));
      expect(beforeMerge).toHaveLength(1);

      await db
        .update(nodes)
        .set({ mergedInto: survivor.id })
        .where(eq(nodes.id, loser.id));

      const loserRows = await db
        .select({ id: resolvedNodes.id })
        .from(resolvedNodes)
        .where(eq(resolvedNodes.id, loser.id));
      expect(loserRows).toHaveLength(0);

      const survivorRows = await db
        .select({ id: resolvedNodes.id })
        .from(resolvedNodes)
        .where(eq(resolvedNodes.id, survivor.id));
      expect(survivorRows).toHaveLength(1);
    } finally {
      // `loser.merged_into` references `survivor.id` with no cascade, so
      // the child (loser) must be deleted before the parent (survivor).
      await db.delete(nodes).where(eq(nodes.id, loser.id));
      await db.delete(nodes).where(eq(nodes.id, survivor.id));
    }
  });
});

describe("nodes.merged_into (one-hop merge invariant)", () => {
  it("rejects a chained merge onto an already-merged-away node", async () => {
    const [root] = await db.insert(nodes).values(nodeRow()).returning();
    const [mid] = await db.insert(nodes).values(nodeRow()).returning();
    const [leaf] = await db.insert(nodes).values(nodeRow()).returning();
    if (!root || !mid || !leaf) throw new Error("setup failed to insert nodes");

    try {
      // mid merges directly into root (canonical) — this is the valid,
      // one-hop shape and must succeed.
      await db
        .update(nodes)
        .set({ mergedInto: root.id })
        .where(eq(nodes.id, mid.id));

      // leaf attempts to merge into mid, which is itself merged away
      // (mid.merged_into IS NOT NULL) — the trigger must reject this
      // rather than let a chain form silently.
      let thrown: unknown;
      try {
        await db
          .update(nodes)
          .set({ mergedInto: mid.id })
          .where(eq(nodes.id, leaf.id));
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeDefined();

      const [reloaded] = await db
        .select({ mergedInto: nodes.mergedInto })
        .from(nodes)
        .where(eq(nodes.id, leaf.id));
      expect(reloaded?.mergedInto).toBeNull();
    } finally {
      // Deletion order follows the merge_into references: leaf (never
      // merged) and mid (references root) must go before root.
      await db.delete(nodes).where(eq(nodes.id, leaf.id));
      await db.delete(nodes).where(eq(nodes.id, mid.id));
      await db.delete(nodes).where(eq(nodes.id, root.id));
    }
  });
});

describe("nodes.node_type", () => {
  it("inserts a node type never seen before, with no migration", async () => {
    const novelType = `novel-type-${randomUUID()}`;
    const [node] = await db
      .insert(nodes)
      .values(nodeRow({ nodeType: novelType }))
      .returning();
    if (!node) throw new Error("setup failed to insert node");

    try {
      expect(node.nodeType).toBe(novelType);

      const [reloaded] = await db
        .select({ nodeType: nodes.nodeType })
        .from(nodes)
        .where(eq(nodes.id, node.id));
      expect(reloaded?.nodeType).toBe(novelType);
    } finally {
      await db.delete(nodes).where(eq(nodes.id, node.id));
    }
  });
});
