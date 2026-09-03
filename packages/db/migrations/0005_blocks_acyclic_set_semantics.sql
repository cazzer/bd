-- Hand-written (custom migration): edges_blocks_must_be_acyclic() now
-- decides reachability with set semantics. 0003/0004 enumerated simple
-- paths (UNION ALL with a path array), whose row count is the number of
-- distinct paths -- exponential on a dense layered DAG (10 layers x 10
-- nodes, 900 edges, one brain_link call, is ~10^10 rows), and it ran under
-- the store-wide advisory lock. Here the recursive term is a plain UNION
-- over node ids: Postgres feeds only rows not already in the result
-- forward, so each node enters the working table at most once, the walk
-- is O(V*E), and it terminates on a cycle without tracking paths. The
-- rejection names the two endpoints; no path is computed, because a
-- path-tracking query is the exponential one, and it must never run on
-- the write path, not even on failure. Otherwise identical to 0004.
CREATE OR REPLACE FUNCTION edges_blocks_must_be_acyclic() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	new_src uuid;
	new_dst uuid;
	reachable boolean;
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
			      DETAIL = 'endpoints: ' || new_src::text || ' -> ' || new_src::text;
	END IF;
	WITH RECURSIVE reach(node_id) AS (
		SELECT new_dst
		UNION
		SELECT COALESCE(d.merged_into, d.id)
		FROM reach r
		JOIN edges e
		  ON e.edge_type = 'blocks'
		 AND e.id IS DISTINCT FROM NEW.id
		 AND e.src_id IN (SELECT id FROM nodes WHERE id = r.node_id OR merged_into = r.node_id)
		JOIN nodes d ON d.id = e.dst_id
	)
	SELECT EXISTS (SELECT 1 FROM reach WHERE node_id = new_src) INTO reachable;
	IF reachable THEN
		RAISE EXCEPTION 'blocks edge % -> % would form a cycle: the target already reaches the source through blocks edges', NEW.src_id, NEW.dst_id
			USING ERRCODE = 'check_violation',
			      DETAIL = 'endpoints: ' || new_src::text || ' -> ' || new_dst::text;
	END IF;
	RETURN NEW;
END;
$$;
