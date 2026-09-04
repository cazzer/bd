// Anchored, time-ordered neighbour read (timeline-view change, design.md
// decision 3; knowledge-store spec, "A node's timed neighbours are readable
// in time order"): for one anchor node, the canonical nodes adjacent to it
// by any edge in either direction that carry `occurred_at`, newest first,
// one row per node with the type and direction of the edge that joins it
// and its metadata, plus a count of the adjacent nodes the same narrowing
// selects that carry no time. The timeline view draws an epic's or a
// repository's history from this.
//
// Why this is its own statement and not a flag on `getNeighbors`
// (lookup.ts): that read's order is the graph's (weight), its rows are one
// per edge, it returns no metadata, and it computes a store-wide degree
// per row the timeline never draws — a flag changing all four would be a
// second procedure wearing the first's name. So the opening CTEs here —
// `self`/`alias`/`probe`/`raw_neighbors`/`filtered` — are lookup.ts's
// shape written out again rather than shared: each builder is one
// readable statement (retrieval.ts, lookup.ts, and tree.ts each hold their
// own), and the two must agree about what "adjacent" means — both
// directions, the anchor and the far endpoint each folded through
// `merged_into`, canonical rows only via `resolved_nodes`, the
// merge-induced self-loop dropped. Read lookup.ts's comments on those CTEs
// before changing these; the two are meant to move together.
//
// From `filtered` on, the shape is the timeline's own. `filtered` also
// carries `metadata` and applies the narrowing (`node_type = ANY`,
// `source_system = ANY`, each NULL for "all" — list.ts's nullable-filter
// convention), before the fold to one row per node, so the untimed count
// below sees the same set the page does. `per_node` takes `DISTINCT ON
// (node_id)` ordered by `node_id, weight DESC, edge_type, edge_id`: a node
// joined twice — a `belongs-to` and a `mentions` — is one item on a
// timeline, and choosing the heaviest edge (then the lesser type name,
// then the lesser edge id) makes the relation shown the same on every
// call. `timed` keeps the rows with a non-null value under the key —
// `metadata->>'occurred_at' IS NOT NULL`, not `metadata ? 'occurred_at'`:
// a JSON null under the key (reachable only past the contract, through
// the exported `upsertNodes`) would pass the key test with a NULL time,
// lead the page under `DESC`, and mint a cursor the read itself rejects;
// counting it as untimed is what "carries no time" means — and projects
// that value as text — no cast and no parse, because
// event-time.ts guarantees every writer stores the fixed-width canonical
// form, whose text order is its chronological order in any collation:
// every canonical value has the same punctuation at the same offsets, so
// comparing two is comparing their digits. A value that bypassed the
// contract (a raw `upsertNodes`) sorts wherever its text falls;
// timeline.test.ts documents that. The page is a keyset over
// `(occurred_at DESC, node_id ASC)` fetching `limit + 1` so `hasMore`
// needs no count (lookup.ts's convention; the cursor carries the text as
// the row held it, so a bypassed value pages as it sorts), and `untimed`
// counts `per_node`'s rows without the key in the same statement — the
// honest half of the answer ("3 shown, 12 have no time"), taken over the
// very set the page was cut from so a second request cannot disagree with
// the first.
//
// Not indexed on `occurred_at`: the set sorted is bounded by the anchor's
// edges, which `edges_src_id_edge_type_idx` / `edges_dst_id_edge_type_idx`
// already serve; an expression index would serve only a store-wide order,
// which is the unanchored timeline the proposal defers.

import { sql, type SQL } from "drizzle-orm";
import type { Database } from "@breakdown/db";
import { InvalidLookupIdError, InvalidLookupOptionError, LookupFailedError, NodeNotFoundError } from "./errors.js";
import { OCCURRED_AT_KEY } from "./event-time.js";
import { validateListNames } from "./list.js";
import type { NeighborDirection } from "./lookup.js";
import { asPgError, formatPgInfo, sqlArray } from "./sql-helpers.js";

/** Default page size — the feed's, so a timeline and a feed over the same view page alike. */
export const DEFAULT_TIMELINE_LIMIT = 50;
/** Hard ceiling on `limit`, `MAX_LIST_LIMIT`'s value for the same reason `MAX_NEIGHBOR_LIMIT` exists: `limit + 1` is computed in JS and bound as `::int`. */
export const MAX_TIMELINE_LIMIT = 500;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Opaque to callers: the last row's keyset position, `occurredAt` exactly
 * as the row held it. Pass a previous result's `nextCursor` back
 * unchanged. Unlike `NeighborsCursor`, it is not bound to the anchor or
 * the narrowing it was minted under (design.md decision 3): a caller
 * must not replay a cursor across anchors or narrowings — the read would
 * silently page the wrong set — and the web view's load-more guard, which
 * appends only while the view, anchor, and chosen types are unchanged, is
 * what enforces that.
 */
export interface TimelineCursor {
  occurredAt: string;
  id: string;
}

export interface GetTimelineOptions {
  /** Node types to keep; `null`/absent for all. Validated as `listNodes` validates its own. */
  nodeTypes?: readonly string[] | null;
  /** Source systems to keep; `null`/absent for all. Validated as `listNodes` validates its own. */
  sourceSystems?: readonly string[] | null;
  /** Default `DEFAULT_TIMELINE_LIMIT` (50), max `MAX_TIMELINE_LIMIT` (500). */
  limit?: number;
  cursor?: TimelineCursor | null;
}

/** One timed neighbour. Never content: the timeline is a listing, and the graph reads content by `getNodes`. */
export interface TimelineRow {
  /** Canonical id — a merged-away neighbour is reported as its survivor. */
  id: string;
  nodeType: string;
  sourceSystem: string;
  externalId: string;
  title: string;
  /** `metadata.occurred_at` as text — canonical (event-time.ts) for every row a writer produced. */
  occurredAt: string;
  metadata: Record<string, unknown>;
  /** The heaviest edge joining this node to the anchor: its type, and its direction as seen from the anchor. */
  edgeType: string;
  direction: NeighborDirection;
  weight: number;
}

export interface TimelineResult {
  /** Canonical (merge-resolved) id of the anchor whose neighbours were listed. */
  anchorId: string;
  /** At most `limit` rows, newest event first, then by id — a total order, so identical requests answer identically. */
  rows: TimelineRow[];
  /** True when timed neighbours beyond this page were withheld by `limit`. */
  hasMore: boolean;
  /** Pass as `cursor` to fetch the next page. `null` when `hasMore` is false. */
  nextCursor: TimelineCursor | null;
  /** Adjacent canonical nodes matching the same narrowing that carry no `occurred_at` — what the listing left out. */
  untimedCount: number;
}

/** Resolved, validated arguments to `buildGetTimelineQuery` — see `getTimeline` for how each is validated. */
export interface BuildGetTimelineQueryParams {
  anchorId: string;
  nodeTypes: readonly string[] | null;
  sourceSystems: readonly string[] | null;
  limit: number;
  cursor: TimelineCursor | null;
}

/**
 * Pure query builder — no database, so its SQL can be asserted on
 * directly, the convention every builder in this package follows.
 * `anchorId` must already be validated to look like a uuid and the options
 * resolved (see `getTimeline`); the anchor need not exist — the statement
 * reports whether it found one (`found`), which `getTimeline` turns into
 * `NodeNotFoundError` when it did not. See the module header for the shape.
 */
export function buildGetTimelineQuery(params: BuildGetTimelineQueryParams): SQL {
  // NULL means "all" for the two narrowings and "first page" for the
  // cursor — list.ts's and lookup.ts's nullable-parameter convention,
  // rather than a second code path per absent option.
  const nodeTypesArr = params.nodeTypes === null ? sql`NULL::text[]` : sqlArray(params.nodeTypes, "text");
  const sourceSystemsArr = params.sourceSystems === null ? sql`NULL::text[]` : sqlArray(params.sourceSystems, "text");
  const cursorOccurredAt = params.cursor === null ? sql`NULL::text` : sql`${params.cursor.occurredAt}::text`;
  const cursorId = params.cursor === null ? sql`NULL::uuid` : sql`${params.cursor.id}::uuid`;

  return sql`
WITH self AS (
  SELECT id, COALESCE(merged_into, id) AS canonical_id
  FROM nodes WHERE id = ${params.anchorId}
),
-- Every node merged away into the anchor's canonical id — an edge attached
-- to one of these must still surface (lookup.ts's alias/probe pattern).
alias AS (
  SELECT id AS alias_id FROM nodes WHERE merged_into = (SELECT canonical_id FROM self)
),
probe(probe_id) AS (
  SELECT canonical_id FROM self
  UNION ALL
  SELECT alias_id FROM alias
),
-- Both directions, the FAR endpoint folded through the same merge fold, so
-- a neighbour that has itself been merged away is reported as its survivor.
raw_neighbors AS (
  SELECT e.id AS edge_id, e.edge_type, e.weight::double precision AS weight,
         'outgoing'::text AS direction,
         COALESCE(dn.merged_into, dn.id) AS other_id
  FROM edges e
  JOIN nodes dn ON dn.id = e.dst_id
  WHERE e.src_id IN (SELECT probe_id FROM probe)

  UNION ALL

  SELECT e.id, e.edge_type, e.weight::double precision,
         'incoming'::text,
         COALESCE(sn.merged_into, sn.id)
  FROM edges e
  JOIN nodes sn ON sn.id = e.src_id
  WHERE e.dst_id IN (SELECT probe_id FROM probe)
),
-- Canonical rows only, the merge-induced self-loop dropped (lookup.ts's
-- guard: an edge whose far endpoint folds onto the anchor's own canonical
-- id says the anchor relates to itself, which is not a neighbour), and the
-- narrowing applied here — before the fold to one row per node — so the
-- untimed count below is over exactly the set the page is cut from.
filtered AS (
  SELECT rn.edge_id, rn.edge_type, rn.weight, rn.direction,
         n.id AS node_id, n.node_type, n.source_system, n.external_id, n.title, n.metadata
  FROM raw_neighbors rn
  JOIN resolved_nodes n ON n.id = rn.other_id
  WHERE rn.other_id <> (SELECT canonical_id FROM self)
    AND (${nodeTypesArr} IS NULL OR n.node_type = ANY(${nodeTypesArr}))
    AND (${sourceSystemsArr} IS NULL OR n.source_system = ANY(${sourceSystemsArr}))
),
-- One row per neighbour: the heaviest edge's type and direction, ties by
-- type name then edge id so the relation shown is the same on every call.
per_node AS (
  SELECT DISTINCT ON (f.node_id)
         f.node_id, f.node_type, f.source_system, f.external_id, f.title, f.metadata,
         f.edge_type, f.direction, f.weight
  FROM filtered f
  ORDER BY f.node_id, f.weight DESC, f.edge_type, f.edge_id
),
-- The rows that carry a time — a non-null value under the key (see the
-- module header on why not the key test) — the time as the text the
-- contract stored.
timed AS (
  SELECT p.*, p.metadata->>${OCCURRED_AT_KEY}::text AS occurred_at
  FROM per_node p
  WHERE p.metadata->>${OCCURRED_AT_KEY}::text IS NOT NULL
),
-- Keyset page: strictly after the cursor under the exact ORDER BY, one row
-- past the limit so has_more needs no count.
paged AS (
  SELECT t.*
  FROM timed t
  WHERE ${cursorOccurredAt} IS NULL
     OR t.occurred_at < ${cursorOccurredAt}
     OR (t.occurred_at = ${cursorOccurredAt} AND t.node_id > ${cursorId})
  ORDER BY t.occurred_at DESC, t.node_id ASC
  LIMIT ${params.limit + 1}::int
),
-- The rest of per_node: what the listing leaves out, counted over the same
-- narrowed set on every page.
untimed AS (
  SELECT count(*) AS untimed_count
  FROM per_node p
  WHERE p.metadata->>${OCCURRED_AT_KEY}::text IS NULL
)
SELECT jsonb_build_object(
  'found', EXISTS(SELECT 1 FROM self),
  'canonical_id', (SELECT canonical_id FROM self),
  'rows', COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.occurred_at DESC, p.node_id ASC) FROM paged p), '[]'::jsonb),
  'untimed_count', (SELECT untimed_count FROM untimed)
) AS result
`;
}

interface RawTimelineRow {
  node_id: string;
  node_type: string;
  source_system: string;
  external_id: string;
  title: string;
  metadata: Record<string, unknown>;
  edge_type: string;
  direction: NeighborDirection;
  weight: number;
  occurred_at: string;
}

interface RawGetTimelineResult {
  found: boolean;
  canonical_id: string | null;
  rows: RawTimelineRow[];
  untimed_count: number;
}

function mapTimelineRow(row: RawTimelineRow): TimelineRow {
  return {
    id: row.node_id,
    nodeType: row.node_type,
    sourceSystem: row.source_system,
    externalId: row.external_id,
    title: row.title,
    occurredAt: row.occurred_at,
    metadata: row.metadata,
    edgeType: row.edge_type,
    direction: row.direction,
    weight: row.weight,
  };
}

/**
 * Validates `limit` and `cursor` here (`InvalidLookupOptionError`, tree.ts's
 * convention) and the two name lists through list.ts's own rule
 * (`InvalidListOptionError` naming the option) — all before any SQL runs.
 * A cursor's `occurredAt` is any non-empty text: it is the keyset position
 * exactly as the row rendered it, and the read never parses it.
 */
function resolveGetTimelineOptions(options: GetTimelineOptions): Omit<BuildGetTimelineQueryParams, "anchorId"> {
  const limit = options.limit ?? DEFAULT_TIMELINE_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_TIMELINE_LIMIT) {
    throw new InvalidLookupOptionError("limit", limit, `must be a positive integer no greater than ${MAX_TIMELINE_LIMIT}`);
  }

  let cursor: TimelineCursor | null = null;
  if (options.cursor !== null && options.cursor !== undefined) {
    const c = options.cursor;
    if (typeof c !== "object" || typeof c.occurredAt !== "string" || c.occurredAt.length === 0 || typeof c.id !== "string" || !UUID_RE.test(c.id)) {
      throw new InvalidLookupOptionError("cursor", c, "must be a nextCursor from a previous getTimeline result ({ occurredAt, id }), or null for the first page");
    }
    cursor = { occurredAt: c.occurredAt, id: c.id };
  }

  return {
    nodeTypes: validateListNames("nodeTypes", options.nodeTypes),
    sourceSystems: validateListNames("sourceSystems", options.sourceSystems),
    limit,
    cursor,
  };
}

/**
 * The anchor's timed neighbours, newest first (knowledge-store spec, "A
 * node's timed neighbours are readable in time order"): one row per
 * adjacent canonical node that carries `occurred_at`, with the heaviest
 * joining edge's type and direction, narrowed by node type and source
 * system, paged by keyset, and the count of adjacent nodes under the same
 * narrowing that carry no time. Throws `InvalidLookupIdError` for a
 * malformed anchor id, `InvalidLookupOptionError` for a bad `limit` or
 * `cursor`, and `InvalidListOptionError` for a bad name list, all before
 * any SQL runs; `NodeNotFoundError` when the id names no node (directly or
 * through a merge), the treatment `getNeighbors` and `getSubtree` give a
 * single required id. A merged-away anchor answers its survivor's timeline
 * and reports the survivor as `anchorId`.
 */
export async function getTimeline(db: Database, anchorId: string, options: GetTimelineOptions = {}): Promise<TimelineResult> {
  const trimmed = typeof anchorId === "string" ? anchorId.trim() : "";
  if (!UUID_RE.test(trimmed)) {
    throw new InvalidLookupIdError(anchorId, "must be a valid uuid");
  }
  const resolved = resolveGetTimelineOptions(options);

  let result: { rows: { result: RawGetTimelineResult }[] };
  try {
    result = await db.execute<{ result: RawGetTimelineResult }>(buildGetTimelineQuery({ anchorId: trimmed, ...resolved }));
  } catch (err) {
    throw new LookupFailedError(`getTimeline query failed${formatPgInfo(asPgError(err))}`, "getTimeline", { cause: err });
  }

  const row = result.rows[0];
  if (!row) {
    throw new LookupFailedError("getTimeline query returned no row", "getTimeline");
  }
  if (!row.result.found || row.result.canonical_id === null) {
    throw new NodeNotFoundError(trimmed);
  }

  const hasMore = row.result.rows.length > resolved.limit;
  const pageRows = hasMore ? row.result.rows.slice(0, resolved.limit) : row.result.rows;
  const rows = pageRows.map(mapTimelineRow);
  const last = rows[rows.length - 1];

  return {
    anchorId: row.result.canonical_id,
    rows,
    hasMore,
    nextCursor: hasMore && last ? { occurredAt: last.occurredAt, id: last.id } : null,
    untimedCount: row.result.untimed_count,
  };
}
