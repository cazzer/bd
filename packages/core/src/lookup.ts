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
 */

import { sql, type SQL } from "drizzle-orm";
import type { Database } from "@breakdown/db";
import { InvalidLookupIdError, LookupFailedError, NodeNotFoundError } from "./errors.js";
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
}

export interface GetNeighborsResult {
  /** The id passed to `getNeighbors`, trimmed. */
  requestedId: string;
  /** Canonical (merge-resolved) id of the node whose neighbors were listed — differs from `requestedId` only when it names a merged-away node. */
  canonicalId: string;
  /** Sorted by weight descending, then edge id, for deterministic pagination/truncation at the caller. */
  neighbors: Neighbor[];
}

/**
 * Pure query builder — no database. `id` must already be validated to
 * look like a uuid (see `getNeighbors`); it need not exist — the query
 * itself reports whether it found anything (`found` in the raw result),
 * which `getNeighbors` turns into `NodeNotFoundError` when it did not.
 */
export function buildGetNeighborsQuery(id: string): SQL {
  return sql`
WITH self AS (
  SELECT id, COALESCE(merged_into, id) AS canonical_id
  FROM nodes WHERE id = ${id}
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
)
SELECT jsonb_build_object(
  'found', EXISTS(SELECT 1 FROM self),
  'canonical_id', (SELECT canonical_id FROM self),
  'neighbors', COALESCE((
    SELECT jsonb_agg(to_jsonb(f) ORDER BY f.weight DESC, f.edge_id) FROM filtered f
  ), '[]'::jsonb)
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
}

interface RawGetNeighborsResult {
  found: boolean;
  canonical_id: string | null;
  neighbors: RawNeighbor[];
}

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
  };
}

/**
 * A node's immediate neighbors — edge type, direction, weight, and source
 * system for each — folded through merge resolution on both the queried
 * node and every neighbor (see the module header). Throws
 * `NodeNotFoundError` if `id` does not exist (directly or via a merge
 * chain), same treatment `mergeNodes` gives a missing id — unlike
 * `getNodes`, this takes a single required id, not a batch to partially
 * satisfy.
 */
export async function getNeighbors(db: Database, id: string): Promise<GetNeighborsResult> {
  const trimmed = typeof id === "string" ? id.trim() : "";
  if (!UUID_RE.test(trimmed)) {
    throw new InvalidLookupIdError(id, "must be a valid uuid");
  }

  let result: { rows: { result: RawGetNeighborsResult }[] };
  try {
    result = await db.execute<{ result: RawGetNeighborsResult }>(buildGetNeighborsQuery(trimmed));
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

  return {
    requestedId: trimmed,
    canonicalId: row.result.canonical_id,
    neighbors: row.result.neighbors.map(mapNeighbor),
  };
}
