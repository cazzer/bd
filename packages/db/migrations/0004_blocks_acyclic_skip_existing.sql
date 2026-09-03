-- Hand-written (a custom migration: drizzle-kit generates nothing for a
-- function body): edges_blocks_must_be_acyclic() learns to skip the walk
-- when the exact edge (src, dst, blocks) is already stored. An edge that
-- already exists adds no reachability, so it cannot create a cycle -- and
-- without this, re-asserting an edge that sits on a cycle a merge created
-- (A -> B, B -> C, C merged into A: a shape the work-items spec sanctions
-- for readiness reporting) raised check_violation and dropped the whole
-- batch, so a beads re-import or brain_link retry could never succeed and
-- there is no tool to retract or un-merge. The common idempotent re-import
-- now skips the walk entirely. Otherwise identical to 0003's function.
--
-- The recursive walk enumerates simple paths, which is exponential on a
-- dense layered DAG; fine at personal scale, and bounded by the path
-- length guard.
CREATE OR REPLACE FUNCTION edges_blocks_must_be_acyclic() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	new_src uuid;
	new_dst uuid;
	cycle_path uuid[];
BEGIN
	PERFORM pg_advisory_xact_lock(hashtext('edges.blocks.acyclic'));
	IF EXISTS (
		SELECT 1 FROM edges
		WHERE src_id = NEW.src_id AND dst_id = NEW.dst_id AND edge_type = 'blocks'
		  AND id IS DISTINCT FROM NEW.id
	) THEN
		RETURN NEW;
	END IF;
	SELECT COALESCE(merged_into, id) INTO new_src FROM nodes WHERE id = NEW.src_id;
	SELECT COALESCE(merged_into, id) INTO new_dst FROM nodes WHERE id = NEW.dst_id;
	IF new_src IS NULL OR new_dst IS NULL THEN
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
$$;
