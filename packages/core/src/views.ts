// Node views (node-views change; node-views spec): the contract a `view`
// node's metadata obeys, the `default_view` edge convention, and the
// batched resolution of a node's effective default view along `child_of`.
//
// The contract is enforced here and at every writer, never by the
// database, exactly as work-items.ts does for work items: `node_type` stays
// open text and `upsertNodes` stays type-agnostic. A view's `filter` is the
// listing selection `listNodes` already validates (list.ts), passed through
// `resolveListNodesOptions` rather than re-validated here, so the two can
// never disagree about what a valid selection is. `limit` and `cursor` are
// refused inside a filter: they belong to whoever reads the view, not to
// the view. So is any key that is not a listing option: `listNodes` ignores
// what it does not know, so a misspelt key would persist and select every
// node.
//
// `default_view` is a plain edge (design.md decision 2). It goes through
// `upsertEdges` / `brain_link` / `assertEdge` untouched, carrying its own
// provenance, which is what lets a re-import of the governed node leave the
// declaration intact (the node upsert replaces `metadata` wholesale; no
// loader deletes another source's edges). Resolution, not the write path,
// rejects a bad target: the candidate join below finds nothing for an edge
// whose folded target is not a canonical `view` node. Nothing constrains
// how many `default_view` edges a node carries; ties resolve
// deterministically instead (heavier edge, then lesser view id, then
// lesser declaring node).
//
// Resolution (decision 3) is one statement. The input ids fold through
// `merged_into`; a recursive walk climbs `child_of` edges with both
// endpoints folded, probing edges by `src_id = ANY(probe_ids)` (the
// survivor plus every merged-away alias — retrieval.ts's alias pattern) so
// `edges_src_id_edge_type_idx` serves each level; and the nearest
// declaration wins: depth, then weight DESC, then view id. The walk carries
// `depth`, which has a consequence worth being exact about: `UNION`'s set
// semantics dedupes a node reached by many paths at one depth (bounding the
// working set to nodes-per-level, never paths — the lesson work-items.ts
// and migration 0005 encode), but a node re-reached at a greater depth is a
// distinct row, so on a `child_of` cycle it is the depth cap
// (`MAX_RESOLVE_DEPTH`) that terminates the walk, never the statement
// timeout. Only `blocks` has an acyclicity trigger; a `child_of` cycle is
// legal data and costs at most `MAX_RESOLVE_DEPTH` rows per cycle member
// per requested id.
// A merge-induced self-loop (a `child_of` from a loser to its own survivor)
// is dropped outright, for the reason work-items.ts drops it for `blocks`:
// "a node is a child of itself" is not containment.

import { sql, type SQL } from "drizzle-orm";
import type { Database } from "@breakdown/db";
import { InvalidListOptionError, InvalidLookupIdError, InvalidViewError, LookupFailedError } from "./errors.js";
import { resolveListNodesOptions, type ListNodesOptions } from "./list.js";
import { asPgError, formatPgInfo, sqlArray } from "./sql-helpers.js";
import { CHILD_OF_EDGE_TYPE } from "./work-items.js";

// --- Conventions ------------------------------------------------------------

export const VIEW_NODE_TYPE = "view";
/** `code` is reserved: a view naming it is valid today so it stays valid when that renderer lands; nothing draws it yet. */
export const VIEW_RENDERERS = ["graph", "feed", "code"] as const;
export type ViewRenderer = (typeof VIEW_RENDERERS)[number];
/** Source node prefers to be shown as the target `view` node. */
export const DEFAULT_VIEW_EDGE_TYPE = "default_view";
/** Max ids one `resolveDefaultViews` call answers. */
export const MAX_RESOLVE_IDS = 200;
/** How many `child_of` hops up resolution looks. A declaration further away than this is not found. */
export const MAX_RESOLVE_DEPTH = 32;

/** What a view's `filter` may carry: everything `listNodes` accepts except the reader's `limit` and `cursor`. */
export type ViewFilter = Omit<ListNodesOptions, "limit" | "cursor">;

const READER_ONLY_FILTER_KEYS = ["limit", "cursor"] as const;
/** Every key a filter may carry. `listNodes` ignores a key it does not know, so an unknown one must be refused here or it persists and selects every node. */
const LISTING_OPTION_KEYS = ["nodeTypes", "sourceSystems", "updatedSince", "where"] as const satisfies readonly (keyof ViewFilter)[];

const FILTER_SHAPE = `an object of listing options (${LISTING_OPTION_KEYS.join(", ")})`;

export function isViewRenderer(value: unknown): value is ViewRenderer {
  return typeof value === "string" && (VIEW_RENDERERS as readonly string[]).includes(value);
}

export interface NormalizeViewOptions {
  /** How `InvalidViewError` names the item — e.g. `at batch index 2 (agent/open-work)`. Omitted: the error names no item. */
  itemLabel?: string;
}

/**
 * Applies the contract to a view's metadata (node-views spec, "A view is a
 * node with a validated contract"): `renderer` must be one of
 * `VIEW_RENDERERS`; `filter` must be an object `resolveListNodesOptions`
 * accepts, carrying neither `limit` nor `cursor` nor any key that is not a
 * listing option; every other top-level key passes through untouched. Pure.
 * Throws `InvalidViewError` naming the first offending field (`renderer`,
 * `filter`, `filter.limit`, `filter.<unknown key>`, or the offending
 * listing option under `filter.`, e.g. `filter.where[0].op`).
 */
export function normalizeViewMetadata(
  metadata: Record<string, unknown> | undefined,
  options: NormalizeViewOptions = {},
): Record<string, unknown> {
  const input = metadata ?? {};
  const item = options.itemLabel ?? null;
  const out: Record<string, unknown> = { ...input };

  const renderer = input["renderer"];
  if (!isViewRenderer(renderer)) {
    throw new InvalidViewError(item, "renderer", renderer, `must be one of ${VIEW_RENDERERS.join(", ")}`);
  }
  out["renderer"] = renderer;

  const filter = input["filter"];
  if (filter === undefined || filter === null) {
    throw new InvalidViewError(item, "filter", filter, `is required: ${FILTER_SHAPE}`);
  }
  if (typeof filter !== "object" || Array.isArray(filter)) {
    throw new InvalidViewError(item, "filter", filter, `must be ${FILTER_SHAPE}`);
  }
  const filterRecord = filter as Record<string, unknown>;
  for (const key of READER_ONLY_FILTER_KEYS) {
    if (Object.hasOwn(filterRecord, key)) {
      throw new InvalidViewError(item, `filter.${key}`, filterRecord[key], "belongs to the reader of a view, not to the view: pass it to listNodes / brain_list when reading");
    }
  }
  for (const key of Object.keys(filterRecord)) {
    if (!(LISTING_OPTION_KEYS as readonly string[]).includes(key)) {
      throw new InvalidViewError(item, `filter.${key}`, filterRecord[key], "is not a listing option");
    }
  }
  try {
    resolveListNodesOptions(filterRecord as ListNodesOptions);
  } catch (err) {
    if (err instanceof InvalidListOptionError) {
      throw new InvalidViewError(item, `filter.${err.option}`, err.value, err.reason, { cause: err });
    }
    throw err;
  }
  out["filter"] = { ...filterRecord };

  return out;
}

// --- Resolution -------------------------------------------------------------

export interface ResolvedDefaultView {
  /** The id as requested. A merged-away id is answered through its survivor but reported as given. */
  nodeId: string;
  /** The effective default view, or null when neither the node nor any ancestor within `MAX_RESOLVE_DEPTH` declares one. */
  view: {
    id: string;
    title: string;
    /** Null only for a view row written outside the contract (no valid `renderer` in its metadata). */
    renderer: ViewRenderer | null;
  } | null;
  /** Canonical id of the node whose `default_view` edge supplied `view` — the node itself, or the ancestor it inherits from. Null when `view` is null. */
  declaredBy: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateIds(ids: readonly string[]): string[] {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new InvalidLookupIdError(ids, "ids must be a non-empty array");
  }
  if (ids.length > MAX_RESOLVE_IDS) {
    throw new InvalidLookupIdError(ids.length, `ids must contain at most ${MAX_RESOLVE_IDS} entries`);
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
 * directly, same convention as `buildGetNodesQuery`. `ids` must already be
 * validated (see `resolveDefaultViews`). One row per requested id;
 * `view_id` is NULL when nothing applies. See the module header for the
 * walk, the fold, the tie-break, and the cycle guard.
 */
export function buildResolveDefaultViewsQuery(ids: readonly string[]): SQL {
  return sql`
WITH RECURSIVE
requested(req_id) AS (
  SELECT * FROM unnest(${sqlArray(ids, "uuid")})
),
-- Every requested id folded onto its canonical node. An id naming no node
-- folds to NULL and answers null at the end.
resolved AS (
  SELECT req.req_id, COALESCE(n.merged_into, n.id) AS canonical_id
  FROM requested req
  LEFT JOIN nodes n ON n.id = req.req_id
),
-- Every merged-away node grouped by its survivor (retrieval.ts's alias
-- CTE; one hop by the nodes_merged_into_canonical_trigger invariant).
-- probe_ids below is [canonical] || aliases, so \`src_id = ANY(probe_ids)\`
-- finds an edge asserted on a merged-away duplicate in the same indexed
-- probe that finds the survivor's own.
alias AS (
  SELECT merged_into AS canonical_id, array_agg(id ORDER BY id) AS alias_ids
  FROM nodes WHERE merged_into IS NOT NULL GROUP BY merged_into
),
-- Upward walk along child_of from each distinct canonical start. UNION,
-- not UNION ALL: a node reached by two paths at one depth is one row. The
-- depth cap is what stops a cycle (see the module header); the <> guard
-- drops merge-induced self-loops.
ancestors(start_id, node_id, depth, probe_ids) AS (
  SELECT s.canonical_id, s.canonical_id, 0,
         ARRAY[s.canonical_id] || COALESCE(a.alias_ids, ARRAY[]::uuid[])
  FROM (SELECT DISTINCT canonical_id FROM resolved WHERE canonical_id IS NOT NULL) s
  LEFT JOIN alias a ON a.canonical_id = s.canonical_id
  UNION
  SELECT anc.start_id, p.canonical_id, anc.depth + 1,
         ARRAY[p.canonical_id] || COALESCE(a.alias_ids, ARRAY[]::uuid[])
  FROM ancestors anc
  JOIN edges e ON e.src_id = ANY (anc.probe_ids) AND e.edge_type = ${CHILD_OF_EDGE_TYPE}
  JOIN nodes d ON d.id = e.dst_id
  CROSS JOIN LATERAL (SELECT COALESCE(d.merged_into, d.id) AS canonical_id) p
  LEFT JOIN alias a ON a.canonical_id = p.canonical_id
  WHERE anc.depth < ${MAX_RESOLVE_DEPTH}::int
    AND p.canonical_id <> anc.node_id
),
-- Every declaration reachable from a start: a default_view edge on the
-- ancestor or on a merged-away duplicate of it, whose folded target is a
-- canonical view node. An edge pointing anywhere else joins to nothing
-- here — that is the whole of "resolution ignores a mis-targeted edge".
candidates AS (
  SELECT anc.start_id, anc.node_id AS declared_by, anc.depth, dv.weight,
         v.id AS view_id, v.title, v.metadata->>'renderer' AS renderer
  FROM ancestors anc
  JOIN edges dv ON dv.src_id = ANY (anc.probe_ids) AND dv.edge_type = ${DEFAULT_VIEW_EDGE_TYPE}
  JOIN nodes t ON t.id = dv.dst_id
  JOIN resolved_nodes v ON v.id = COALESCE(t.merged_into, t.id) AND v.node_type = ${VIEW_NODE_TYPE}
),
-- Nearest wins; among equally near, the heavier edge; among equal weights,
-- the lesser view id; among equal views (one view declared by two equally
-- near ancestors), the lesser declaring node — deterministic on every
-- call, which the last key is needed for: Postgres's sort is not stable.
best AS (
  SELECT DISTINCT ON (c.start_id) c.start_id, c.declared_by, c.view_id, c.title, c.renderer
  FROM candidates c
  ORDER BY c.start_id, c.depth, c.weight DESC, c.view_id, c.declared_by
)
SELECT r.req_id, b.view_id, b.title, b.renderer, b.declared_by
FROM resolved r
LEFT JOIN best b ON b.start_id = r.canonical_id
`;
}

type RawResolvedRow = {
  req_id: string;
  view_id: string | null;
  title: string | null;
  renderer: string | null;
  declared_by: string | null;
};

/**
 * The effective default view of each id, in input order, in one round
 * trip (node-views spec, "A node's effective view is inherited along
 * child_of"). Throws `InvalidLookupIdError` for an empty array, more than
 * `MAX_RESOLVE_IDS` ids, or a malformed id, before any SQL runs; an id that
 * names no node simply answers null. See the module header for the walk.
 */
export async function resolveDefaultViews(db: Database, ids: readonly string[]): Promise<ResolvedDefaultView[]> {
  const validated = validateIds(ids);

  let result: { rows: RawResolvedRow[] };
  try {
    result = await db.execute<RawResolvedRow>(buildResolveDefaultViewsQuery(validated));
  } catch (err) {
    throw new LookupFailedError(`resolveDefaultViews query failed${formatPgInfo(asPgError(err))}`, "resolveDefaultViews", { cause: err });
  }

  // Keyed case-insensitively: Postgres renders a uuid in lowercase whatever
  // case the caller sent.
  const byId = new Map(result.rows.map((row) => [row.req_id.toLowerCase(), row]));
  return validated.map((nodeId) => {
    const row = byId.get(nodeId.toLowerCase());
    if (!row || row.view_id === null || row.title === null) {
      return { nodeId, view: null, declaredBy: null };
    }
    return {
      nodeId,
      view: { id: row.view_id, title: row.title, renderer: isViewRenderer(row.renderer) ? row.renderer : null },
      declaredBy: row.declared_by,
    };
  });
}
