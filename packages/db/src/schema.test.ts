import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, createPool, type Database } from "./client.js";
import { resolveDatabaseUrl } from "./env.js";
import { clientTokens, edges, hangarCheckIns, hangarMessages, ingestRuns, nodeRevisions, nodes, resolvedNodes } from "./schema.js";

/**
 * Integration tests against the real Postgres instance (no mocking) —
 * they exercise the constraints, generated columns, and triggers the
 * migrations in ./migrations/0000_*.sql and 0002_*.sql create, per
 * bd-vt2.2 and the node-history change. Every test creates and tears down
 * its own rows so the suite is re-runnable.
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

describe("node_revisions (history trigger)", () => {
  /** All revisions of one node, oldest first. */
  async function revisionsOf(nodeId: string) {
    return db
      .select()
      .from(nodeRevisions)
      .where(eq(nodeRevisions.nodeId, nodeId))
      .orderBy(nodeRevisions.revisionNo);
  }

  /** A second ingest run, for tests that need to tell "which run wrote this revision" apart. */
  async function secondRun(): Promise<string> {
    const [run] = await db
      .insert(ingestRuns)
      .values({ sourceSystem: "schema-test-suite-second-run" })
      .returning({ id: ingestRuns.id });
    if (!run) throw new Error("setup failed to insert second ingest run");
    return run.id;
  }

  it("inserting a node records exactly one revision, numbered one, holding the written state and the writing run", async () => {
    const [node] = await db
      .insert(nodes)
      .values(nodeRow({ nodeType: "work_item", title: "First title", content: "first content", metadata: { status: "open" } }))
      .returning();
    if (!node) throw new Error("setup failed to insert node");

    try {
      const revs = await revisionsOf(node.id);
      expect(revs).toHaveLength(1);
      expect(revs[0]).toMatchObject({
        revisionNo: 1,
        ingestRunId: testRunId,
        nodeType: "work_item",
        title: "First title",
        content: "first content",
        contentHash: node.contentHash,
        metadata: { status: "open" },
        mergedInto: null,
      });
      expect(revs[0]?.recordedAt).toBeInstanceOf(Date);
    } finally {
      await db.delete(nodes).where(eq(nodes.id, node.id));
    }
  });

  it("changing content under a second run records revision two with the new content while revision one still holds the old, each attributed to its own run", async () => {
    const [node] = await db.insert(nodes).values(nodeRow({ content: "v1" })).returning();
    if (!node) throw new Error("setup failed to insert node");
    const runTwo = await secondRun();

    try {
      await db.update(nodes).set({ content: "v2", ingestRunId: runTwo }).where(eq(nodes.id, node.id));

      const revs = await revisionsOf(node.id);
      expect(revs.map((r) => r.revisionNo)).toEqual([1, 2]);
      expect(revs[0]).toMatchObject({ content: "v1", ingestRunId: testRunId });
      expect(revs[1]).toMatchObject({ content: "v2", ingestRunId: runTwo });
    } finally {
      // The node now references runTwo, and its revisions cascade with
      // it — so node first, then the run.
      await db.delete(nodes).where(eq(nodes.id, node.id));
      await db.delete(ingestRuns).where(eq(ingestRuns.id, runTwo));
    }
  });

  it("a metadata-only update records a new revision holding the new metadata", async () => {
    const [node] = await db
      .insert(nodes)
      .values(nodeRow({ title: "Same title", content: "same content", metadata: { status: "open" } }))
      .returning();
    if (!node) throw new Error("setup failed to insert node");

    try {
      await db.update(nodes).set({ metadata: { status: "closed" } }).where(eq(nodes.id, node.id));

      const revs = await revisionsOf(node.id);
      expect(revs).toHaveLength(2);
      expect(revs[1]).toMatchObject({ revisionNo: 2, title: "Same title", content: "same content", metadata: { status: "closed" } });
    } finally {
      await db.delete(nodes).where(eq(nodes.id, node.id));
    }
  });

  it("rewriting a node's ingest_run_id (and re-setting identical values) records no revision", async () => {
    const [node] = await db
      .insert(nodes)
      .values(nodeRow({ title: "T", content: "C", metadata: { k: "v" } }))
      .returning();
    if (!node) throw new Error("setup failed to insert node");
    const runTwo = await secondRun();

    try {
      // Exactly what the batch upsert does on a no-op re-load: every
      // column rewritten (to the same values), ingest_run_id and
      // updated_at genuinely changed.
      await db
        .update(nodes)
        .set({ nodeType: node.nodeType, title: "T", content: "C", metadata: { k: "v" }, ingestRunId: runTwo, updatedAt: new Date() })
        .where(eq(nodes.id, node.id));

      const revs = await revisionsOf(node.id);
      expect(revs).toHaveLength(1);
      expect(revs[0]?.ingestRunId).toBe(testRunId);
    } finally {
      await db.delete(nodes).where(eq(nodes.id, node.id));
      await db.delete(ingestRuns).where(eq(ingestRuns.id, runTwo));
    }
  });

  it("setting merged_into records a revision carrying the new merge pointer", async () => {
    const [survivor] = await db.insert(nodes).values(nodeRow()).returning();
    const [loser] = await db.insert(nodes).values(nodeRow()).returning();
    if (!survivor || !loser) throw new Error("setup failed to insert nodes");

    try {
      await db.update(nodes).set({ mergedInto: survivor.id }).where(eq(nodes.id, loser.id));

      const loserRevs = await revisionsOf(loser.id);
      expect(loserRevs.map((r) => r.revisionNo)).toEqual([1, 2]);
      expect(loserRevs[0]?.mergedInto).toBeNull();
      expect(loserRevs[1]?.mergedInto).toBe(survivor.id);

      // The survivor itself was not written — no revision for it.
      expect(await revisionsOf(survivor.id)).toHaveLength(1);
    } finally {
      await db.delete(nodes).where(eq(nodes.id, loser.id));
      await db.delete(nodes).where(eq(nodes.id, survivor.id));
    }
  });

  it("the backfill statement gives a node without history revision one from its current row, attributed to its run, with recorded_at = updated_at", async () => {
    // updated_at is pinned to a value that cannot be confused with now(),
    // so recorded_at = updated_at below is a real assertion rather than
    // two now() calls in the same transaction happening to agree.
    const updatedAt = new Date("2020-01-02T03:04:05.000Z");
    const [node] = await db
      .insert(nodes)
      .values(nodeRow({ title: "Old", content: "predates history", metadata: { legacy: true }, updatedAt }))
      .returning();
    if (!node) throw new Error("setup failed to insert node");

    try {
      // Simulate a node written before node_revisions existed.
      await db.delete(nodeRevisions).where(eq(nodeRevisions.nodeId, node.id));
      expect(await revisionsOf(node.id)).toHaveLength(0);

      // The migration's backfill (migrations/0002_*.sql), scoped to this
      // one node.
      await db.execute(sql`
        INSERT INTO node_revisions (node_id, ingest_run_id, revision_no, node_type, title, content, content_hash, metadata, merged_into, recorded_at)
        SELECT id, ingest_run_id, 1, node_type, title, content, content_hash, metadata, merged_into, updated_at
        FROM nodes WHERE id = ${node.id}
      `);

      const revs = await revisionsOf(node.id);
      expect(revs).toHaveLength(1);
      expect(revs[0]).toMatchObject({
        revisionNo: 1,
        ingestRunId: testRunId,
        title: "Old",
        content: "predates history",
        contentHash: node.contentHash,
        metadata: { legacy: true },
        mergedInto: null,
      });
      expect(revs[0]?.recordedAt.getTime()).toBe(updatedAt.getTime());
    } finally {
      await db.delete(nodes).where(eq(nodes.id, node.id));
    }
  });

  it("two transactions updating the same node get revisions two and three, in commit order, with no duplicate number", async () => {
    const [node] = await db.insert(nodes).values(nodeRow({ content: "initial" })).returning();
    if (!node) throw new Error("setup failed to insert node");

    const clientA = await pool.connect();
    const clientB = await pool.connect();
    try {
      await clientA.query("BEGIN");
      await clientA.query("UPDATE nodes SET content = 'a' WHERE id = $1", [node.id]);

      // B blocks on A's row lock; its promise stays pending until A commits.
      await clientB.query("BEGIN");
      const pendingB = clientB.query("UPDATE nodes SET content = 'b' WHERE id = $1", [node.id]);
      await new Promise((resolve) => setTimeout(resolve, 50));

      await clientA.query("COMMIT");
      await pendingB;
      await clientB.query("COMMIT");

      const revs = await revisionsOf(node.id);
      expect(revs.map((r) => r.revisionNo)).toEqual([1, 2, 3]);
      expect(revs.map((r) => r.content)).toEqual(["initial", "a", "b"]);
    } finally {
      // On a failure path a client can still be idle-in-transaction,
      // holding the row lock the delete below needs — and it would go
      // back to the pool that way. A ROLLBACK after a successful COMMIT
      // is a harmless no-op, so it is unconditional.
      await clientA.query("ROLLBACK").catch(() => {});
      await clientB.query("ROLLBACK").catch(() => {});
      clientA.release();
      clientB.release();
      await db.delete(nodes).where(eq(nodes.id, node.id));
    }
  });

  it("inserting a second row with an existing (node_id, revision_no) is rejected by node_revisions_node_id_revision_no_key", async () => {
    const [node] = await db.insert(nodes).values(nodeRow()).returning();
    if (!node) throw new Error("setup failed to insert node");

    try {
      let thrown: unknown;
      try {
        await db.insert(nodeRevisions).values({
          nodeId: node.id,
          ingestRunId: testRunId,
          revisionNo: 1,
          nodeType: node.nodeType,
          title: node.title,
          content: node.content,
          contentHash: node.contentHash,
          metadata: node.metadata,
        });
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeDefined();
      const cause = (thrown as { cause?: { constraint?: string } }).cause;
      expect(cause?.constraint).toBe("node_revisions_node_id_revision_no_key");
      expect(await revisionsOf(node.id)).toHaveLength(1);
    } finally {
      await db.delete(nodes).where(eq(nodes.id, node.id));
    }
  });
});

// Unwraps drizzle's DrizzleQueryError to the underlying pg error fields.
function pgErrorOf(err: unknown): { code?: string; detail?: string; message?: string } | undefined {
  if (!(err instanceof Error)) return undefined;
  const cause = (err as { cause?: unknown }).cause;
  const candidate = cause && typeof cause === "object" ? cause : err;
  const { code, detail, message } = candidate as { code?: string; detail?: string; message?: string };
  return { code, detail, message };
}

describe("edges.blocks (acyclic invariant trigger)", () => {
  const POSTGRES_CHECK_VIOLATION = "23514";

  async function insertNodes(count: number): Promise<string[]> {
    const rows = await db
      .insert(nodes)
      .values(Array.from({ length: count }, () => nodeRow()))
      .returning({ id: nodes.id });
    if (rows.length !== count) throw new Error("setup failed to insert nodes");
    return rows.map((r) => r.id);
  }

  function blocks(srcId: string, dstId: string, edgeType = "blocks") {
    return db.insert(edges).values({ srcId, dstId, edgeType, sourceSystem: "schema-test", ingestRunId: testRunId });
  }

  async function expectCycleRejection(attempt: Promise<unknown>): Promise<{ detail: string }> {
    let thrown: unknown;
    try {
      await attempt;
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    const pg = pgErrorOf(thrown);
    expect(pg?.code).toBe(POSTGRES_CHECK_VIOLATION);
    expect(pg?.message).toContain("would form a cycle");
    expect(pg?.detail).toContain("endpoints:");
    return { detail: pg?.detail ?? "" };
  }

  it("rejects a direct cycle, naming the path back to the source", async () => {
    const [a, b] = await insertNodes(2);
    if (!a || !b) throw new Error("setup");
    try {
      await blocks(a, b);
      const { detail } = await expectCycleRejection(blocks(b, a));
      // The rejection names the folded endpoints of the refused edge.
      expect(detail).toBe(`endpoints: ${b} -> ${a}`);
      const stored = await db.select({ id: edges.id }).from(edges).where(and(eq(edges.srcId, b), eq(edges.dstId, a)));
      expect(stored).toHaveLength(0);
    } finally {
      await db.delete(nodes).where(inArray(nodes.id, [a, b]));
    }
  });

  it("rejects a node blocking itself", async () => {
    const [a] = await insertNodes(1);
    if (!a) throw new Error("setup");
    try {
      const { detail } = await expectCycleRejection(blocks(a, a));
      expect(detail).toBe(`endpoints: ${a} -> ${a}`);
    } finally {
      await db.delete(nodes).where(eq(nodes.id, a));
    }
  });

  it("rejects an indirect cycle and leaves the existing edges intact", async () => {
    const [a, b, c] = await insertNodes(3);
    if (!a || !b || !c) throw new Error("setup");
    try {
      await blocks(a, b);
      await blocks(b, c);
      const { detail } = await expectCycleRejection(blocks(c, a));
      expect(detail).toBe(`endpoints: ${c} -> ${a}`);
      const remaining = await db.select({ src: edges.srcId, dst: edges.dstId }).from(edges).where(inArray(edges.srcId, [a, b, c]));
      expect(remaining).toHaveLength(2);
    } finally {
      await db.delete(nodes).where(inArray(nodes.id, [a, b, c]));
    }
  });

  it("folds merged-away endpoints: an edge into a duplicate counts as an edge into its survivor", async () => {
    const [a, b, dup] = await insertNodes(3);
    if (!a || !b || !dup) throw new Error("setup");
    try {
      await blocks(a, dup);
      await db.update(nodes).set({ mergedInto: b }).where(eq(nodes.id, dup));
      // a -> dup is now a -> b once folded, so b -> a closes a cycle.
      const { detail } = await expectCycleRejection(blocks(b, a));
      expect(detail).toBe(`endpoints: ${b} -> ${a}`);
    } finally {
      await db.delete(nodes).where(inArray(nodes.id, [a, dup]));
      await db.delete(nodes).where(eq(nodes.id, b));
    }
  });

  it("accepts a non-cyclic chain, including a shortcut edge", async () => {
    const [a, b, c] = await insertNodes(3);
    if (!a || !b || !c) throw new Error("setup");
    try {
      await blocks(a, b);
      await blocks(b, c);
      await blocks(a, c);
      const stored = await db.select({ id: edges.id }).from(edges).where(inArray(edges.srcId, [a, b, c]));
      expect(stored).toHaveLength(3);
    } finally {
      await db.delete(nodes).where(inArray(nodes.id, [a, b, c]));
    }
  });

  it("rejects both halves of a cycle arriving in one statement", async () => {
    const [a, b] = await insertNodes(2);
    if (!a || !b) throw new Error("setup");
    try {
      await expectCycleRejection(
        db.insert(edges).values([
          { srcId: a, dstId: b, edgeType: "blocks", sourceSystem: "schema-test", ingestRunId: testRunId },
          { srcId: b, dstId: a, edgeType: "blocks", sourceSystem: "schema-test", ingestRunId: testRunId },
        ]),
      );
      const stored = await db.select({ id: edges.id }).from(edges).where(inArray(edges.srcId, [a, b]));
      expect(stored).toHaveLength(0);
    } finally {
      await db.delete(nodes).where(inArray(nodes.id, [a, b]));
    }
  });

  it("leaves other edge types alone: mutual mentions are fine", async () => {
    const [a, b] = await insertNodes(2);
    if (!a || !b) throw new Error("setup");
    try {
      await blocks(a, b, "mentions");
      await blocks(b, a, "mentions");
      const stored = await db.select({ id: edges.id }).from(edges).where(inArray(edges.srcId, [a, b]));
      expect(stored).toHaveLength(2);
    } finally {
      await db.delete(nodes).where(inArray(nodes.id, [a, b]));
    }
  });
});

describe("nodes.metadata GIN index", () => {
  it("serves a containment predicate through nodes_metadata_gin_idx", async () => {
    // The dev store is small enough that the planner may prefer a
    // sequential scan; disabling it for this transaction proves the
    // index is *usable* for `@>`, which is the property that matters.
    const plan = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      const result = await tx.execute<{ "QUERY PLAN": unknown }>(
        sql`EXPLAIN (FORMAT JSON) SELECT id FROM nodes WHERE metadata @> '{"status":"open"}'::jsonb`,
      );
      return JSON.stringify(result.rows);
    });
    expect(plan).toContain("nodes_metadata_gin_idx");
  });
});


describe("edges.blocks trigger: cycles that already exist through a merge", () => {
  it("re-asserting a stored edge succeeds while a genuinely new cycle-closing edge is still refused", async () => {
    const rows = await db.insert(nodes).values([nodeRow(), nodeRow(), nodeRow()]).returning({ id: nodes.id });
    const [a, b, c] = rows.map((r) => r.id);
    if (!a || !b || !c) throw new Error("setup");
    const edge = (srcId: string, dstId: string, sourceSystem = "schema-test") =>
      db.insert(edges).values({ srcId, dstId, edgeType: "blocks", sourceSystem, ingestRunId: testRunId }).onConflictDoNothing();
    try {
      await edge(a, b);
      await edge(b, c);
      // Merging c into a closes a -> b -> (c = a): a cycle the trigger never saw.
      await db.update(nodes).set({ mergedInto: a }).where(eq(nodes.id, c));

      // The idempotent re-import shape: the same edge, same and different
      // source system. Neither adds reachability, so neither is refused.
      await edge(a, b);
      await edge(a, b, "schema-test-other");
      await edge(b, c);

      // A new edge that closes the cycle directly is still a cycle.
      let thrown: unknown;
      try {
        await edge(b, a);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeDefined();
      expect(pgErrorOf(thrown)?.code).toBe("23514");

      const stored = await db.select({ src: edges.srcId, dst: edges.dstId, source: edges.sourceSystem }).from(edges).where(inArray(edges.srcId, [a, b, c]));
      expect(stored).toHaveLength(3);
    } finally {
      await db.delete(nodes).where(inArray(nodes.id, [b, c]));
      await db.delete(nodes).where(eq(nodes.id, a));
    }
  });
});

describe("client_tokens", () => {
  /** Runs `fn` and returns the driver error it threw (drizzle wraps it as `.cause`). */
  async function pgErrorOf(fn: () => Promise<unknown>): Promise<{ code?: string; constraint?: string }> {
    try {
      await fn();
    } catch (err) {
      return ((err as { cause?: unknown }).cause ?? err) as { code?: string; constraint?: string };
    }
    throw new Error("expected the statement to be refused");
  }

  function clientName(): string {
    return `schema-test-${randomUUID()}`;
  }

  it("refuses a second live token for the same client", async () => {
    const client = clientName();
    try {
      await db.insert(clientTokens).values({ client, tokenHash: randomBytes(32), scope: "human" });
      const refused = await pgErrorOf(() => db.insert(clientTokens).values({ client, tokenHash: randomBytes(32), scope: "human" }));
      expect(refused.code).toBe("23505");
      expect(refused.constraint).toBe("client_tokens_live_client_idx");
    } finally {
      await db.delete(clientTokens).where(eq(clientTokens.client, client));
    }
  });

  it("re-issues a client after its token is revoked, keeping the revoked row", async () => {
    const client = clientName();
    try {
      await db.insert(clientTokens).values({ client, tokenHash: randomBytes(32), scope: "human" });
      await db.update(clientTokens).set({ revokedAt: sql`now()` }).where(eq(clientTokens.client, client));
      await db.insert(clientTokens).values({ client, tokenHash: randomBytes(32), scope: "human" });
      const rows = await db.select().from(clientTokens).where(eq(clientTokens.client, client));
      expect(rows).toHaveLength(2);
      expect(rows.filter((r) => r.revokedAt === null)).toHaveLength(1);
    } finally {
      await db.delete(clientTokens).where(eq(clientTokens.client, client));
    }
  });

  it("accepts a hangar scope and refuses any other unknown one", async () => {
    const client = clientName();
    try {
      await db.insert(clientTokens).values({ client, tokenHash: randomBytes(32), scope: "hangar" });
      const [row] = await db.select({ scope: clientTokens.scope }).from(clientTokens).where(eq(clientTokens.client, client));
      expect(row?.scope).toBe("hangar");
      const admin = await pgErrorOf(() => db.execute(sql`INSERT INTO client_tokens (client, token_hash, scope) VALUES (${clientName()}, ${randomBytes(32)}, 'admin')`));
      expect(admin.code).toBe("23514");
      expect(admin.constraint).toBe("client_tokens_scope_check");
    } finally {
      await db.delete(clientTokens).where(eq(clientTokens.client, client));
    }
  });

  it("binds a session only to an agent token", async () => {
    const agent = clientName();
    const sessionId = randomUUID();
    try {
      await db.insert(clientTokens).values({ client: agent, tokenHash: randomBytes(32), scope: "agent", sessionId });
      const [row] = await db.select({ sessionId: clientTokens.sessionId }).from(clientTokens).where(eq(clientTokens.client, agent));
      expect(row?.sessionId).toBe(sessionId);
      for (const scope of ["human", "hangar"] as const) {
        const refused = await pgErrorOf(() => db.insert(clientTokens).values({ client: clientName(), tokenHash: randomBytes(32), scope, sessionId }));
        expect(refused.code, scope).toBe("23514");
        expect(refused.constraint, scope).toBe("client_tokens_session_scope_check");
      }
    } finally {
      await db.delete(clientTokens).where(eq(clientTokens.client, agent));
    }
  });

  it("requires a scope of human or agent, with no default", async () => {
    const client = clientName();
    try {
      const missing = await pgErrorOf(() => db.execute(sql`INSERT INTO client_tokens (client, token_hash) VALUES (${client}, ${randomBytes(32)})`));
      expect(missing.code).toBe("23502");
      const unknown = await pgErrorOf(() => db.execute(sql`INSERT INTO client_tokens (client, token_hash, scope) VALUES (${client}, ${randomBytes(32)}, 'admin')`));
      expect(unknown.code).toBe("23514");
      expect(unknown.constraint).toBe("client_tokens_scope_check");
      await db.insert(clientTokens).values({ client, tokenHash: randomBytes(32), scope: "agent" });
      const [row] = await db.select({ scope: clientTokens.scope }).from(clientTokens).where(eq(clientTokens.client, client));
      expect(row?.scope).toBe("agent");
    } finally {
      await db.delete(clientTokens).where(eq(clientTokens.client, client));
    }
  });

  it("refuses a duplicate token_hash, even across clients", async () => {
    const a = clientName();
    const b = clientName();
    const hash = randomBytes(32);
    try {
      await db.insert(clientTokens).values({ client: a, tokenHash: hash, scope: "human" });
      const refused = await pgErrorOf(() => db.insert(clientTokens).values({ client: b, tokenHash: hash, scope: "human" }));
      expect(refused.code).toBe("23505");
      expect(refused.constraint).toBe("client_tokens_token_hash_unique");
    } finally {
      await db.delete(clientTokens).where(inArray(clientTokens.client, [a, b]));
    }
  });

  it("defaults id and created_at, and leaves last_used_at and revoked_at null", async () => {
    const client = clientName();
    const hash = randomBytes(32);
    try {
      const [row] = await db.insert(clientTokens).values({ client, tokenHash: hash, scope: "human" }).returning();
      if (!row) throw new Error("insert returned no row");
      expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(row.createdAt).toBeInstanceOf(Date);
      expect(Math.abs(row.createdAt.getTime() - Date.now())).toBeLessThan(60_000);
      expect(row.lastUsedAt).toBeNull();
      expect(row.revokedAt).toBeNull();
      expect(Buffer.compare(row.tokenHash, hash)).toBe(0);
    } finally {
      await db.delete(clientTokens).where(eq(clientTokens.client, client));
    }
  });
});

describe("hangar_check_ins", () => {
  it("keeps one row per hangar: a second check-in upserts on the primary key", async () => {
    const hangar = `schema-test-hangar-${randomUUID()}`;
    try {
      const [first] = await db.insert(hangarCheckIns).values({ hangar, version: "1.0.0" }).returning();
      expect(first).toMatchObject({ hangar, version: "1.0.0", capacity: null, intervalS: 30 });
      expect(first?.lastSeenAt).toBeInstanceOf(Date);

      const duplicate = await db.insert(hangarCheckIns).values({ hangar }).catch((err: unknown) => ((err as { cause?: unknown }).cause ?? err) as { code?: string });
      expect((duplicate as { code?: string }).code).toBe("23505");

      await db
        .insert(hangarCheckIns)
        .values({ hangar, version: "1.1.0", capacity: { slots: 2 } })
        .onConflictDoUpdate({ target: hangarCheckIns.hangar, set: { version: "1.1.0", capacity: { slots: 2 }, lastSeenAt: sql`now()` } });
      const rows = await db.select().from(hangarCheckIns).where(eq(hangarCheckIns.hangar, hangar));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ version: "1.1.0", capacity: { slots: 2 } });
    } finally {
      await db.delete(hangarCheckIns).where(eq(hangarCheckIns.hangar, hangar));
    }
  });
});

describe("hangar_messages", () => {
  it("assigns increasing ids and serves a session's cursor read through (session_id, id)", async () => {
    const sessionId = randomUUID();
    try {
      const inserted = await db
        .insert(hangarMessages)
        .values([
          { sessionId, kind: "test", body: { n: 1 } },
          { sessionId, kind: "test", body: { n: 2 } },
        ])
        .returning({ id: hangarMessages.id, createdAt: hangarMessages.createdAt });
      expect(inserted).toHaveLength(2);
      expect(inserted[1]!.id).toBeGreaterThan(inserted[0]!.id);
      expect(inserted[0]!.createdAt).toBeInstanceOf(Date);

      const index = await db.execute<{ indexdef: string }>(sql`SELECT indexdef FROM pg_indexes WHERE tablename = 'hangar_messages' AND indexname = 'hangar_messages_session_id_id_idx'`);
      expect(index.rows[0]?.indexdef).toMatch(/\(session_id, id\)/);
    } finally {
      await db.delete(hangarMessages).where(eq(hangarMessages.sessionId, sessionId));
    }
  });
});
