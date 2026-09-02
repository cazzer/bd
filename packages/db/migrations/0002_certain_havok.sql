CREATE TABLE "node_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid NOT NULL,
	"ingest_run_id" uuid NOT NULL,
	"revision_no" integer NOT NULL,
	"node_type" text NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"metadata" jsonb NOT NULL,
	"merged_into" uuid,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "node_revisions_node_id_revision_no_key" UNIQUE("node_id","revision_no")
);
--> statement-breakpoint
ALTER TABLE "ingest_runs" ADD COLUMN "actor" text;--> statement-breakpoint
ALTER TABLE "node_revisions" ADD CONSTRAINT "node_revisions_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_revisions" ADD CONSTRAINT "node_revisions_ingest_run_id_ingest_runs_id_fk" FOREIGN KEY ("ingest_run_id") REFERENCES "public"."ingest_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Hand-written (drizzle-orm's pg-core has no trigger builder): append-only
-- revision history for nodes (knowledge-store spec, "Every change to a node
-- is recorded as a revision"). One function, two triggers:
--
--   * AFTER INSERT, unconditional — a node's first revision is its creation.
--   * AFTER UPDATE, only WHEN one of node_type, title, content, metadata,
--     merged_into actually changed.
--
-- The WHEN list is deliberately NOT `OLD.* IS DISTINCT FROM NEW.*`: the
-- batch upsert (packages/core/src/nodes.ts) rewrites ingest_run_id on every
-- row it touches, changed or not, so a whole-row comparison would mint a
-- revision on every no-op re-load and break the spec's "Unchanged re-load"
-- scenario. updated_at is excluded for the same reason: it is bookkeeping
-- about the statement, not state of the node.
--
-- Two triggers rather than one INSERT OR UPDATE trigger because a WHEN
-- clause cannot reference OLD on INSERT, and branching on TG_OP inside the
-- function would run it for every unchanged row instead of letting
-- Postgres skip the call entirely.
--
-- This is a database invariant in the sense the schema header (schema.ts)
-- reserves triggers for: four write paths touch nodes today and more
-- loaders are planned; a path that forgot to record a revision would fail
-- silently, and "every change leaves a record" is a property of the table,
-- not of any caller.
--
-- revision_no is one more than the node's current maximum. Every revision
-- is written from inside a statement that holds the node's row lock, so
-- under READ COMMITTED a second concurrent writer blocks until the first
-- commits and then sees its revision when this function runs (plpgsql
-- takes a fresh snapshot per statement); node_revisions_node_id_revision_no_key
-- is the backstop that turns any remaining race into a loud unique
-- violation rather than a duplicate number.
CREATE FUNCTION nodes_record_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	INSERT INTO node_revisions (node_id, ingest_run_id, revision_no, node_type, title, content, content_hash, metadata, merged_into)
	VALUES (
		NEW.id,
		NEW.ingest_run_id,
		(SELECT COALESCE(max(revision_no), 0) + 1 FROM node_revisions WHERE node_id = NEW.id),
		NEW.node_type,
		NEW.title,
		NEW.content,
		NEW.content_hash,
		NEW.metadata,
		NEW.merged_into
	);
	RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER nodes_record_revision_insert_trigger
	AFTER INSERT ON nodes
	FOR EACH ROW
	EXECUTE FUNCTION nodes_record_revision();--> statement-breakpoint
CREATE TRIGGER nodes_record_revision_update_trigger
	AFTER UPDATE ON nodes
	FOR EACH ROW
	WHEN (
		OLD.node_type IS DISTINCT FROM NEW.node_type
		OR OLD.title IS DISTINCT FROM NEW.title
		OR OLD.content IS DISTINCT FROM NEW.content
		OR OLD.metadata IS DISTINCT FROM NEW.metadata
		OR OLD.merged_into IS DISTINCT FROM NEW.merged_into
	)
	EXECUTE FUNCTION nodes_record_revision();--> statement-breakpoint
-- Hand-written one-time backfill (a data migration, which drizzle-kit never
-- generates): revision one for every node that predates history, from its
-- current row, attributed to the run that last wrote it, with
-- recorded_at = updated_at so the timeline does not show every old node as
-- "changed" at upgrade time (knowledge-store spec, "Nodes that predate
-- history"). Inserts into node_revisions directly, so the triggers above
-- (which are on nodes) do not fire. No ON CONFLICT clause: node_revisions
-- was created in this same migration and drizzle's migrator runs a
-- migration exactly once, inside one transaction, so nothing can be there
-- to conflict with.
INSERT INTO node_revisions (node_id, ingest_run_id, revision_no, node_type, title, content, content_hash, metadata, merged_into, recorded_at)
SELECT id, ingest_run_id, 1, node_type, title, content, content_hash, metadata, merged_into, updated_at
FROM nodes;
