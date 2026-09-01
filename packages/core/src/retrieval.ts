/**
 * Retrieval (bd-vt2.4): query text in, a bounded scored subgraph out, in a
 * single database round trip — full-text search picks seed nodes and a
 * recursive traversal supplies their neighborhood, with no model call and
 * no vector column anywhere in the read path.
 *
 * This module is a direct implementation of the verified design in
 * `docs/retrieval-query-design.md` — every construct in `buildRetrievalQuery`
 * (the `CROSS JOIN LATERAL ... LIMIT` inside the recursive term, the
 * `CYCLE` clause, the `min_relevance` floor defaulting to a small positive
 * number rather than zero, the alias/probe_ids merge folding) was executed
 * against a live 30k-node graph before being written down here. See that
 * document for the "why", including the six resolved ambiguities and the
 * measured index/plan evidence. Do not simplify the SQL without re-reading
 * it — several parts that look removable are load-bearing.
 *
 * `buildRetrievalQuery` is a pure function (no `Database`, no I/O) so its
 * SQL can be asserted on directly in tests. `retrieve` is the orchestration
 * layer: it validates options, issues the exact-match statement, and —
 * only when that statement reports zero seeds — issues a second, fuzzy
 * statement. That is the one documented exception to "one round trip";
 * every other path here issues exactly one statement.
 */

import { sql, type SQL } from "drizzle-orm";
import type { Database } from "@breakdown/db";
import { EmptyQueryError, InvalidRetrievalOptionError, RetrievalFailedError } from "./errors.js";
import { asPgError, formatPgInfo, sqlArray } from "./sql-helpers.js";

// --- Tunable defaults (docs/retrieval-query-design.md "Parameters") --------

export const DEFAULT_SEED_LIMIT = 10;
/**
 * Must stay a small POSITIVE number, never 0 — see
 * docs/retrieval-query-design.md, "Ambiguities resolved" #1. A query
 * consisting only of exclusions (`-supabase`) parses to a tsquery that
 * matches every document *lacking* the term, all at `ts_rank_cd = 0`; a
 * `>= 0` floor would return an arbitrary slice of the whole store instead
 * of an empty seed set. `numnode()` cannot distinguish this case from a
 * normal query, so the floor is the guard.
 */
export const DEFAULT_MIN_RELEVANCE = 1e-6;
export const DEFAULT_MAX_DEPTH = 2;
/** Hard ceiling on `maxDepth` — worst-case frontier is `seedLimit * fanout^depth`. */
export const MAX_ALLOWED_DEPTH = 3;
export const DEFAULT_FANOUT = 25;
export const DEFAULT_NODE_BUDGET = 40;
export const DEFAULT_DECAY = 0.6;
export const DEFAULT_RECENT_NODES_LIMIT = 10;

export type SeedStrategy = "exact" | "fuzzy";

// --- Public option / result types -------------------------------------------

export interface RetrieveOptions {
  /** Max seeds full-text/fuzzy search returns. Default `DEFAULT_SEED_LIMIT` (10). */
  seedLimit?: number;
  /** Relevance floor for a seed to qualify. Default `DEFAULT_MIN_RELEVANCE` (1e-6). Must be > 0. */
  minRelevance?: number;
  /** Max traversal depth from a seed. Default `DEFAULT_MAX_DEPTH` (2). Hard ceiling `MAX_ALLOWED_DEPTH` (3). */
  maxDepth?: number;
  /** Per-node, per-hop neighbor cap. Default `DEFAULT_FANOUT` (25). */
  fanout?: number;
  /** Max nodes returned overall. Default `DEFAULT_NODE_BUDGET` (40). */
  nodeBudget?: number;
  /** Per-hop score attenuation, applied once per hop. Default `DEFAULT_DECAY` (0.6). Must be in (0, 1]. */
  decay?: number;
  /** Restrict seeds and traversal to these node types. `null`/omitted = no filter. */
  nodeTypes?: readonly string[] | null;
  /** Restrict seeds and traversal to these source systems. `null`/omitted = no filter. */
  sourceSystems?: readonly string[] | null;
  /** Restrict traversed/returned edges to these edge types. `null`/omitted = no filter. */
  edgeTypes?: readonly string[] | null;
  /** Restrict seeds and traversal to nodes updated at or after this instant. `null`/omitted = no filter. */
  updatedSince?: Date | null;
}

/** Fully-resolved, validated retrieval parameters shared by both the exact and fuzzy statements. */
export interface BuildRetrievalQueryParams {
  seedStrategy: SeedStrategy;
  queryText: string;
  seedLimit: number;
  minRelevance: number;
  maxDepth: number;
  fanout: number;
  nodeBudget: number;
  decay: number;
  nodeTypes: readonly string[] | null;
  sourceSystems: readonly string[] | null;
  edgeTypes: readonly string[] | null;
  updatedSince: Date | null;
}

export interface RetrievedNode {
  id: string;
  nodeType: string;
  sourceSystem: string;
  externalId: string;
  title: string;
  updatedAt: Date;
  /** `seedRelevance * Π(edgeWeight) * decay^depth` — see design.md "Retrieval" for the closed form. */
  score: number;
  /** Hop count from the seed it was kept from; 0 for a seed. */
  depth: number;
  /** True if this node was itself a seed (always reported as a seed at depth 0, even if also reachable — design.md ambiguity 5). */
  isSeed: boolean;
  /** The seed's own relevance score. Present only when `isSeed`. */
  relevance: number | null;
  /**
   * The raw node id that actually matched the search (may differ from `id`
   * when the match was on a merged-away node whose survivor is `id`).
   * Present only when `isSeed`.
   */
  matchedNodeId: string | null;
  /** Highlighted excerpt from the row that matched. Present only for an exact-mode seed. */
  snippet: string | null;
  /** The seed id this node was reached from (itself, for a seed). */
  seedId: string;
  /** Edge types traversed from the seed to reach this node, in order. Empty for a seed. */
  edgePath: string[];
  /** The id of the last edge traversed to reach this node. `null` for a seed. */
  viaEdgeId: string | null;
}

export interface RetrievedEdge {
  edgeId: string;
  /** Canonical (merge-resolved) source node id — always a member of the returned node set. */
  srcNodeId: string;
  /** Canonical (merge-resolved) destination node id — always a member of the returned node set. */
  dstNodeId: string;
  /** The `src_id` as originally stored, before merge resolution. */
  rawSrcId: string;
  /** The `dst_id` as originally stored, before merge resolution. */
  rawDstId: string;
  edgeType: string;
  weight: number;
  sourceSystem: string;
}

export interface RetrievalResultFound {
  mode: SeedStrategy;
  seedCount: number;
  nodeCount: number;
  /** True when the neighborhood exceeded `nodeBudget` and lower-scoring nodes were dropped. */
  truncated: boolean;
  nodes: RetrievedNode[];
  edges: RetrievedEdge[];
}

/** Both the exact and fuzzy statements found zero seeds above the relevance floor. Not an error. */
export interface RetrievalResultEmpty {
  mode: "empty";
  triedModes: readonly ["exact", "fuzzy"];
  nodes: readonly [];
  edges: readonly [];
}

export type RetrievalResult = RetrievalResultFound | RetrievalResultEmpty;

// --- Query builder -----------------------------------------------------------

/** Builds `ARRAY[...]::text[]` from a filter array, or a literal `NULL::text[]` when the filter is unset ("no filter"). */
function nullableTextArray(values: readonly string[] | null): SQL {
  return values === null ? sql`NULL::text[]` : sqlArray(values, "text");
}

/** Builds a bound `timestamptz` literal, or `NULL::timestamptz` when unset ("no filter"). */
function nullableTimestamptz(value: Date | null): SQL {
  return value === null ? sql`NULL::timestamptz` : sql`${value.toISOString()}::timestamptz`;
}

/**
 * The one CTE that differs structurally between the exact and fuzzy
 * statements (docs/retrieval-query-design.md "Fuzzy fallback"). Both
 * variants resolve a raw match onto its survivor via
 * `COALESCE(n.merged_into, n.id)`, carrying the raw matched id separately
 * so a merged-away match still folds onto its survivor exactly once
 * (seed_folded, immediately below this CTE, does the folding).
 */
function buildSeedHitsCte(params: BuildRetrievalQueryParams): SQL {
  if (params.seedStrategy === "exact") {
    return sql`
seed_hits AS (
  SELECT COALESCE(n.merged_into, n.id) AS node_id,
         n.id AS matched_node_id,
         ts_rank_cd(n.search, t.q)::double precision AS relevance
  FROM nodes n CROSS JOIN tsq t
  WHERE n.search @@ t.q
)`;
  }
  return sql`
seed_hits AS (
  SELECT COALESCE(n.merged_into, n.id) AS node_id,
         n.id AS matched_node_id,
         -- Mirrors the tsvector A/B weighting: a title hit outranks a
         -- body hit.
         GREATEST(word_similarity(${params.queryText}, n.title),
                  word_similarity(${params.queryText}, n.content) * 0.5)::double precision AS relevance
  FROM nodes n
  -- \`<%\` (word_similarity), NOT \`%\`: \`%\` compares whole strings, so a
  -- one-word query never clears the threshold against a paragraph. Both
  -- are GIN-indexable (nodes_title_trgm_idx / nodes_content_trgm_idx).
  WHERE ${params.queryText} <% n.title OR ${params.queryText} <% n.content
)`;
}

/**
 * `result_nodes` — the only other place the two variants differ. Fuzzy
 * seeds have no parsed tsquery to highlight against, so the snippet is
 * unconditionally `NULL` on that path (never computed from `tsq`, which a
 * fuzzy-triggering query may not even parse to anything meaningful).
 */
function buildResultNodesCte(params: BuildRetrievalQueryParams): SQL {
  const snippetExpr =
    params.seedStrategy === "exact"
      ? sql`CASE WHEN s.node_id IS NOT NULL THEN
           ts_headline('english', m.title || ' - ' || m.content, t.q,
             'StartSel=[[,StopSel=]],MaxFragments=2,MinWords=5,MaxWords=20')
         END`
      : sql`NULL::text`;

  return sql`
result_nodes AS (
  SELECT k.node_id AS id, n.node_type, n.source_system, n.external_id, n.title,
         n.updated_at, k.score, k.depth,
         (s.node_id IS NOT NULL) AS is_seed, s.relevance, s.matched_node_id,
         ${snippetExpr} AS snippet,
         k.seed_id, k.edge_path, k.via_edge_id
  FROM kept k
  JOIN resolved_nodes n ON n.id = k.node_id
  CROSS JOIN tsq t
  LEFT JOIN seeds s ON s.node_id = k.node_id
  LEFT JOIN nodes m ON m.id = s.matched_node_id
)`;
}

/**
 * Builds the single-statement search-plus-traversal query — pure, no
 * database access, so its SQL can be asserted on directly in tests. See
 * the module header and docs/retrieval-query-design.md for what every
 * clause below is doing and why; comments here are trimmed to what a
 * maintainer needs at the call site, not a re-derivation of the design.
 */
export function buildRetrievalQuery(params: BuildRetrievalQueryParams): SQL {
  const nodeTypesArr = nullableTextArray(params.nodeTypes);
  const sourceSystemsArr = nullableTextArray(params.sourceSystems);
  const edgeTypesArr = nullableTextArray(params.edgeTypes);
  const updatedSinceVal = nullableTimestamptz(params.updatedSince);

  return sql`
WITH RECURSIVE

tsq AS (
  SELECT websearch_to_tsquery('english', ${params.queryText}) AS q
),

-- Every merged-away node grouped by its survivor. The one-hop invariant
-- (nodes_merged_into_canonical_trigger) makes this a flat map, never a
-- chain walk. Backed by the partial index nodes_merged_into_idx.
alias AS (
  SELECT merged_into AS canonical_id, array_agg(id ORDER BY id) AS alias_ids
  FROM nodes WHERE merged_into IS NOT NULL GROUP BY merged_into
),

${buildSeedHitsCte(params)},

-- One row per canonical node, best-scoring match wins. Makes "survivor
-- returned exactly once" true even when both the survivor and its alias
-- match.
seed_folded AS (
  SELECT DISTINCT ON (node_id) node_id, matched_node_id, relevance
  FROM seed_hits
  ORDER BY node_id, relevance DESC, matched_node_id
),

seeds AS (
  SELECT f.node_id, f.matched_node_id, f.relevance
  FROM seed_folded f
  JOIN resolved_nodes c ON c.id = f.node_id
  WHERE f.relevance >= ${params.minRelevance}::double precision
    AND (${nodeTypesArr}     IS NULL OR c.node_type     = ANY(${nodeTypesArr}))
    AND (${sourceSystemsArr} IS NULL OR c.source_system = ANY(${sourceSystemsArr}))
    AND (${updatedSinceVal}  IS NULL OR c.updated_at    >= ${updatedSinceVal})
  ORDER BY f.relevance DESC, f.node_id
  LIMIT ${params.seedLimit}::int
),

-- probe_ids carries [canonical_id] + every alias, so \`src_id = ANY(probe_ids)\`
-- finds edges on the survivor AND its losers in one indexable predicate.
expand AS (
  SELECT s.node_id, s.node_id AS seed_id, 0 AS depth, s.relevance AS score,
         ARRAY[]::text[] AS edge_path, NULL::uuid AS via_edge_id,
         ARRAY[s.node_id] || COALESCE(a.alias_ids, ARRAY[]::uuid[]) AS probe_ids
  FROM seeds s LEFT JOIN alias a ON a.canonical_id = s.node_id

  UNION ALL

  SELECT nb.canonical_id, f.seed_id, f.depth + 1,
         f.score * nb.weight::double precision * ${params.decay}::double precision,
         f.edge_path || nb.edge_type, nb.edge_id,
         ARRAY[nb.canonical_id] || COALESCE(a2.alias_ids, ARRAY[]::uuid[])
  FROM expand f
  -- LATERAL with LIMIT IS legal in a recursive term: Postgres forbids the
  -- recursive NAME inside a sub-SELECT expression, not a lateral column
  -- reference to it. \`expand f\` stays at the top level of FROM.
  CROSS JOIN LATERAL (
    SELECT d.edge_id, d.edge_type, d.weight, d.canonical_id
    FROM (
      -- DISTINCT ON canonical_id: one row per neighbour NODE, not per
      -- edge, so a node linked both ways cannot double-count or burn two
      -- units of fanout.
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
      -- Filters run INSIDE the cap, on the canonical row: the cap picks
      -- the top N ELIGIBLE neighbours, and a filtered-out node cannot be
      -- traversed through.
      WHERE c.canonical_id <> f.node_id
        AND (${nodeTypesArr}     IS NULL OR c.n_type    = ANY(${nodeTypesArr}))
        AND (${sourceSystemsArr} IS NULL OR c.n_src     = ANY(${sourceSystemsArr}))
        AND (${updatedSinceVal}  IS NULL OR c.n_updated >= ${updatedSinceVal})
        AND (${edgeTypesArr}     IS NULL OR c.edge_type = ANY(${edgeTypesArr}))
      ORDER BY c.canonical_id, c.weight DESC, c.edge_id
    ) d
    ORDER BY d.weight DESC, d.canonical_id, d.edge_id
    LIMIT ${params.fanout}::int
  ) nb
  LEFT JOIN alias a2 ON a2.canonical_id = nb.canonical_id
  WHERE f.depth < ${params.maxDepth}::int
)
-- CYCLE makes termination independent of the depth bound. It EMITS the
-- cycling row flagged, so \`NOT is_cycle\` below is required. It also adds
-- two columns, so \`SELECT *\` from expand is not what you want.
CYCLE node_id SET is_cycle USING cycle_path,

-- CYCLE prevents revisiting along ONE path — it does not dedupe a node
-- reached by two paths or from two seeds. This does.
best AS (
  SELECT DISTINCT ON (x.node_id)
         x.node_id, x.seed_id, x.depth, x.score, x.edge_path, x.via_edge_id
  FROM expand x
  WHERE NOT x.is_cycle
  ORDER BY x.node_id, (x.depth = 0) DESC, x.score DESC,
           x.depth, x.seed_id, x.edge_path, x.via_edge_id
),

kept AS (
  SELECT b.* FROM best b ORDER BY b.score DESC, b.node_id LIMIT ${params.nodeBudget}::int
),

kept_probe AS (
  SELECT k.node_id, ARRAY[k.node_id] || COALESCE(a.alias_ids, ARRAY[]::uuid[]) AS probe_ids
  FROM kept k LEFT JOIN alias a ON a.canonical_id = k.node_id
),

-- ALL edges between kept nodes (the induced subgraph), not just
-- traversed ones. Probing outgoing only is sufficient and
-- non-duplicating: probe sets partition the raw node ids, so each edge
-- is found exactly once from its source side.
result_edges AS (
  SELECT e.id AS edge_id, kp.node_id AS src_node_id,
         COALESCE(dn.merged_into, dn.id) AS dst_node_id,
         e.src_id AS raw_src_id, e.dst_id AS raw_dst_id,
         e.edge_type, e.weight::double precision AS weight, e.source_system
  FROM kept_probe kp
  JOIN edges e ON e.src_id = ANY (kp.probe_ids)
  JOIN nodes dn ON dn.id = e.dst_id
  WHERE COALESCE(dn.merged_into, dn.id) IN (SELECT node_id FROM kept)
    -- Merge-induced self-loop guard: if L -[rel]-> S existed and L was
    -- later merged into S, this fold would otherwise produce
    -- src_node_id === dst_node_id === S — an edge saying a node relates
    -- to itself, which teaches a consuming agent nothing. The traversal
    -- LATERAL guards the identical shape via \`c.canonical_id <> f.node_id\`
    -- (see the recursive step above) — this is that guard's counterpart
    -- for the induced-subgraph edge listing. The raw edge is untouched in
    -- the database — raw_src_id/raw_dst_id above still carry it — this
    -- only excludes it from the returned result.
    AND COALESCE(dn.merged_into, dn.id) <> kp.node_id
    AND (${edgeTypesArr} IS NULL OR e.edge_type = ANY(${edgeTypesArr}))
),

${buildResultNodesCte(params)}

SELECT jsonb_build_object(
  'mode', ${params.seedStrategy}::text,
  'seed_count', (SELECT count(*) FROM seeds),
  'node_count', (SELECT count(*) FROM result_nodes),
  'truncated',  (SELECT count(*) FROM best) > (SELECT count(*) FROM kept),
  -- Detects a query that parses down to zero tsquery nodes (stopwords
  -- only, e.g. "the of and" — numnode('the of and') = 0). Computed here,
  -- inside the one statement the exact path is allowed to issue, rather
  -- than as a preliminary round trip — see EmptyQueryError and retrieve()
  -- below, and "Implementation notes" in docs/retrieval-query-design.md.
  'query_node_count', (SELECT numnode(q) FROM tsq),
  'nodes', COALESCE((SELECT jsonb_agg(to_jsonb(rn) ORDER BY rn.score DESC, rn.id)
                     FROM result_nodes rn), '[]'::jsonb),
  'edges', COALESCE((SELECT jsonb_agg(to_jsonb(re) ORDER BY re.src_node_id, re.dst_node_id,
                                      re.edge_type, re.source_system)
                     FROM result_edges re), '[]'::jsonb)
) AS result
`;
}

// --- Raw (snake_case) row shapes returned by the driver ---------------------
//
// `db.execute()` returns the raw driver row, not a schema-mapped one — see
// ingest-runs.ts. The outer `jsonb` column arrives already parsed (pg's
// default type parser handles json/jsonb), but timestamptz values nested
// inside it are still Postgres's text representation and need explicit
// `Date` coercion, same as `closeIngestRun`.

interface RawRetrievedNode {
  id: string;
  node_type: string;
  source_system: string;
  external_id: string;
  title: string;
  updated_at: string;
  score: number;
  depth: number;
  is_seed: boolean;
  relevance: number | null;
  matched_node_id: string | null;
  snippet: string | null;
  seed_id: string;
  edge_path: string[];
  via_edge_id: string | null;
}

interface RawRetrievedEdge {
  edge_id: string;
  src_node_id: string;
  dst_node_id: string;
  raw_src_id: string;
  raw_dst_id: string;
  edge_type: string;
  weight: number;
  source_system: string;
}

interface RawRetrievalEnvelope {
  mode: SeedStrategy;
  seed_count: number;
  node_count: number;
  truncated: boolean;
  query_node_count: number;
  nodes: RawRetrievedNode[];
  edges: RawRetrievedEdge[];
}

type RetrievalEnvelopeRow = { result: RawRetrievalEnvelope };

function mapNode(row: RawRetrievedNode): RetrievedNode {
  return {
    id: row.id,
    nodeType: row.node_type,
    sourceSystem: row.source_system,
    externalId: row.external_id,
    title: row.title,
    updatedAt: new Date(row.updated_at),
    score: row.score,
    depth: row.depth,
    isSeed: row.is_seed,
    relevance: row.relevance,
    matchedNodeId: row.matched_node_id,
    snippet: row.snippet,
    seedId: row.seed_id,
    edgePath: row.edge_path,
    viaEdgeId: row.via_edge_id,
  };
}

function mapEdge(row: RawRetrievedEdge): RetrievedEdge {
  return {
    edgeId: row.edge_id,
    srcNodeId: row.src_node_id,
    dstNodeId: row.dst_node_id,
    rawSrcId: row.raw_src_id,
    rawDstId: row.raw_dst_id,
    edgeType: row.edge_type,
    weight: row.weight,
    sourceSystem: row.source_system,
  };
}

function mapFoundResult(envelope: RawRetrievalEnvelope): RetrievalResultFound {
  return {
    mode: envelope.mode,
    seedCount: envelope.seed_count,
    nodeCount: envelope.node_count,
    truncated: envelope.truncated,
    nodes: envelope.nodes.map(mapNode),
    edges: envelope.edges.map(mapEdge),
  };
}

// --- Option validation -------------------------------------------------------

function requirePositiveInteger(option: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new InvalidRetrievalOptionError(option, value, "must be a positive integer");
  }
}

/**
 * `[]` is rejected rather than treated as "match nothing": in the SQL,
 * `NULL` means "no filter" and `ARRAY[]` means "match nothing" (`= ANY(
 * ARRAY[])` is always false) — those are different intents, and a caller
 * passing `[]` almost always means the former. Pass `null`/omit the option
 * for "no filter".
 */
function normalizeStringArrayOption(
  option: string,
  value: readonly string[] | null | undefined,
): readonly string[] | null {
  if (value === undefined || value === null) return null;
  if (value.length === 0) {
    throw new InvalidRetrievalOptionError(option, value, "must be non-empty when provided (omit or pass null for 'no filter')");
  }
  for (const v of value) {
    if (typeof v !== "string" || v.trim().length === 0) {
      throw new InvalidRetrievalOptionError(option, value, "must contain only non-empty strings");
    }
  }
  return value;
}

type ResolvedRetrievalParams = Omit<BuildRetrievalQueryParams, "seedStrategy" | "queryText">;

/** Validates and defaults `RetrieveOptions`, throwing `InvalidRetrievalOptionError` on the first problem found. */
function resolveRetrievalParams(options: RetrieveOptions): ResolvedRetrievalParams {
  const seedLimit = options.seedLimit ?? DEFAULT_SEED_LIMIT;
  requirePositiveInteger("seedLimit", seedLimit);

  const minRelevance = options.minRelevance ?? DEFAULT_MIN_RELEVANCE;
  if (!Number.isFinite(minRelevance) || minRelevance <= 0) {
    throw new InvalidRetrievalOptionError(
      "minRelevance",
      minRelevance,
      "must be a positive number — a query consisting only of exclusions matches every document lacking the term at rank zero, so a floor of 0 (or lower) is not safe",
    );
  }

  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > MAX_ALLOWED_DEPTH) {
    throw new InvalidRetrievalOptionError("maxDepth", maxDepth, `must be an integer between 0 and ${MAX_ALLOWED_DEPTH}`);
  }

  const fanout = options.fanout ?? DEFAULT_FANOUT;
  requirePositiveInteger("fanout", fanout);

  const nodeBudget = options.nodeBudget ?? DEFAULT_NODE_BUDGET;
  requirePositiveInteger("nodeBudget", nodeBudget);

  const decay = options.decay ?? DEFAULT_DECAY;
  if (!Number.isFinite(decay) || decay <= 0 || decay > 1) {
    throw new InvalidRetrievalOptionError("decay", decay, "must be in the range (0, 1]");
  }

  const nodeTypes = normalizeStringArrayOption("nodeTypes", options.nodeTypes);
  const sourceSystems = normalizeStringArrayOption("sourceSystems", options.sourceSystems);
  const edgeTypes = normalizeStringArrayOption("edgeTypes", options.edgeTypes);

  let updatedSince: Date | null = null;
  if (options.updatedSince !== undefined && options.updatedSince !== null) {
    if (!(options.updatedSince instanceof Date) || Number.isNaN(options.updatedSince.getTime())) {
      throw new InvalidRetrievalOptionError("updatedSince", options.updatedSince, "must be a valid Date");
    }
    updatedSince = options.updatedSince;
  }

  return { seedLimit, minRelevance, maxDepth, fanout, nodeBudget, decay, nodeTypes, sourceSystems, edgeTypes, updatedSince };
}

// --- Execution -----------------------------------------------------------

async function execRetrievalQuery(
  db: Database,
  params: BuildRetrievalQueryParams,
): Promise<RawRetrievalEnvelope> {
  let result: { rows: RetrievalEnvelopeRow[] };
  try {
    result = await db.execute<RetrievalEnvelopeRow>(buildRetrievalQuery(params));
  } catch (err) {
    throw new RetrievalFailedError(
      `${params.seedStrategy} retrieval query failed${formatPgInfo(asPgError(err))}`,
      params.seedStrategy,
      { cause: err },
    );
  }

  const row = result.rows[0];
  if (!row) {
    throw new RetrievalFailedError(`${params.seedStrategy} retrieval query returned no row`, params.seedStrategy);
  }
  return row.result;
}

/**
 * Query text in, a bounded scored subgraph out.
 *
 * Issues exactly one statement (the exact-match seeds + traversal query)
 * unless it reports zero seeds, in which case a second, fuzzy statement is
 * issued (retrieval spec, "Fuzzy fallback when exact search finds
 * nothing"). If both statements report zero seeds, the result is `{ mode:
 * "empty", triedModes: ["exact", "fuzzy"], nodes: [], edges: [] }` — this
 * is not an error, it is a documented outcome the caller must be able to
 * tell apart from "found nothing because a filter excluded everything" vs.
 * "the query itself was unusable" (see `EmptyQueryError`).
 */
export async function retrieve(
  db: Database,
  queryText: string,
  options: RetrieveOptions = {},
): Promise<RetrievalResult> {
  if (queryText.trim().length === 0) {
    throw new EmptyQueryError(queryText);
  }

  const resolved = resolveRetrievalParams(options);

  const exactEnvelope = await execRetrievalQuery(db, { ...resolved, seedStrategy: "exact", queryText });

  // Rejected here rather than before the statement ran: distinguishing a
  // stopword-only query ("the of and", numnode = 0) from a normal one
  // needs Postgres's own text-search parser, and the exact path is only
  // allowed to issue one statement — so this is decided from data the
  // single statement already returned, not a preliminary round trip.
  if (exactEnvelope.query_node_count === 0) {
    throw new EmptyQueryError(queryText);
  }

  if (exactEnvelope.seed_count > 0) {
    return mapFoundResult(exactEnvelope);
  }

  const fuzzyEnvelope = await execRetrievalQuery(db, { ...resolved, seedStrategy: "fuzzy", queryText });

  if (fuzzyEnvelope.seed_count > 0) {
    return mapFoundResult(fuzzyEnvelope);
  }

  return { mode: "empty", triedModes: ["exact", "fuzzy"], nodes: [], edges: [] };
}

// --- Store summary (task 4.5 — independent of the rest of this module) -----

export interface StoreSummaryOptions {
  /** How many recently-updated nodes to include. Default `DEFAULT_RECENT_NODES_LIMIT` (10). */
  recentNodesLimit?: number;
}

export interface NodeTypeCount {
  nodeType: string;
  count: number;
}

export interface SourceSystemCount {
  sourceSystem: string;
  count: number;
}

export interface EdgeTypeCount {
  edgeType: string;
  count: number;
}

export interface RecentNode {
  id: string;
  nodeType: string;
  sourceSystem: string;
  externalId: string;
  title: string;
  updatedAt: Date;
}

export interface StoreSummary {
  totalNodes: number;
  totalEdges: number;
  nodeTypes: NodeTypeCount[];
  sourceSystems: SourceSystemCount[];
  edgeTypes: EdgeTypeCount[];
  recentNodes: RecentNode[];
}

interface RawStoreSummary {
  total_nodes: number;
  total_edges: number;
  node_types: { node_type: string; count: number }[];
  source_systems: { source_system: string; count: number }[];
  edge_types: { edge_type: string; count: number }[];
  recent_nodes: {
    id: string;
    node_type: string;
    source_system: string;
    external_id: string;
    title: string;
    updated_at: string;
  }[];
}

/**
 * Pure query builder for the store summary — node types, source systems,
 * and edge types in use with their counts, plus the most recently updated
 * nodes (retrieval spec, "The store's vocabulary is discoverable").
 * Aggregates over `resolved_nodes`, not `nodes`, so a merged-away row
 * neither inflates a count nor appears in `recentNodes` under its own
 * (now-superseded) identity. `edges` has no equivalent view, but an edge
 * row's existence — not its endpoints' merge status — is what's being
 * counted, so no canonicalization is needed there.
 */
export function buildStoreSummaryQuery(recentNodesLimit: number): SQL {
  return sql`
SELECT jsonb_build_object(
  'total_nodes', (SELECT count(*) FROM resolved_nodes),
  'total_edges', (SELECT count(*) FROM edges),
  'node_types', COALESCE((
    SELECT jsonb_agg(jsonb_build_object('node_type', node_type, 'count', cnt)
                      ORDER BY cnt DESC, node_type)
    FROM (SELECT node_type, count(*)::int AS cnt FROM resolved_nodes GROUP BY node_type) t
  ), '[]'::jsonb),
  'source_systems', COALESCE((
    SELECT jsonb_agg(jsonb_build_object('source_system', source_system, 'count', cnt)
                      ORDER BY cnt DESC, source_system)
    FROM (SELECT source_system, count(*)::int AS cnt FROM resolved_nodes GROUP BY source_system) t
  ), '[]'::jsonb),
  'edge_types', COALESCE((
    SELECT jsonb_agg(jsonb_build_object('edge_type', edge_type, 'count', cnt)
                      ORDER BY cnt DESC, edge_type)
    FROM (SELECT edge_type, count(*)::int AS cnt FROM edges GROUP BY edge_type) t
  ), '[]'::jsonb),
  'recent_nodes', COALESCE((
    SELECT jsonb_agg(to_jsonb(t) ORDER BY t.updated_at DESC, t.id)
    FROM (
      SELECT id, node_type, source_system, external_id, title, updated_at
      FROM resolved_nodes
      ORDER BY updated_at DESC, id
      LIMIT ${recentNodesLimit}::int
    ) t
  ), '[]'::jsonb)
) AS result
`;
}

/** Lets a caller orient before searching: what node types, source systems, and edge types exist, and what's new. */
export async function getStoreSummary(db: Database, options: StoreSummaryOptions = {}): Promise<StoreSummary> {
  const recentNodesLimit = options.recentNodesLimit ?? DEFAULT_RECENT_NODES_LIMIT;
  if (!Number.isInteger(recentNodesLimit) || recentNodesLimit <= 0) {
    throw new InvalidRetrievalOptionError("recentNodesLimit", recentNodesLimit, "must be a positive integer");
  }

  let result: { rows: { result: RawStoreSummary }[] };
  try {
    result = await db.execute<{ result: RawStoreSummary }>(buildStoreSummaryQuery(recentNodesLimit));
  } catch (err) {
    throw new RetrievalFailedError(`store summary query failed${formatPgInfo(asPgError(err))}`, "summary", { cause: err });
  }

  const row = result.rows[0];
  if (!row) {
    throw new RetrievalFailedError("store summary query returned no row", "summary");
  }
  const raw = row.result;

  return {
    totalNodes: raw.total_nodes,
    totalEdges: raw.total_edges,
    nodeTypes: raw.node_types.map((r) => ({ nodeType: r.node_type, count: r.count })),
    sourceSystems: raw.source_systems.map((r) => ({ sourceSystem: r.source_system, count: r.count })),
    edgeTypes: raw.edge_types.map((r) => ({ edgeType: r.edge_type, count: r.count })),
    recentNodes: raw.recent_nodes.map((r) => ({
      id: r.id,
      nodeType: r.node_type,
      sourceSystem: r.source_system,
      externalId: r.external_id,
      title: r.title,
      updatedAt: new Date(r.updated_at),
    })),
  };
}
