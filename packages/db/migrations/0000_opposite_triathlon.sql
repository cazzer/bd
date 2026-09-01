-- Hand-written (drizzle-kit cannot generate CREATE EXTENSION): trigram
-- similarity support for the fuzzy fallback path (retrieval spec, "Fuzzy
-- fallback when exact search finds nothing"). No `vector` extension is
-- created — this project does no embedding/vector search.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE TABLE "edges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"src_id" uuid NOT NULL,
	"dst_id" uuid NOT NULL,
	"edge_type" text NOT NULL,
	"weight" real DEFAULT 1 NOT NULL,
	"source_system" text NOT NULL,
	"ingest_run_id" uuid NOT NULL,
	"props" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "edges_src_dst_type_source_key" UNIQUE("src_id","dst_id","edge_type","source_system"),
	CONSTRAINT "edges_weight_range_check" CHECK ("edges"."weight" >= 0 AND "edges"."weight" <= 1)
);
--> statement-breakpoint
CREATE TABLE "ingest_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_system" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"node_count" integer DEFAULT 0 NOT NULL,
	"edge_count" integer DEFAULT 0 NOT NULL,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_type" text NOT NULL,
	"source_system" text NOT NULL,
	"external_id" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"content_hash" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"merged_into" uuid,
	"ingest_run_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- Hand-written (drizzle-orm's pg-core has no tsvector column type or
	-- STORED-generated-column builder): the store maintains this itself,
	-- so there is no way to write a node that is not searchable, and no
	-- separate reindex step (knowledge-store spec, "Content is indexed
	-- for full-text search"). Title matches outrank body matches via the
	-- 'A'/'B' weights, scored later with ts_rank_cd.
	"search" tsvector GENERATED ALWAYS AS (
		setweight(to_tsvector('english', coalesce("title", '')), 'A') ||
		setweight(to_tsvector('english', coalesce("content", '')), 'B')
	) STORED,
	CONSTRAINT "nodes_source_system_external_id_key" UNIQUE("source_system","external_id")
);
--> statement-breakpoint
-- src_id/dst_id point at whatever node was asserted at write time, which
-- may since have been merged away. Edges attached to a merged-away node
-- must stay reachable from its survivor (knowledge-store spec: "Edges
-- attached to the merged node SHALL be reachable from the survivor
-- without losing their original provenance"), so traversal (bd-vt2.4)
-- must fold BOTH endpoints through coalesce(merged_into, id) — the same
-- canonical_id resolution used for resolved_nodes below — not join on
-- src_id/dst_id as stored.
ALTER TABLE "edges" ADD CONSTRAINT "edges_src_id_nodes_id_fk" FOREIGN KEY ("src_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_dst_id_nodes_id_fk" FOREIGN KEY ("dst_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_ingest_run_id_ingest_runs_id_fk" FOREIGN KEY ("ingest_run_id") REFERENCES "public"."ingest_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_merged_into_nodes_id_fk" FOREIGN KEY ("merged_into") REFERENCES "public"."nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_ingest_run_id_ingest_runs_id_fk" FOREIGN KEY ("ingest_run_id") REFERENCES "public"."ingest_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "edges_src_id_edge_type_idx" ON "edges" USING btree ("src_id","edge_type");--> statement-breakpoint
CREATE INDEX "edges_dst_id_edge_type_idx" ON "edges" USING btree ("dst_id","edge_type");--> statement-breakpoint
-- Hand-written: GIN index backing full-text search over the generated
-- tsvector column above (retrieval spec, "Text search selects seeds").
CREATE INDEX "nodes_search_gin_idx" ON "nodes" USING gin ("search");--> statement-breakpoint
-- Hand-written: trigram GIN indexes backing the fuzzy fallback path,
-- used only when full-text search returns zero seeds (retrieval spec,
-- "Fuzzy fallback when exact search finds nothing"). Two indexes, not
-- one, because the fallback matches title and content independently
-- and pg_trgm has no equivalent of tsvector's weighted concatenation.
CREATE INDEX "nodes_title_trgm_idx" ON "nodes" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "nodes_content_trgm_idx" ON "nodes" USING gin ("content" gin_trgm_ops);--> statement-breakpoint
-- Hand-written (drizzle-orm's pg-core has no trigger builder): enforces
-- the one-hop merge invariant that resolved_nodes and traversal both
-- depend on — `nodes.merged_into` must always point directly at a
-- canonical node (one whose own `merged_into` IS NULL), never chain.
--
-- This is a cross-row rule (it has to read the target row), which a
-- CHECK constraint cannot express, so it needs a trigger. It is a
-- database invariant, not business logic: a chained merge that slips
-- through silently drops search results with no error anywhere, in a
-- system whose whole job is surfacing context. The cost is a single-row
-- lookup on merge writes, a rare operation.
--
-- Chain collapsing itself (repointing an existing chain's members
-- directly at the ultimate survivor) stays the write path's job
-- (bd-vt2.3's mergeNodes); this trigger only refuses to let a new chain
-- form, it does not repair one.
CREATE FUNCTION nodes_merged_into_must_be_canonical() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	target_merged_into uuid;
BEGIN
	SELECT merged_into INTO target_merged_into FROM nodes WHERE id = NEW.merged_into;
	IF target_merged_into IS NOT NULL THEN
		RAISE EXCEPTION 'nodes.merged_into must point at a canonical node: node % is already merged into %', NEW.merged_into, target_merged_into
			USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER nodes_merged_into_canonical_trigger
	BEFORE INSERT OR UPDATE OF merged_into ON nodes
	FOR EACH ROW
	WHEN (NEW.merged_into IS NOT NULL)
	EXECUTE FUNCTION nodes_merged_into_must_be_canonical();--> statement-breakpoint
-- Hand-written (drizzle-kit cannot generate CREATE VIEW): canonical-only
-- read path for merged nodes.
--
-- Invariant this view depends on: `nodes.merged_into` always points
-- directly at a canonical node (one whose own `merged_into` IS NULL).
-- Merge chains are collapsed at write time (bd-vt2.3's mergeNodes) and
-- new chains are refused outright by nodes_merged_into_canonical_trigger
-- above, so this view only ever needs one hop, never a recursive walk.
--
-- This view alone does not solve retrieval's "search over merged
-- nodes" requirement: a text match on a merged-away node's content must
-- still surface its survivor once, not the merged-away row (retrieval
-- spec). That requires scanning all of `nodes`, not just this view, and
-- folding each match onto `coalesce(merged_into, id)` — the
-- "canonical_id" resolution handle bd-vt2.4's retrieval query uses.
-- That fold is a caller-side expression evaluated over `nodes`
-- directly, not a second view or stored function, so it is not defined
-- here.
--
-- NOTE for whoever adds a column to `nodes` next: this view is
-- `SELECT *`, which Postgres freezes into `nodes`' column list as of
-- right now, at CREATE VIEW time — a later ALTER TABLE nodes ADD COLUMN
-- will not appear here automatically. Ship `CREATE OR REPLACE VIEW
-- resolved_nodes AS SELECT * FROM nodes WHERE merged_into IS NULL;` in
-- that same migration.
CREATE VIEW "resolved_nodes" AS
	SELECT * FROM "nodes" WHERE "merged_into" IS NULL;