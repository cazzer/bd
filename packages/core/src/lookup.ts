/**
 * Direct-lookup reads for the MCP server (bd-vt2.5): id(s) in, full node
 * content or immediate neighbors out. No scoring, no traversal — these are
 * the deterministic counterparts to `retrieve()` (retrieval.ts), for when
 * an agent already has a node id (from a prior search, write, or neighbor
 * listing) and wants its content or what touches it.
 *
 * Both functions must respect merge semantics exactly as retrieval.ts
 * does, and reuse its two folding techniques rather than reinventing them:
 *
 *   - `getNodes` resolves each requested id through `COALESCE(merged_into,
 *     id)` before lookup, so an id naming a merged-away node returns its
 *     survivor's content — never the merged-away row, and never silently
 *     nothing. An id matching no node at all (neither directly nor via a
 *     merge) is reported back in `notFoundIds` rather than omitted, per
 *     the brain-mcp spec's "Report ids that matched nothing rather than
 *     silently omitting them."
 *
 *   - `getNeighbors` folds `edges.src_id`/`dst_id` through the same
 *     `COALESCE(merged_into, id)` on *both* the probed node (so an edge
 *     attached to a merged-away alias of the queried node is still found)
 *     and the far endpoint (so a neighbor that has itself been merged away
 *     is reported as its own survivor). It excludes merge-induced
 *     self-loops with the identical guard `result_edges` uses in
 *     retrieval.ts (`canonical_other_id <> canonical_self_id`) — read that
 *     comment before touching this one; the two are the same fix for the
 *     same shape of bug (an edge from a loser to its own survivor folding
 *     into a node "related to itself").
 *
 *     `getNeighbors` is bounded (bd-hmd.1): a hub can have hundreds of
 *     edges, and returning all of them defeats the point of a "look at one
 *     node" call. Results are ordered by weight descending with `node_id`
 *     then `edge_id` as deterministic tie-breaks, capped at `limit`
 *     (default `DEFAULT_NEIGHBOR_LIMIT`, hard ceiling `MAX_NEIGHBOR_LIMIT`
 *     — see that constant's comment for why a cap is load-bearing, not
 *     just tidy), and `hasMore`/`nextCursor` report whether more exist and
 *     how to fetch them. Pagination is keyset (`cursor` carries the last
 *     row's `weight`/`nodeId`/`edgeId`, plus the `canonicalId` it was
 *     minted for), not offset — an offset page is defined relative to a
 *     row count that shifts under concurrent writes (a new higher-weight
 *     edge asserted between pages shifts every later offset, silently
 *     repeating or skipping a neighbor), where a keyset page is defined
 *     relative to the last row actually seen and is unaffected by writes
 *     elsewhere in the order. `canonicalId` binds a cursor to the node it
 *     came from: replaying one node's cursor against another (e.g. a UI
 *     that switches the selected node mid-fetch) throws
 *     `InvalidLookupOptionError` rather than silently applying the wrong
 *     node's keyset filter and dropping neighbors with no signal
 *     (bd-hmd.1 review).
 *
 *   - `getNodesByExternalId` (github-prs-and-commits, closing bd-wq4) is the
 *     one read keyed by source identity — `(source_system, external_id)`,
 *     the pair `upsertNodes` dedups on — rather than by node id. It exists
 *     so a loader can link the nodes it just wrote to nodes another loader
 *     wrote (a commit to the GitHub issue its message names) through a
 *     public read instead of raw SQL in a script. Same fold as `getNodes`:
 *     a pair naming a merged-away row answers with its survivor's id and
 *     type, and a pair naming nothing is reported in `notFound`, never
 *     dropped. Unlike `getNodes`, an empty batch is not an error — a
 *     loader with no references to resolve is ordinary — and answers
 *     empty without a round trip.
 */

import { sql, type SQL } from "drizzle-orm";
import type { Database } from "@breakdown/db";
import { InvalidLookupIdError, InvalidLookupOptionError, LookupFailedError, NodeNotFoundError } from "./errors.js";
import { asPgError, formatPgInfo, sqlArray } from "./sql-helpers.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// --- getNodes ----------------------------------------------------------

export interface LookedUpNode {
  id: string;
  nodeType: string;
  sourceSystem: string;
  externalId: string;
  title: string;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  /**
   * Every id from the call's `ids` that resolved to this node. Usually
   * `[id]`, but more than one when the caller requested both a
   * merged-away node and its survivor (or several aliases of the same
   * survivor) in the same call — they collapse to one entry here rather
   * than one per requested id.
   */
  requestedIds: string[];
}

export interface GetNodesResult {
  nodes: LookedUpNode[];
  /** Requested ids that matched no node at all — reported, never silently dropped. */
  notFoundIds: string[];
}

function validateIds(ids: readonly string[]): string[] {
  if (ids.length === 0) {
    throw new InvalidLookupIdError(ids, "ids must be a non-empty array");
  }
  return ids.map((id) => {
    const trimmed = typeof id === "string" ? id.trim() : "";
    if (!UUID_RE.test(trimmed)) {
      throw new InvalidLookupIdError(id, "must be a valid uuid");
    }
    return trimmed;
  });
}

/**
 * Pure query builder — no database, so its SQL can be asserted on
 * directly in tests, same convention as `buildRetrievalQuery`. `ids` must
 * already be validated (see `validateIds`/`getNodes`).
 */
export function buildGetNodesQuery(ids: readonly string[]): SQL {
  return sql`
WITH requested(req_id) AS (
  SELECT * FROM unnest(${sqlArray(ids, "uuid")})
),
-- Every requested id resolved onto its canonical node — the merge fold.
-- A req_id matching no row in \`nodes\` at all resolves to NULL here (the
-- LEFT JOIN finds nothing), which is what distinguishes "matched nothing"
-- from "matched a merged-away node" below.
resolved AS (
  SELECT req.req_id, COALESCE(n.merged_into, n.id) AS canonical_id
  FROM requested req
  LEFT JOIN nodes n ON n.id = req.req_id
),
-- One row per canonical node actually found, carrying every requested id
-- that resolved to it (so two requested ids naming the same survivor —
-- e.g. the loser and the survivor itself — collapse to one entry instead
-- of duplicating the node).
found_nodes AS (
  SELECT c.id, c.node_type, c.source_system, c.external_id, c.title, c.content,
         c.metadata, c.created_at, c.updated_at, arr.requested_ids
  FROM (
    SELECT canonical_id, array_agg(DISTINCT req_id ORDER BY req_id) AS requested_ids
    FROM resolved
    WHERE canonical_id IS NOT NULL
    GROUP BY canonical_id
  ) arr
  JOIN resolved_nodes c ON c.id = arr.canonical_id
)
SELECT jsonb_build_object(
  'nodes', COALESCE((SELECT jsonb_agg(to_jsonb(fn) ORDER BY fn.id) FROM found_nodes fn), '[]'::jsonb),
  'not_found_ids', COALESCE((
    SELECT jsonb_agg(r.req_id ORDER BY r.req_id) FROM resolved r WHERE r.canonical_id IS NULL
  ), '[]'::jsonb)
) AS result
`;
}

interface RawLookedUpNode {
  id: string;
  node_type: string;
  source_system: string;
  external_id: string;
  title: string;
  content: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  requested_ids: string[];
}

interface RawGetNodesResult {
  nodes: RawLookedUpNode[];
  not_found_ids: string[];
}

function mapLookedUpNode(row: RawLookedUpNode): LookedUpNode {
  return {
    id: row.id,
    nodeType: row.node_type,
    sourceSystem: row.source_system,
    externalId: row.external_id,
    title: row.title,
    content: row.content,
    metadata: row.metadata,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    requestedIds: row.requested_ids,
  };
}

/**
 * Full node content by id, for one or more ids in a single round trip. An
 * id naming a merged-away node resolves to its survivor (see the module
 * header); an id matching nothing is reported in `notFoundIds`, never
 * silently omitted.
 */
export async function getNodes(db: Database, ids: readonly string[]): Promise<GetNodesResult> {
  const validated = validateIds(ids);

  let result: { rows: { result: RawGetNodesResult }[] };
  try {
    result = await db.execute<{ result: RawGetNodesResult }>(buildGetNodesQuery(validated));
  } catch (err) {
    throw new LookupFailedError(`getNodes query failed${formatPgInfo(asPgError(err))}`, "getNodes", { cause: err });
  }

  const row = result.rows[0];
  if (!row) {
    throw new LookupFailedError("getNodes query returned no row", "getNodes");
  }

  return {
    nodes: row.result.nodes.map(mapLookedUpNode),
    notFoundIds: row.result.not_found_ids,
  };
}

// --- getNeighbors --------------------------------------------------------

export type NeighborDirection = "outgoing" | "incoming";

export interface Neighbor {
  edgeId: string;
  direction: NeighborDirection;
  edgeType: string;
  weight: number;
  /** The edge's own `source_system` — which system/run asserted this relationship. */
  edgeSourceSystem: string;
  nodeId: string;
  nodeType: string;
  /** The neighboring node's `source_system` (distinct from `edgeSourceSystem`). */
  nodeSourceSystem: string;
  externalId: string;
  title: string;
  /**
   * The neighboring node's own store-wide degree (bd-hmd.5 review) —
   * distinct connected canonical nodes across the WHOLE STORE, not just
   * within this page or this call's result set. Same aggregate
   * retrieval.ts's `RetrievedNode.degree` computes (see that module's
   * "Store-wide degree" CTE comment for the full derivation), applied
   * here per neighbor instead of per traversal-kept node, and for the
   * same reason: a node drawn on screen by expansion must be the same
   * size as the same node drawn by search (graph-explorer/spec.md,
   * "Size is stable across views") — a degree scoped to "this page" or
   * defaulted to 0 would draw it smaller than the truth.
   */
  degree: number;
}

/**
 * Opaque-to-the-caller paging position: the last neighbor row seen, in
 * listing order, plus the canonical id of the node it was minted for.
 * `canonicalId` exists so a cursor cannot silently be replayed against a
 * different node — `getNeighbors` rejects a mismatch (bd-hmd.1 review)
 * rather than quietly applying the wrong node's keyset filter, which
 * would drop neighbors with no error and no signal.
 */
export interface NeighborsCursor {
  canonicalId: string;
  weight: number;
  nodeId: string;
  edgeId: string;
}

export interface GetNeighborsOptions {
  /** Max neighbors to return in this page. Default `DEFAULT_NEIGHBOR_LIMIT` (25); hard ceiling `MAX_NEIGHBOR_LIMIT`. */
  limit?: number;
  /** Continue after a previous call's `nextCursor`. Omit or pass `null` for the first page. Must have been minted for the same node (its `canonicalId` must match) — see `NeighborsCursor`. */
  cursor?: NeighborsCursor | null;
}

export interface GetNeighborsResult {
  /** The id passed to `getNeighbors`, trimmed. */
  requestedId: string;
  /** Canonical (merge-resolved) id of the node whose neighbors were listed — differs from `requestedId` only when it names a merged-away node. */
  canonicalId: string;
  /** At most `limit` neighbors, ordered by weight descending, then node id, then edge id — a total order, so repeated identical requests return identical results. */
  neighbors: Neighbor[];
  /** True when neighbors beyond this page were withheld by `limit`. */
  hasMore: boolean;
  /** Pass as `cursor` to fetch the next page. `null` when `hasMore` is false. */
  nextCursor: NeighborsCursor | null;
}

/** Resolved, validated arguments to `buildGetNeighborsQuery` — see `getNeighbors` for how `limit`/`cursor` are validated. */
export interface BuildGetNeighborsQueryParams {
  id: string;
  limit: number;
  cursor: NeighborsCursor | null;
}

/**
 * Pure query builder — no database. `id` must already be validated to
 * look like a uuid (see `getNeighbors`); it need not exist — the query
 * itself reports whether it found anything (`found` in the raw result),
 * which `getNeighbors` turns into `NodeNotFoundError` when it did not.
 */
export function buildGetNeighborsQuery(params: BuildGetNeighborsQueryParams): SQL {
  // NULL means "first page" — mirrors retrieval.ts's nullable-filter
  // convention (`(:param IS NULL OR ...)`), rather than a second code
  // path for "no cursor" vs. "cursor".
  const cursorWeight = params.cursor === null ? sql`NULL::double precision` : sql`${params.cursor.weight}::double precision`;
  const cursorNodeId = params.cursor === null ? sql`NULL::uuid` : sql`${params.cursor.nodeId}::uuid`;
  const cursorEdgeId = params.cursor === null ? sql`NULL::uuid` : sql`${params.cursor.edgeId}::uuid`;

  return sql`
WITH self AS (
  SELECT id, COALESCE(merged_into, id) AS canonical_id
  FROM nodes WHERE id = ${params.id}
),
-- Every node merged away into the queried node's canonical id — an edge
-- attached to one of these must still surface as this node's neighbor
-- (retrieval.ts's \`probe_ids\`/\`alias\` pattern, mirrored here for a
-- single node instead of a whole traversal frontier).
alias AS (
  SELECT id AS alias_id FROM nodes WHERE merged_into = (SELECT canonical_id FROM self)
),
probe(probe_id) AS (
  SELECT canonical_id FROM self
  UNION ALL
  SELECT alias_id FROM alias
),
-- Both directions, each resolving the FAR endpoint through the same
-- merge fold — a neighbor that has itself been merged away is reported
-- as its own survivor, not the stale row an edge happens to point at.
raw_neighbors AS (
  SELECT e.id AS edge_id, e.edge_type, e.weight::double precision AS weight,
         e.source_system AS edge_source_system, 'outgoing'::text AS direction,
         COALESCE(dn.merged_into, dn.id) AS other_id
  FROM edges e
  JOIN nodes dn ON dn.id = e.dst_id
  WHERE e.src_id IN (SELECT probe_id FROM probe)

  UNION ALL

  SELECT e.id, e.edge_type, e.weight::double precision,
         e.source_system, 'incoming'::text,
         COALESCE(sn.merged_into, sn.id)
  FROM edges e
  JOIN nodes sn ON sn.id = e.src_id
  WHERE e.dst_id IN (SELECT probe_id FROM probe)
),
filtered AS (
  SELECT rn.edge_id, rn.edge_type, rn.weight, rn.edge_source_system, rn.direction,
         n.id AS node_id, n.node_type, n.source_system AS node_source_system,
         n.external_id, n.title
  FROM raw_neighbors rn
  JOIN resolved_nodes n ON n.id = rn.other_id
  -- Merge-induced self-loop guard — exactly retrieval.ts's result_edges
  -- guard (see that CTE's comment): once an edge's far endpoint folds
  -- onto this node's OWN canonical id (e.g. a loser-to-survivor edge,
  -- once the loser is merged into this node), it says this node relates
  -- to itself, which is not a neighbor. The raw edge is untouched in the
  -- database — this only excludes it from this listing.
  WHERE rn.other_id <> (SELECT canonical_id FROM self)
),
-- Keyset page (bd-hmd.1): "strictly after" the cursor under the exact
-- same total order as the final ORDER BY below (weight DESC, node_id
-- ASC, edge_id ASC), so paging never repeats or skips a row regardless
-- of how many neighbors tie on weight. A NULL cursor (first page)
-- matches every row. Fetches one row beyond \`limit\` so \`has_more\`
-- below is answered without a separate COUNT(*) over the (unbounded)
-- neighbor set.
paged AS (
  SELECT f.*
  FROM filtered f
  WHERE ${cursorWeight} IS NULL
     OR f.weight < ${cursorWeight}
     OR (f.weight = ${cursorWeight} AND f.node_id > ${cursorNodeId})
     OR (f.weight = ${cursorWeight} AND f.node_id = ${cursorNodeId} AND f.edge_id > ${cursorEdgeId})
  ORDER BY f.weight DESC, f.node_id ASC, f.edge_id ASC
  LIMIT ${params.limit + 1}::int
),
-- The actual response page — at most \`limit\` rows, dropping the one
-- extra \`paged\` fetched only to answer \`has_more\`. Named separately so
-- the degree CTEs below (and the final SELECT) can reference "what is
-- actually being returned" without re-deriving it or recomputing degree
-- for the discarded \`limit + 1\`th row.
page AS (
  SELECT * FROM paged
  ORDER BY weight DESC, node_id ASC, edge_id ASC
  LIMIT ${params.limit}::int
),
-- Store-wide degree of each neighbor NODE actually in \`page\` (bd-hmd.5
-- review — graph-explorer/spec.md's "Size is stable across views": a
-- node drawn by expansion must be the same size as the same node drawn
-- by search, so this cannot default to 0 or be scoped to this result).
-- Mirrors retrieval.ts's degree CTE exactly (see that module's "Store-
-- wide degree" comment for the full derivation) — computed fresh here
-- too, never cached, and scoped to \`page\` for the same reason
-- retrieval.ts scopes to \`kept\`: computing this for a node that is not
-- even in the response would be wasted work.
--
-- A neighbor's own canonical id can itself have merged-away aliases —
-- a node can simultaneously be "a neighbor of the queried node" and "a
-- survivor other nodes were merged into" — so \`neighbor_probe\` folds
-- those in via \`neighbor_alias\`, the same alias-then-probe shape
-- \`self\`/\`alias\`/\`probe\` above uses for the QUERIED node, applied here
-- once per distinct neighbor instead of once for the query's own node.
distinct_page_nodes AS (
  SELECT DISTINCT node_id FROM page
),
neighbor_alias AS (
  SELECT dpn.node_id AS canonical_id, al.id AS alias_id
  FROM distinct_page_nodes dpn
  JOIN nodes al ON al.merged_into = dpn.node_id
),
neighbor_probe AS (
  SELECT dpn.node_id,
         ARRAY[dpn.node_id] || COALESCE(array_agg(na.alias_id) FILTER (WHERE na.alias_id IS NOT NULL), ARRAY[]::uuid[]) AS probe_ids
  FROM distinct_page_nodes dpn
  LEFT JOIN neighbor_alias na ON na.canonical_id = dpn.node_id
  GROUP BY dpn.node_id
),
degree AS (
  SELECT np.node_id, COUNT(DISTINCT far.canonical_id) AS degree
  FROM neighbor_probe np
  LEFT JOIN LATERAL (
    SELECT COALESCE(dn.merged_into, dn.id) AS canonical_id
    FROM edges e
    JOIN nodes dn ON dn.id = e.dst_id
    WHERE e.src_id = ANY (np.probe_ids)
      -- Merge-induced self-loop guard, same shape as \`filtered\`'s own
      -- \`rn.other_id <>\` guard above and retrieval.ts's degree CTE — a
      -- loser-to-survivor edge must not inflate this neighbor's own
      -- degree by counting a connection to itself.
      AND COALESCE(dn.merged_into, dn.id) <> np.node_id

    UNION ALL

    SELECT COALESCE(sn.merged_into, sn.id)
    FROM edges e
    JOIN nodes sn ON sn.id = e.src_id
    WHERE e.dst_id = ANY (np.probe_ids)
      AND COALESCE(sn.merged_into, sn.id) <> np.node_id
  ) far ON true
  GROUP BY np.node_id
)
SELECT jsonb_build_object(
  'found', EXISTS(SELECT 1 FROM self),
  'canonical_id', (SELECT canonical_id FROM self),
  'neighbors', COALESCE((
    SELECT jsonb_agg(to_jsonb(p) || jsonb_build_object('degree', COALESCE(d.degree, 0)) ORDER BY p.weight DESC, p.node_id, p.edge_id)
    FROM page p
    LEFT JOIN degree d ON d.node_id = p.node_id
  ), '[]'::jsonb),
  'has_more', (SELECT count(*) FROM paged) > ${params.limit}::int
) AS result
`;
}

interface RawNeighbor {
  edge_id: string;
  edge_type: string;
  weight: number;
  edge_source_system: string;
  direction: NeighborDirection;
  node_id: string;
  node_type: string;
  node_source_system: string;
  external_id: string;
  title: string;
  degree: number;
}

interface RawGetNeighborsResult {
  found: boolean;
  canonical_id: string | null;
  neighbors: RawNeighbor[];
  has_more: boolean;
}

/** Default page size for `getNeighbors` — same order of magnitude as `DEFAULT_FANOUT` (retrieval.ts's per-node traversal cap), for the same reason: a hub's true neighbor count is unbounded, this call's cost per page should not be. */
export const DEFAULT_NEIGHBOR_LIMIT = 25;

/**
 * Hard ceiling on `limit`, mirroring `MAX_ALLOWED_DEPTH`'s precedent in
 * retrieval.ts (bd-hmd.1 review): without a cap, `buildGetNeighborsQuery`
 * computes `limit + 1` in JS before binding it as `::int`, so a caller
 * passing e.g. `Number.MAX_SAFE_INTEGER` overflows Postgres's `int4` at
 * bind time. That throws `LookupFailedError` whose `.cause` embeds the
 * *entire* SQL statement — every inline comment, every bound param — which
 * is exactly what `InvalidLookupOptionError`'s "rejected before any SQL
 * runs" contract exists to prevent a bad option from reaching. Rejecting
 * an out-of-range limit here, before `buildGetNeighborsQuery` is ever
 * called, keeps that contract and keeps query text out of a caller-facing
 * error (relevant once bd-hmd.3 puts a tRPC error formatter in front of
 * this).
 */
export const MAX_NEIGHBOR_LIMIT = 1000;

function mapNeighbor(row: RawNeighbor): Neighbor {
  return {
    edgeId: row.edge_id,
    direction: row.direction,
    edgeType: row.edge_type,
    weight: row.weight,
    edgeSourceSystem: row.edge_source_system,
    nodeId: row.node_id,
    nodeType: row.node_type,
    nodeSourceSystem: row.node_source_system,
    externalId: row.external_id,
    title: row.title,
    degree: row.degree,
  };
}

/** Validates `limit`/`cursor`, throwing `InvalidLookupOptionError` on the first problem found — before any SQL runs, same convention as retrieval.ts's `resolveRetrievalParams`. */
function resolveGetNeighborsOptions(options: GetNeighborsOptions): { limit: number; cursor: NeighborsCursor | null } {
  const limit = options.limit ?? DEFAULT_NEIGHBOR_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_NEIGHBOR_LIMIT) {
    throw new InvalidLookupOptionError("limit", limit, `must be a positive integer no greater than ${MAX_NEIGHBOR_LIMIT}`);
  }

  const cursor = options.cursor ?? null;
  if (cursor !== null) {
    if (typeof cursor !== "object") {
      throw new InvalidLookupOptionError("cursor", cursor, "must be an object with canonicalId, weight, nodeId, and edgeId, or null");
    }
    if (typeof cursor.canonicalId !== "string" || !UUID_RE.test(cursor.canonicalId.trim())) {
      throw new InvalidLookupOptionError("cursor", cursor, "cursor.canonicalId must be a valid uuid");
    }
    if (!Number.isFinite(cursor.weight)) {
      throw new InvalidLookupOptionError("cursor", cursor, "cursor.weight must be a finite number");
    }
    if (typeof cursor.nodeId !== "string" || !UUID_RE.test(cursor.nodeId.trim())) {
      throw new InvalidLookupOptionError("cursor", cursor, "cursor.nodeId must be a valid uuid");
    }
    if (typeof cursor.edgeId !== "string" || !UUID_RE.test(cursor.edgeId.trim())) {
      throw new InvalidLookupOptionError("cursor", cursor, "cursor.edgeId must be a valid uuid");
    }
  }

  return { limit, cursor };
}

/**
 * A node's immediate neighbors — edge type, direction, weight, and source
 * system for each — folded through merge resolution on both the queried
 * node and every neighbor (see the module header). Throws
 * `NodeNotFoundError` if `id` does not exist (directly or via a merge
 * chain), same treatment `mergeNodes` gives a missing id — unlike
 * `getNodes`, this takes a single required id, not a batch to partially
 * satisfy.
 *
 * Bounded and ordered (bd-hmd.1): at most `options.limit` (default
 * `DEFAULT_NEIGHBOR_LIMIT`) neighbors come back, by weight descending with
 * `nodeId` then `edgeId` as deterministic tie-breaks. `hasMore` reports
 * whether more exist; pass `nextCursor` back as `options.cursor` to fetch
 * the next page — see the module header for why this is keyset, not
 * offset, pagination.
 */
export async function getNeighbors(db: Database, id: string, options: GetNeighborsOptions = {}): Promise<GetNeighborsResult> {
  const trimmed = typeof id === "string" ? id.trim() : "";
  if (!UUID_RE.test(trimmed)) {
    throw new InvalidLookupIdError(id, "must be a valid uuid");
  }
  const { limit, cursor } = resolveGetNeighborsOptions(options);

  let result: { rows: { result: RawGetNeighborsResult }[] };
  try {
    result = await db.execute<{ result: RawGetNeighborsResult }>(buildGetNeighborsQuery({ id: trimmed, limit, cursor }));
  } catch (err) {
    throw new LookupFailedError(`getNeighbors query failed${formatPgInfo(asPgError(err))}`, "getNeighbors", { cause: err });
  }

  const row = result.rows[0];
  if (!row) {
    throw new LookupFailedError("getNeighbors query returned no row", "getNeighbors");
  }
  if (!row.result.found || row.result.canonical_id === null) {
    throw new NodeNotFoundError(trimmed);
  }
  // A cursor is only valid replayed against the node it was minted for
  // (see NeighborsCursor). The comparison needs the canonical id the
  // query just resolved — not `trimmed`/`id`, which may be a pre-merge
  // alias — so this can only be checked here, after the single round
  // trip, the same way NodeNotFoundError above is: existence and
  // identity both require DB truth. The query already ran with the
  // (possibly mismatched) cursor bound into its keyset filter; on a
  // mismatch that result is simply discarded in favor of throwing —
  // it's a read-only SELECT, so running it was harmless.
  if (cursor !== null && cursor.canonicalId !== row.result.canonical_id) {
    throw new InvalidLookupOptionError(
      "cursor",
      cursor,
      `cursor.canonicalId (${cursor.canonicalId}) does not match the node being listed (${row.result.canonical_id}) — ` +
        "this cursor was minted for a different node and cannot be replayed here",
    );
  }

  const neighbors = row.result.neighbors.map(mapNeighbor);
  const last = neighbors[neighbors.length - 1];
  const hasMore = row.result.has_more;

  return {
    requestedId: trimmed,
    canonicalId: row.result.canonical_id,
    neighbors,
    hasMore,
    nextCursor: hasMore && last ? { canonicalId: row.result.canonical_id, weight: last.weight, nodeId: last.nodeId, edgeId: last.edgeId } : null,
  };
}

// --- getNodesByExternalId ---------------------------------------------------

/**
 * Hard ceiling on the pairs one `getNodesByExternalId` call may name. A
 * loader resolves at most the distinct references of one batch through it
 * (github-prs-and-commits design.md decision 3), and that is hundreds at
 * most; bounding the statement keeps the two bound arrays — and the SQL a
 * driver failure would embed in its message — at a size a caller-facing
 * error can carry, the same reasoning as `MAX_NEIGHBOR_LIMIT`. Rejected
 * before any SQL runs.
 */
export const MAX_EXTERNAL_ID_LOOKUPS = 500;

/** One `(source_system, external_id)` pair — the write path's identity for a node, the unique key `upsertNodes` dedups on. */
export interface ExternalIdPair {
  sourceSystem: string;
  externalId: string;
}

/** A pair that named a node: the pair as asked (trimmed), the canonical node's id — a merged-away row answers with its survivor — and that canonical row's type. */
export interface ResolvedExternalId extends ExternalIdPair {
  id: string;
  nodeType: string;
}

export interface GetNodesByExternalIdResult {
  /** Every distinct pair that named a node, ordered by source system then external id — never by the order asked, so the answer cannot depend on it. */
  found: ResolvedExternalId[];
  /** Every distinct pair that named nothing, in the same order — reported, never silently dropped. */
  notFound: ExternalIdPair[];
}

/**
 * Trims every pair, rejects an empty half naming the pair's position, and
 * collapses duplicates (after trimming) so the statement binds each
 * identity once — "duplicate pairs answered once" is decided here, not by
 * a DISTINCT in the query. The bound is checked on what the caller passed,
 * before deduplication: a predictable rule ("at most 500 pairs"), and the
 * loader that is this read's consumer already passes distinct references.
 */
function validateExternalIdPairs(pairs: readonly ExternalIdPair[]): ExternalIdPair[] {
  if (!Array.isArray(pairs)) {
    throw new InvalidLookupIdError(pairs, "must be an array of { sourceSystem, externalId }", "external-id pairs");
  }
  if (pairs.length > MAX_EXTERNAL_ID_LOOKUPS) {
    throw new InvalidLookupOptionError("pairs", pairs.length, `must name no more than ${MAX_EXTERNAL_ID_LOOKUPS} pairs`);
  }
  const distinct = new Map<string, ExternalIdPair>();
  pairs.forEach((pair, index) => {
    const sourceSystem = typeof pair?.sourceSystem === "string" ? pair.sourceSystem.trim() : "";
    const externalId = typeof pair?.externalId === "string" ? pair.externalId.trim() : "";
    if (sourceSystem === "") {
      throw new InvalidLookupIdError(pair, `sourceSystem must be a non-empty string (pair at index ${index})`, "external-id pair");
    }
    if (externalId === "") {
      throw new InvalidLookupIdError(pair, `externalId must be a non-empty string (pair at index ${index})`, "external-id pair");
    }
    distinct.set(JSON.stringify([sourceSystem, externalId]), { sourceSystem, externalId });
  });
  return [...distinct.values()];
}

/**
 * Pure query builder — no database, same convention as `buildGetNodesQuery`.
 * `pairs` must already be validated and deduplicated (see
 * `validateExternalIdPairs`) and non-empty: the two arrays are bound
 * positionally into one `unnest`, so they must be the same length.
 */
export function buildGetNodesByExternalIdQuery(pairs: readonly ExternalIdPair[]): SQL {
  const sourceSystems = pairs.map((p) => p.sourceSystem);
  const externalIds = pairs.map((p) => p.externalId);
  return sql`
WITH requested(source_system, external_id) AS (
  SELECT * FROM unnest(${sqlArray(sourceSystems, "text")}, ${sqlArray(externalIds, "text")})
),
-- Each pair onto the row it names, if any, folded to its canonical id.
-- This join is on \`nodes\`, not \`resolved_nodes\`, on purpose: a pair
-- naming a merged-away row must answer with that row's survivor, and the
-- view hides exactly the row that carries the \`merged_into\` pointer —
-- the same deliberate exception retrieval.ts's seed search documents. A
-- pair matching nothing resolves to NULL here (the LEFT JOIN finds no
-- row), which is what separates "not found" from "merged away" below.
resolved AS (
  SELECT req.source_system, req.external_id, COALESCE(n.merged_into, n.id) AS canonical_id
  FROM requested req
  LEFT JOIN nodes n ON n.source_system = req.source_system AND n.external_id = req.external_id
)
SELECT jsonb_build_object(
  'found', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'source_system', r.source_system,
      'external_id', r.external_id,
      'id', c.id,
      'node_type', c.node_type
    ) ORDER BY r.source_system, r.external_id)
    FROM resolved r
    -- The canonical row's own type, through the view. A canonical id is
    -- never itself merged: nodes_merged_into_canonical_trigger (migration
    -- 0000) refuses any write, whatever the writer, whose merged_into
    -- names a row that is already merged, and mergeNodes repoints a row's
    -- dependents when it merges that row away. LEFT, with the NULL fold
    -- excluded below, so that if either guard were bypassed the pair
    -- comes back with a NULL id — which getNodesByExternalId turns into
    -- LookupFailedError — rather than vanishing from both lists.
    LEFT JOIN resolved_nodes c ON c.id = r.canonical_id
    WHERE r.canonical_id IS NOT NULL
  ), '[]'::jsonb),
  'not_found', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'source_system', r.source_system,
      'external_id', r.external_id
    ) ORDER BY r.source_system, r.external_id)
    FROM resolved r
    WHERE r.canonical_id IS NULL
  ), '[]'::jsonb)
) AS result
`;
}

interface RawResolvedExternalId {
  source_system: string;
  external_id: string;
  /** NULL only if the canonical id has no row in `resolved_nodes` — a broken invariant, reported as `LookupFailedError`, never a dropped pair. */
  id: string | null;
  node_type: string | null;
}

interface RawGetNodesByExternalIdResult {
  found: RawResolvedExternalId[];
  not_found: { source_system: string; external_id: string }[];
}

/**
 * Resolves a batch of `(source system, external id)` pairs to canonical
 * node ids and types in one round trip (knowledge-store spec, "Nodes can be
 * resolved by source identity"). A pair naming a merged-away node answers
 * with its survivor; a pair naming nothing is listed in `notFound`. Pairs
 * are trimmed, must be non-empty on both halves (`InvalidLookupIdError`
 * naming the pair's position, before any SQL), and may number at most
 * `MAX_EXTERNAL_ID_LOOKUPS` (`InvalidLookupOptionError`). Duplicates are
 * answered once; the answer's order is by pair, never by the order asked.
 * An empty batch answers empty without touching the database.
 */
export async function getNodesByExternalId(db: Database, pairs: readonly ExternalIdPair[]): Promise<GetNodesByExternalIdResult> {
  const validated = validateExternalIdPairs(pairs);
  if (validated.length === 0) {
    return { found: [], notFound: [] };
  }

  let result: { rows: { result: RawGetNodesByExternalIdResult }[] };
  try {
    result = await db.execute<{ result: RawGetNodesByExternalIdResult }>(buildGetNodesByExternalIdQuery(validated));
  } catch (err) {
    throw new LookupFailedError(`getNodesByExternalId query failed${formatPgInfo(asPgError(err))}`, "getNodesByExternalId", { cause: err });
  }

  const row = result.rows[0];
  if (!row) {
    throw new LookupFailedError("getNodesByExternalId query returned no row", "getNodesByExternalId");
  }

  const found: ResolvedExternalId[] = [];
  for (const r of row.result.found) {
    if (r.id === null || r.node_type === null) {
      throw new LookupFailedError(
        `getNodesByExternalId: (${r.source_system}, ${r.external_id}) folds to a canonical id that resolved_nodes does not hold — ` +
          "a merge chain nodes_merged_into_canonical_trigger and mergeNodes should have made impossible",
        "getNodesByExternalId",
      );
    }
    found.push({ sourceSystem: r.source_system, externalId: r.external_id, id: r.id, nodeType: r.node_type });
  }
  return {
    found,
    notFound: row.result.not_found.map((r) => ({ sourceSystem: r.source_system, externalId: r.external_id })),
  };
}
