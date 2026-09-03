import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  pgView,
  real,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Application schema for the knowledge store (bd-vt2.2): `ingest_runs`,
 * `nodes`, `node_revisions`, `edges`, and the `resolved_nodes` view.
 *
 * Six constructs below cannot be expressed through drizzle-orm's
 * pg-core column/index builders and are instead hand-written directly
 * into the generated migration SQL (see migrations/0000_*.sql and
 * migrations/0002_*.sql):
 *
 *   1. `nodes.search` — a `GENERATED ALWAYS AS (...) STORED` tsvector
 *      column. pg-core has no `tsvector` column type and no builder for
 *      STORED generated expressions, so this column is absent from the
 *      `nodes` table below.
 *   2. The `pg_trgm` extension and the GIN indexes it backs: the
 *      full-text GIN index on `nodes.search` (which needs #1 to exist
 *      first) and the trigram GIN indexes on `nodes.title` /
 *      `nodes.content`. All three are hand-written together in the
 *      migration immediately after the generated column.
 *   3. `resolved_nodes` — declared below as an `existing()` view purely
 *      for typed query access; its DDL is hand-written (see the comment
 *      on the declaration).
 *   4. A trigger enforcing the one-hop merge invariant on
 *      `nodes.merged_into` (see the comment on that column). pg-core has
 *      no trigger builder at all, and this is a cross-row rule a CHECK
 *      constraint cannot express.
 *   5. Two AFTER ROW triggers on `nodes` recording append-only history
 *      into `node_revisions` (migrations/0002_*.sql): AFTER INSERT
 *      unconditionally, and AFTER UPDATE only `WHEN` a history-relevant
 *      column (node_type, title, content, metadata, merged_into)
 *      actually changed, both sharing `nodes_record_revision()`. The
 *      same migration carries the one-time backfill that gives every
 *      pre-existing node its revision one. Same justification as #4:
 *      "every change leaves a record" is a property of the table, not
 *      of any caller — four write paths touch `nodes` today and more
 *      loaders are planned, and one that forgot to record a revision
 *      would fail silently.
 *   6. A BEFORE trigger on `edges` refusing any `blocks` edge that would
 *      make a node transitively block itself (migrations/0003_*.sql,
 *      function replaced in 0004_*.sql to skip already-stored edges,
 *      work-items spec, "Blocking and parent relationships"). Endpoints
 *      are folded through `merged_into`, the walk is serialized by an
 *      advisory transaction lock so two concurrent inserts cannot each
 *      see no cycle and together form one, and the rejection carries the
 *      path in DETAIL. Same justification as #4 and #5: a cross-row rule
 *      no CHECK can express, with a silent failure mode (an item that
 *      can never become ready) if any write path forgot it.
 *
 * Everything else (tables, columns, PK/FK/UNIQUE/CHECK constraints, the
 * two plain B-tree lookup indexes on `edges`, and the GIN
 * `jsonb_path_ops` index on `nodes.metadata`) round-trips through
 * `drizzle-kit generate` unmodified.
 */

export const ingestRuns = pgTable("ingest_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  sourceSystem: text("source_system").notNull(),
  // Who or what drove the run — the MCP client's `name version` from its
  // initialize handshake, `human` from the web app, a loader's script
  // name. Attribution, not authentication: it records what the caller
  // said it was. `source_system` remains the provenance of the content
  // itself; the two are separate columns because one source system can
  // be written by many actors (knowledge-store spec, "Two agents writing
  // under one source system"). Nullable: a run opened naming only a
  // source system records no actor.
  actor: text("actor"),
  startedAt: timestamp("started_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  nodeCount: integer("node_count").notNull().default(0),
  edgeCount: integer("edge_count").notNull().default(0),
  stats: jsonb("stats").notNull().default(sql`'{}'::jsonb`),
});

export const nodes = pgTable(
  "nodes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Open discriminator, not a Postgres enum: new node types (work
    // items, specs, conversations, ...) must never require a migration
    // (knowledge-store spec, "Unrecognized node type").
    nodeType: text("node_type").notNull(),
    sourceSystem: text("source_system").notNull(),
    externalId: text("external_id").notNull(),
    // NOT NULL DEFAULT '' rather than nullable: the spec says every node
    // "SHALL have ... a title", and a null/empty/value three-state
    // distinction buys nothing here. The generated column below still
    // coalesces it — harmless, and robust if that ever changes.
    title: text("title").notNull().default(""),
    content: text("content").notNull().default(""),
    contentHash: text("content_hash").notNull(),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    // Merge pointer: set on the loser, points at the survivor. No
    // onDelete action — a survivor being deleted while merged-away rows
    // still point at it should fail loudly, not silently cascade or
    // null out the merge (see the resolved_nodes comment below for the
    // invariant this maintains).
    //
    // That invariant — merged_into always points directly at a
    // canonical node — is enforced by a hand-written trigger
    // (nodes_merged_into_must_be_canonical, see migrations/0000_*.sql),
    // not a CHECK: rejecting a chained merge requires reading the
    // target row, which a CHECK constraint cannot do. This is a
    // database invariant, not business logic — the failure mode
    // without it (a chained merge silently drops search results with
    // no error anywhere) is exactly what triggers exist to prevent.
    mergedInto: uuid("merged_into").references((): AnyPgColumn => nodes.id),
    // No onDelete action, for the same reason: deleting an ingest run
    // that nodes still reference should fail visibly rather than
    // silently orphaning provenance. NOT NULL: every write is
    // attributable to a run (knowledge-store spec, "Writes are
    // attributable to an ingest run") — a nullable column would let an
    // unattributable row defeat that requirement silently.
    ingestRunId: uuid("ingest_run_id")
      .notNull()
      .references(() => ingestRuns.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Bumped by the write path (bd-vt2.3) on every upsert that changes a
    // row; not trigger-maintained here — an UPDATE-timestamp trigger
    // would be enforcing write-path behavior, not a database invariant.
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // `search` (generated tsvector, GIN-indexed) is hand-written into
    // the migration SQL — see the file header comment.
    //
    // Revision history deliberately adds NO column here: it lives in
    // `node_revisions` below, so `resolved_nodes` (whose `SELECT *` froze
    // this column list at CREATE VIEW time — see its comment) stays
    // untouched.
  },
  (table) => [
    // The deterministic dedup key the idempotent-write story rests on.
    unique("nodes_source_system_external_id_key").on(
      table.sourceSystem,
      table.externalId,
    ),
    // Trigram GIN indexes on title/content are hand-written alongside
    // the pg_trgm extension — see the file header comment.
    //
    // Partial B-tree index backing the retrieval query's `alias` CTE
    // (bd-vt2.4, docs/retrieval-query-design.md), which groups every
    // merged-away node by its survivor on every single retrieval call.
    // Without it that CTE sequentially scans all of `nodes` — measured
    // 8.2ms vs 0.055ms at 30k rows, ~22% of total retrieval time, and
    // growing linearly while the rest of the query does not. `WHERE
    // merged_into IS NOT NULL` keeps it small: most nodes are never
    // merged away, and the retrieval query only ever looks up rows that
    // have a non-null merged_into. Expressible through pg-core's index
    // builder (unlike the tsvector/GIN/trigram/trigger constructs above),
    // so — unlike those — this one round-trips through `drizzle-kit
    // generate` into its own additive migration rather than being
    // hand-written.
    index("nodes_merged_into_idx")
      .on(table.mergedInto)
      .where(sql`${table.mergedInto} IS NOT NULL`),
    // GIN index serving the structured listing's metadata predicates
    // (knowledge-store spec, "Nodes can be listed by structure without
    // query text"; packages/core/src/list.ts). Every predicate the
    // listing accepts compiles to a jsonb containment test
    // (`metadata @> '{...}'`), and that is the only operator ever issued
    // against this column — so `jsonb_path_ops`, which indexes only
    // containment and is smaller and faster for it than the default
    // opclass. Unlike the trigram indexes (hand-written: they need
    // pg_trgm) this round-trips through `drizzle-kit generate`.
    index("nodes_metadata_gin_idx").using("gin", table.metadata.op("jsonb_path_ops")),
  ],
);

/**
 * `node_revisions` — append-only history of `nodes` (knowledge-store
 * spec, "Every change to a node is recorded as a revision"). One row per
 * change to a node's type, title, content, metadata, or merge pointer,
 * holding the node's full state after the change; written only by the
 * hand-written triggers described in the file header (#5), never by
 * application code, so no write path can skip it. `nodes` stays
 * authoritative — nothing reads these rows back into it.
 *
 * Rows are full snapshots, not diffs: what changed between two revisions
 * is computed on read (packages/core/src/history.ts), never stored.
 * `revision_no` counts from one per node in the order recorded, assigned
 * by the trigger as one more than the node's current maximum.
 */
export const nodeRevisions = pgTable(
  "node_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Cascade, like `edges`: history for a node that no longer exists has
    // nothing to describe, and every test suite deletes its fixture nodes
    // in cleanup — a no-action key would fail on the first revision ever
    // written. No application delete path exists today; when one is
    // designed, that migration decides between keeping the cascade and
    // switching to a no-action key with tombstones (design.md, Risks).
    nodeId: uuid("node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    // No onDelete action, same as nodes.ingestRunId: a run that revisions
    // still name must not be silently deletable.
    ingestRunId: uuid("ingest_run_id")
      .notNull()
      .references(() => ingestRuns.id),
    revisionNo: integer("revision_no").notNull(),
    nodeType: text("node_type").notNull(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    contentHash: text("content_hash").notNull(),
    metadata: jsonb("metadata").notNull(),
    // A snapshot of a past value, deliberately with no FK: an FK on
    // history would block deleting a survivor that a stale revision
    // still names.
    mergedInto: uuid("merged_into"),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Doubles as the index: its btree serves both "latest N" (backward
    // scan) and "revision N" (keyed read), and turns any concurrent-
    // numbering race the trigger's row-lock ordering does not already
    // prevent into a loud unique violation rather than a duplicate
    // number. A second `(node_id, revision_no DESC)` index would be pure
    // write cost.
    unique("node_revisions_node_id_revision_no_key").on(
      table.nodeId,
      table.revisionNo,
    ),
  ],
);

export const edges = pgTable(
  "edges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Cascade: an edge is meaningless once either endpoint is gone.
    //
    // src_id/dst_id point at whatever node was asserted at write time,
    // which may since have been merged away. Edges attached to a
    // merged-away node must stay reachable from its survivor (spec:
    // "Edges attached to the merged node SHALL be reachable from the
    // survivor without losing their original provenance"), so
    // traversal (bd-vt2.4) must fold both endpoints through
    // coalesce(merged_into, id) — the same canonical_id resolution
    // documented on resolved_nodes below — not just src_id/dst_id
    // as stored.
    srcId: uuid("src_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    dstId: uuid("dst_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    edgeType: text("edge_type").notNull(),
    weight: real("weight").notNull().default(1.0),
    sourceSystem: text("source_system").notNull(),
    // No onDelete action — same reasoning as nodes.ingestRunId above.
    // NOT NULL for the same audit-trail reason as nodes.ingestRunId.
    ingestRunId: uuid("ingest_run_id")
      .notNull()
      .references(() => ingestRuns.id),
    props: jsonb("props").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Collapses re-assertion by one source system; independent
    // assertions of the same edge by different systems are distinct
    // rows (knowledge-store spec, "Same relationship asserted by two
    // systems").
    unique("edges_src_dst_type_source_key").on(
      table.srcId,
      table.dstId,
      table.edgeType,
      table.sourceSystem,
    ),
    // Traversal follows edges in both directions (retrieval spec,
    // "Bounded subgraph expansion") — one lookup index per direction,
    // each covering the edge_type filter used during expansion.
    index("edges_src_id_edge_type_idx").on(table.srcId, table.edgeType),
    index("edges_dst_id_edge_type_idx").on(table.dstId, table.edgeType),
    check(
      "edges_weight_range_check",
      sql`${table.weight} >= 0 AND ${table.weight} <= 1`,
    ),
  ],
);

/**
 * `resolved_nodes` — canonical rows only (`WHERE merged_into IS NULL`).
 *
 * Invariant this view is built on: `merged_into` always points directly
 * at a canonical node (a node whose own `merged_into` IS NULL). Merge
 * chains are collapsed at write time (bd-vt2.3's mergeNodes), so no
 * reader — this view included — ever needs to walk more than one hop.
 *
 * This does not by itself solve search-over-merged-nodes: the
 * retrieval spec requires that a match on a merged-away node's content
 * surface its survivor once, not the merged-away row. That requires
 * scanning all of `nodes` (not just this view) and folding each match
 * onto `coalesce(merged_into, id)` — the `canonical_id` resolution
 * handle. That fold is a caller-side expression, not a second view or
 * function, so it is not defined here; bd-vt2.4's retrieval query is
 * where `coalesce(merged_into, id)` gets used.
 *
 * DDL is hand-written in the migration (see migrations/0000_*.sql)
 * because it is a plain `SELECT * FROM nodes WHERE merged_into IS
 * NULL` with the invariant comment attached to it; drizzle-kit has no
 * way to generate a `CREATE VIEW` from a `.existing()` declaration, and
 * driving it through `.as(sql...)` would just be this same raw SQL
 * wrapped in another layer. Declared here as `.existing()` so
 * downstream packages get typed `db.select().from(resolvedNodes)`
 * access without drizzle-kit trying to manage/regenerate the view.
 */
export const resolvedNodes = pgView("resolved_nodes", {
  id: uuid("id").notNull(),
  nodeType: text("node_type").notNull(),
  sourceSystem: text("source_system").notNull(),
  externalId: text("external_id").notNull(),
  title: text("title").notNull(),
  content: text("content").notNull(),
  contentHash: text("content_hash").notNull(),
  metadata: jsonb("metadata").notNull(),
  mergedInto: uuid("merged_into"),
  ingestRunId: uuid("ingest_run_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
}).existing();
