# Retrieval query design (bd-vt2.4)

Verified against Postgres 16.15 on a 30k-node / 60k-edge graph. Every construct below was
executed before being specified. Companion to `openspec/changes/add-knowledge-graph-core/`.

## Parameters

| param | type | default | notes |
|---|---|---|---|
| `query_text` | text | — | fed to `websearch_to_tsquery` |
| `seed_limit` | int | 10 | |
| `min_relevance` | float8 | **1e-6, must be > 0** | see Ambiguity 1 |
| `max_depth` | int | 2 | hard ceiling 3 |
| `fanout` | int | 25 | per-node, per-hop |
| `node_budget` | int | 40 | |
| `decay` | float8 | 0.6 | 0 < decay <= 1 |
| `node_types` / `source_systems` / `edge_types` | text[] \| null | null | null = no filter |
| `updated_since` | timestamptz \| null | null | |

## The statement

```sql
WITH RECURSIVE

tsq AS (
  SELECT websearch_to_tsquery('english', :query_text) AS q
),

-- Every merged-away node grouped by its survivor. The one-hop invariant
-- (nodes_merged_into_canonical_trigger) makes this a flat map, never a chain walk.
-- Needs the partial index on (merged_into) WHERE merged_into IS NOT NULL.
alias AS (
  SELECT merged_into AS canonical_id, array_agg(id ORDER BY id) AS alias_ids
  FROM nodes WHERE merged_into IS NOT NULL GROUP BY merged_into
),

-- Scan ALL of nodes, not resolved_nodes, so a match on a merged-away row is not lost.
seed_hits AS (
  SELECT COALESCE(n.merged_into, n.id) AS node_id,
         n.id AS matched_node_id,
         ts_rank_cd(n.search, t.q)::double precision AS relevance
  FROM nodes n CROSS JOIN tsq t
  WHERE n.search @@ t.q
),

-- One row per canonical node, best-scoring match wins. Makes "survivor returned
-- exactly once" true even when both the survivor and its alias match.
seed_folded AS (
  SELECT DISTINCT ON (node_id) node_id, matched_node_id, relevance
  FROM seed_hits
  ORDER BY node_id, relevance DESC, matched_node_id
),

seeds AS (
  SELECT f.node_id, f.matched_node_id, f.relevance
  FROM seed_folded f
  JOIN resolved_nodes c ON c.id = f.node_id
  WHERE f.relevance >= :min_relevance
    AND (:node_types     IS NULL OR c.node_type     = ANY(:node_types))
    AND (:source_systems IS NULL OR c.source_system = ANY(:source_systems))
    AND (:updated_since  IS NULL OR c.updated_at   >= :updated_since)
  ORDER BY f.relevance DESC, f.node_id
  LIMIT :seed_limit
),

-- probe_ids carries [canonical_id] + every alias, so `src_id = ANY(probe_ids)`
-- finds edges on the survivor AND its losers in one indexable predicate.
expand AS (
  SELECT s.node_id, s.node_id AS seed_id, 0 AS depth, s.relevance AS score,
         ARRAY[]::text[] AS edge_path, NULL::uuid AS via_edge_id,
         ARRAY[s.node_id] || COALESCE(a.alias_ids, ARRAY[]::uuid[]) AS probe_ids
  FROM seeds s LEFT JOIN alias a ON a.canonical_id = s.node_id

  UNION ALL

  SELECT nb.canonical_id, f.seed_id, f.depth + 1,
         f.score * nb.weight::double precision * :decay,
         f.edge_path || nb.edge_type, nb.edge_id,
         ARRAY[nb.canonical_id] || COALESCE(a2.alias_ids, ARRAY[]::uuid[])
  FROM expand f
  -- LATERAL with LIMIT IS legal in a recursive term: Postgres forbids the
  -- recursive NAME inside a sub-SELECT expression, not a lateral column
  -- reference to it. `expand f` stays at the top level of FROM.
  CROSS JOIN LATERAL (
    SELECT d.edge_id, d.edge_type, d.weight, d.canonical_id
    FROM (
      -- DISTINCT ON canonical_id: one row per neighbour NODE, not per edge, so a
      -- node linked both ways cannot double-count or burn two units of fanout.
      SELECT DISTINCT ON (c.canonical_id) c.edge_id, c.edge_type, c.weight, c.canonical_id
      FROM (
        SELECT e.id AS edge_id, e.edge_type, e.weight,
               COALESCE(dn.merged_into, dn.id) AS canonical_id,
               COALESCE(dc.node_type, dn.node_type) AS n_type,
               COALESCE(dc.source_system, dn.source_system) AS n_src,
               COALESCE(dc.updated_at, dn.updated_at) AS n_updated
        FROM edges e
        JOIN nodes dn ON dn.id = e.dst_id
        LEFT JOIN nodes dc ON dc.id = dn.merged_into
        WHERE e.src_id = ANY (f.probe_ids)
        UNION ALL
        SELECT e.id, e.edge_type, e.weight,
               COALESCE(sn.merged_into, sn.id),
               COALESCE(sc.node_type, sn.node_type),
               COALESCE(sc.source_system, sn.source_system),
               COALESCE(sc.updated_at, sn.updated_at)
        FROM edges e
        JOIN nodes sn ON sn.id = e.src_id
        LEFT JOIN nodes sc ON sc.id = sn.merged_into
        WHERE e.dst_id = ANY (f.probe_ids)
      ) c
      -- Filters run INSIDE the cap, on the canonical row: the cap picks the top N
      -- ELIGIBLE neighbours, and a filtered-out node cannot be traversed through.
      WHERE c.canonical_id <> f.node_id
        AND (:node_types     IS NULL OR c.n_type    = ANY(:node_types))
        AND (:source_systems IS NULL OR c.n_src     = ANY(:source_systems))
        AND (:updated_since  IS NULL OR c.n_updated >= :updated_since)
        AND (:edge_types     IS NULL OR c.edge_type = ANY(:edge_types))
      ORDER BY c.canonical_id, c.weight DESC, c.edge_id
    ) d
    ORDER BY d.weight DESC, d.canonical_id, d.edge_id
    LIMIT :fanout
  ) nb
  LEFT JOIN alias a2 ON a2.canonical_id = nb.canonical_id
  WHERE f.depth < :max_depth
)
-- CYCLE makes termination independent of the depth bound. It EMITS the cycling
-- row flagged, so `NOT is_cycle` below is required. It also adds two columns,
-- so `SELECT *` from expand is not what you want.
CYCLE node_id SET is_cycle USING cycle_path,

-- CYCLE prevents revisiting along ONE path; it does not dedupe a node reached by
-- two paths or from two seeds. This does.
best AS (
  SELECT DISTINCT ON (x.node_id)
         x.node_id, x.seed_id, x.depth, x.score, x.edge_path, x.via_edge_id
  FROM expand x
  WHERE NOT x.is_cycle
  ORDER BY x.node_id, (x.depth = 0) DESC, x.score DESC,
           x.depth, x.seed_id, x.edge_path, x.via_edge_id
),

kept AS (
  SELECT b.* FROM best b ORDER BY b.score DESC, b.node_id LIMIT :node_budget
),

kept_probe AS (
  SELECT k.node_id, ARRAY[k.node_id] || COALESCE(a.alias_ids, ARRAY[]::uuid[]) AS probe_ids
  FROM kept k LEFT JOIN alias a ON a.canonical_id = k.node_id
),

-- ALL edges between kept nodes (the induced subgraph), not just traversed ones.
-- Probing outgoing only is sufficient and non-duplicating: probe sets partition
-- the raw node ids, so each edge is found exactly once from its source side.
result_edges AS (
  SELECT e.id AS edge_id, kp.node_id AS src_node_id,
         COALESCE(dn.merged_into, dn.id) AS dst_node_id,
         e.src_id AS raw_src_id, e.dst_id AS raw_dst_id,
         e.edge_type, e.weight::double precision AS weight, e.source_system
  FROM kept_probe kp
  JOIN edges e ON e.src_id = ANY (kp.probe_ids)
  JOIN nodes dn ON dn.id = e.dst_id
  WHERE COALESCE(dn.merged_into, dn.id) IN (SELECT node_id FROM kept)
    -- Merge-induced self-loop guard, same shape as `c.canonical_id <>
    -- f.node_id` in the LATERAL above: if L -[rel]-> S existed and L was
    -- later merged into S, this fold produces src_node_id === dst_node_id
    -- (both S) without this line. The LATERAL guards traversal; this
    -- guards the induced-subgraph edge listing, which the LATERAL's guard
    -- does not reach since result_edges is built independently from
    -- kept_probe, not from expand. (Found in review of bd-vt2.4's
    -- implementation — the raw edge is unaffected in the database.)
    AND COALESCE(dn.merged_into, dn.id) <> kp.node_id
    AND (:edge_types IS NULL OR e.edge_type = ANY(:edge_types))
),

-- ts_headline is the expensive part of text search: it runs here, at most
-- node_budget times, only for seeds, and highlights the row that actually
-- MATCHED (which for a merged seed is the merged-away row).
result_nodes AS (
  SELECT k.node_id AS id, n.node_type, n.source_system, n.external_id, n.title,
         n.updated_at, k.score, k.depth,
         (s.node_id IS NOT NULL) AS is_seed, s.relevance, s.matched_node_id,
         CASE WHEN s.node_id IS NOT NULL THEN
           ts_headline('english', m.title || ' - ' || m.content, t.q,
             'StartSel=[[,StopSel=]],MaxFragments=2,MinWords=5,MaxWords=20')
         END AS snippet,
         k.seed_id, k.edge_path, k.via_edge_id
  FROM kept k
  JOIN resolved_nodes n ON n.id = k.node_id
  CROSS JOIN tsq t
  LEFT JOIN seeds s ON s.node_id = k.node_id
  LEFT JOIN nodes m ON m.id = s.matched_node_id
)

SELECT jsonb_build_object(
  'mode', 'exact',
  'seed_count', (SELECT count(*) FROM seeds),
  'node_count', (SELECT count(*) FROM result_nodes),
  'truncated',  (SELECT count(*) FROM best) > (SELECT count(*) FROM kept),
  'nodes', COALESCE((SELECT jsonb_agg(to_jsonb(rn) ORDER BY rn.score DESC, rn.id)
                     FROM result_nodes rn), '[]'::jsonb),
  'edges', COALESCE((SELECT jsonb_agg(to_jsonb(re) ORDER BY re.src_node_id, re.dst_node_id,
                                      re.edge_type, re.source_system)
                     FROM result_edges re), '[]'::jsonb)
) AS result;
```

## Fuzzy fallback

The **same statement** with `seed_hits` / `seed_folded` swapped, so the fuzzy path returns a
real subgraph rather than a flat list. Issued only when the exact statement reports
`seed_count = 0`. Build both from one function with a `seedStrategy` switch.

```sql
seed_hits AS (
  SELECT COALESCE(n.merged_into, n.id) AS node_id, n.id AS matched_node_id,
         -- Mirrors the tsvector A/B weighting: a title hit outranks a body hit.
         GREATEST(word_similarity(:query_text, n.title),
                  word_similarity(:query_text, n.content) * 0.5)::double precision AS relevance
  FROM nodes n
  -- `<%` (word_similarity), NOT `%`: `%` compares whole strings, so a one-word
  -- query never clears the threshold against a paragraph. Both are GIN-indexable.
  WHERE :query_text <% n.title OR :query_text <% n.content
),
```

`'mode'` becomes `'fuzzy'`. Fuzzy seeds have no tsquery, so `snippet` is NULL on this path.
The effective floor is `max(callerFloor, 0.6)` — `<%` gates at `pg_trgm.word_similarity_threshold`,
loosenable only via `SET LOCAL` inside a transaction.

## Verified facts

1. **`LATERAL ... LIMIT` is legal inside a recursive term.** What Postgres rejects is the
   recursive name in a sub-SELECT expression: `WHERE e.src_id IN (SELECT id FROM expand)` gives
   `ERROR: recursive reference to query "expand" must not appear within a subquery`.
   The window-function alternative would be worse: it evaluates after the join, so a
   300-edge hub is fully read and sorted before being discarded, where LATERAL pushes the
   LIMIT into a per-parent index scan (90 rows read, not 10,000).
2. **`CYCLE` is load-bearing.** Without it the same query on a cyclic graph hits
   `statement timeout`. With it, the revisit is emitted flagged and not expanded.
3. **Bidirectional traversal does not double-count** — guaranteed twice over, by
   `DISTINCT ON (canonical_id)` in the LATERAL and `DISTINCT ON (node_id)` in `best`.
4. **Merge folding works both halves**: a match on a merged-away row returns the survivor once
   (even when both match), and a node hanging off a merged-away row is reachable from the
   survivor, with the edge carrying both raw and canonical endpoints.
5. **Deterministic**: identical md5 across runs, on both the row set and the JSON envelope.
   Every ORDER BY ends in a column unique in its context.
6. **Scoring**: `1.542857 * 0.9 * 0.6 = 0.833143`, then `* 0.8 * 0.6 = 0.399909`. Asserted in tests.

Timings on 30k nodes / 60k edges: seeds 1.5ms (GIN, and still GIN under a forced generic plan
with a bind parameter), full traversal depth 2 ~21ms, depth 3 ~28ms, summary ~40ms.

Indexes used as intended: `nodes_search_gin_idx`, both `edges_*_edge_type_idx` (via ScalarArrayOp
on `= ANY(probe_ids)`), `nodes_title/content_trgm_idx` via BitmapOr on the fuzzy path, `nodes_pkey`.

**Required new index** — without it the `alias` CTE seq-scans all of `nodes` every query
(8.2ms vs 0.055ms at 30k rows, ~22% of retrieval time, growing linearly):

```sql
CREATE INDEX nodes_merged_into_idx ON nodes (merged_into) WHERE merged_into IS NOT NULL;
```

Optional, deferred: `nodes (updated_at DESC, id)` for the summary's recent-nodes scan.

## Ambiguities resolved

1. **`min_relevance` must be > 0.** `-supabase` parses to `!'supabas'`, matching every document
   lacking the term at rank 0; a `>= 0` floor returns an arbitrary slice of the whole store.
   `numnode()` does not distinguish this (`numnode('-supabase') = 2`), so the floor is the guard.
2. **Filters exclude from the graph, not just the output.** Applied inside the LATERAL, so a
   filtered-out node blocks the path behind it. Filtering at output would return edges
   referencing absent nodes and paths through nodes the caller was told do not exist.
3. **Decay applies once per hop** — closed form `seed_relevance * prod(weight) * decay^depth`.
   Read as a per-hop recurrence with `depth` as exponent it compounds to `decay^(1+2+...+d)`.
   Silent if misread; assert the arithmetic.
4. **Snippet comes from the row that matched**, with `matchedNodeId` returned so a snippet absent
   from the returned node's body is explained rather than mysterious. Fuzzy: null.
5. **A seed that is also reachable reports as a seed**, depth 0. Since weight <= 1 and decay <= 1,
   an expanded node can never outscore its own seed.
6. **`truncated` and `seed_count` come from SQL** — the app never sees the dropped rows, so it
   cannot compute them.

## Implementation notes

- `db.execute()` returns raw driver rows: `updated_at` arrives as a string, not a `Date` — coerce
  explicitly, as `closeIngestRun` does. The `jsonb` column arrives already parsed.
- `noUncheckedIndexedAccess` is on: `result.rows[0]` is `T | undefined`.
- `websearch_to_tsquery` on stopword-only input raises a NOTICE; reject with `EmptyQueryError`
  first (`numnode(q) = 0` detects it: `numnode('the of and') = 0`).
- No `content` field on returned nodes — seeds carry a snippet, `brain_get` fetches bodies.
  Returning full content would blow the MCP response budget on the first hub.
- The dev database is shared: scope test fixtures by a unique `source_system`, and never assert
  on global counts (the summary's `totalNodes` will be flaky).
