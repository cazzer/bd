CREATE INDEX "nodes_metadata_gin_idx" ON "nodes" USING gin ("metadata" jsonb_path_ops);--> statement-breakpoint
-- Hand-written (drizzle-orm's pg-core has no trigger builder): refuse any
-- `blocks` edge that would make a node transitively block itself
-- (work-items spec, "Blocking and parent relationships"). A cross-row
-- rule a CHECK cannot express, with a silent failure mode — an item that
-- can never become ready — if any of the write paths that insert edges
-- (batch upsert, human assertEdge, loaders) forgot it; see schema.ts's
-- header, construct #6.
--
-- Endpoints are folded through merged_into on both sides, so a duplicate
-- merged into a survivor counts as the survivor. The advisory transaction
-- lock serializes all `blocks` inserts: without it two concurrent
-- inserts (A -> B and B -> A) each see no cycle and together form one,
-- and no check — trigger or application-side — could prevent that under
-- READ COMMITTED. Only `blocks` edges take the lock (the WHEN clause);
-- every other edge type is unaffected.
--
-- Rows already inserted by the same statement are visible to a BEFORE
-- ROW trigger, so a single batch carrying both halves of a cycle is
-- rejected on its second row. `e.id IS DISTINCT FROM NEW.id` keeps an
-- UPDATE of an existing edge from walking through its own old row.
CREATE FUNCTION edges_blocks_must_be_acyclic() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	new_src uuid;
	new_dst uuid;
	cycle_path uuid[];
BEGIN
	PERFORM pg_advisory_xact_lock(hashtext('edges.blocks.acyclic'));
	SELECT COALESCE(merged_into, id) INTO new_src FROM nodes WHERE id = NEW.src_id;
	SELECT COALESCE(merged_into, id) INTO new_dst FROM nodes WHERE id = NEW.dst_id;
	IF new_src IS NULL OR new_dst IS NULL THEN
		-- A missing endpoint is the foreign key's error to raise, not this one's.
		RETURN NEW;
	END IF;
	IF new_src = new_dst THEN
		RAISE EXCEPTION 'blocks edge % -> % would form a cycle: a node cannot block itself', NEW.src_id, NEW.dst_id
			USING ERRCODE = 'check_violation',
			      DETAIL = 'path: ' || new_src::text || ' -> ' || new_src::text;
	END IF;
	WITH RECURSIVE walk(node_id, path) AS (
		SELECT new_dst, ARRAY[new_dst]
		UNION ALL
		SELECT COALESCE(d.merged_into, d.id), w.path || COALESCE(d.merged_into, d.id)
		FROM walk w
		JOIN edges e
		  ON e.edge_type = 'blocks'
		 AND e.id IS DISTINCT FROM NEW.id
		 AND e.src_id IN (SELECT id FROM nodes WHERE id = w.node_id OR merged_into = w.node_id)
		JOIN nodes d ON d.id = e.dst_id
		WHERE NOT (COALESCE(d.merged_into, d.id) = ANY(w.path))
		  AND array_length(w.path, 1) < 1000
	)
	SELECT path INTO cycle_path FROM walk WHERE node_id = new_src LIMIT 1;
	IF cycle_path IS NOT NULL THEN
		RAISE EXCEPTION 'blocks edge % -> % would form a cycle', NEW.src_id, NEW.dst_id
			USING ERRCODE = 'check_violation',
			      DETAIL = 'path: ' || array_to_string(new_src || cycle_path, ' -> ');
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER edges_blocks_acyclic_trigger
	BEFORE INSERT OR UPDATE OF src_id, dst_id, edge_type ON edges
	FOR EACH ROW
	WHEN (NEW.edge_type = 'blocks')
	EXECUTE FUNCTION edges_blocks_must_be_acyclic();
