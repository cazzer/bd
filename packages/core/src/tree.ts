// Bounded subtree read (code-view change, design.md decision 1; code-view
// spec, "A subtree can be read in one request"): everything reachable from
// one root downward along `child_of`, each node with its parent, in one
// statement, without any node's content. The code view draws a repository
// tree from this — the loader (git-repo.ts) writes exactly one `child_of`
// per non-root node, so the answer for a `repo` node is the whole checkout
// as loaded — and a deep link's ancestors are computed client-side from
// `parentId`, which is why no second procedure exists.
//
// The walk is views.ts's ancestor CTE turned around. The requested id
// folds through `merged_into` (a merged-away root answers its survivor's
// subtree); every walk row carries `probe_ids` — the canonical id plus
// every merged-away alias of it, retrieval.ts's alias pattern — so
// `e.dst_id = ANY (probe_ids)` finds an edge asserted on a duplicate of a
// directory in the same indexed probe (`edges_dst_id_edge_type_idx`) that
// finds the survivor's own; and the far endpoint folds through
// `COALESCE(src.merged_into, src.id)`, so a merged-away child is reported
// as its survivor and the loser never appears. That is what "both endpoints
// folded" means here: the design's `COALESCE(dst.merged_into, e.dst_id) =
// node_id` and this probe select the same edges, but the probe is served
// by the index and the expression is not.
//
// Two bounds, one flag. The recursion is `UNION` (a node reached by two
// paths at one depth under one parent is one row) with `depth <
// MAX_SUBTREE_DEPTH` as the terminator: as views.ts's header spells out,
// `depth` is a column of the walk, so on a `child_of` cycle a node is
// re-emitted at each greater depth and it is the cap, not set semantics,
// that ends the walk (at most MAX_SUBTREE_DEPTH + 1 rows per cycle
// member). A path tree cannot cycle, but `brain_link` writes `child_of`
// freely, so the guard is not optional. Then `DISTINCT ON (node_id)`
// places each node once, at its least depth (a node with two parents, or
// one inside a cycle, is shown where it is nearest the root), the result
// is ordered `depth, title, node_id`, and `LIMIT max_nodes + 1` over that
// order answers `truncated` without a count: the bound's worth of
// shallowest rows is what a cut-short answer keeps, and because every
// depth < d is emitted before any row at depth d, a kept node's parent is
// always kept too. Merge-induced self-loops (a loser's `child_of` to its
// own survivor) are dropped for the reason views.ts and work-items.ts
// drop them: "a node is a child of itself" is not containment.
//
// Not budgeted by response size (the router skips `boundResponse`): a row
// is seven short fields, so MAX_SUBTREE_NODES rows is well under the 2 MB
// budget the other procedures apply, and dropping rows from the tail of a
// tree would be a second, silent truncation on top of the honest one.

import { sql, type SQL } from "drizzle-orm";
import type { Database } from "@breakdown/db";
import { InvalidLookupIdError, InvalidLookupOptionError, LookupFailedError, NodeNotFoundError } from "./errors.js";
import { asPgError, formatPgInfo } from "./sql-helpers.js";
import { CHILD_OF_EDGE_TYPE } from "./work-items.js";

/** Most nodes one `getSubtree` call returns (the root included). A subtree with more answers `truncated: true` with the shallowest ones. */
export const MAX_SUBTREE_NODES = 5000;
/** How many `child_of` hops down the walk goes; also what terminates a cycle. A node further from the root than this is not returned. */
export const MAX_SUBTREE_DEPTH = 32;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One placed node of a subtree. Never content: the tree is structure, and the file pane reads content by `getNodes`. */
export interface SubtreeNode {
  /** Canonical id — a merged-away node is reported as its survivor. */
  id: string;
  /** Canonical id of the parent this node is placed under; `null` for the root row only. */
  parentId: string | null;
  nodeType: string;
  title: string;
  externalId: string;
  /** `metadata.path` as text when present (the loader's repository-relative path), else `null`. */
  path: string | null;
  /** `metadata.language` as text when present (the loader's fixed language name), else `null`. */
  language: string | null;
}

export interface Subtree {
  /** The canonical id the requested root folded to — the one row whose `parentId` is `null`. */
  rootId: string;
  /** Shallowest first, then by title, then by id. The root is `nodes[0]`. */
  nodes: SubtreeNode[];
  /** True when the subtree has more than `maxNodes` nodes and the answer holds only the first `maxNodes` in order. */
  truncated: boolean;
}

export interface GetSubtreeOptions {
  /** Node bound, 1..MAX_SUBTREE_NODES. Default MAX_SUBTREE_NODES; the constant is the ceiling, this only lowers it. */
  maxNodes?: number;
  /** Depth bound, 0..MAX_SUBTREE_DEPTH. Default MAX_SUBTREE_DEPTH; likewise only lowers it. */
  maxDepth?: number;
}

interface ResolvedSubtreeOptions {
  maxNodes: number;
  maxDepth: number;
}

function resolveGetSubtreeOptions(options: GetSubtreeOptions): ResolvedSubtreeOptions {
  const maxNodes = options.maxNodes ?? MAX_SUBTREE_NODES;
  if (!Number.isInteger(maxNodes) || maxNodes < 1 || maxNodes > MAX_SUBTREE_NODES) {
    throw new InvalidLookupOptionError("maxNodes", options.maxNodes, `must be an integer between 1 and ${MAX_SUBTREE_NODES}`);
  }
  const maxDepth = options.maxDepth ?? MAX_SUBTREE_DEPTH;
  if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > MAX_SUBTREE_DEPTH) {
    throw new InvalidLookupOptionError("maxDepth", options.maxDepth, `must be an integer between 0 and ${MAX_SUBTREE_DEPTH}`);
  }
  return { maxNodes, maxDepth };
}

/**
 * Pure query builder — no database, so its SQL can be asserted on
 * directly, same convention as `buildGetNodesQuery`. `rootId` must already
 * be validated and `options` resolved (see `getSubtree`); the bounds are
 * parameters so a test can lower them (tasks.md 1.2) without a store of
 * MAX_SUBTREE_NODES rows. Returns at most `maxNodes + 1` rows — the extra
 * one is how `getSubtree` knows the answer was cut short. Zero rows means
 * the id names no node: the root row is unconditional otherwise. See the
 * module header for the walk, the fold, the placement, and the cycle guard.
 */
export function buildGetSubtreeQuery(rootId: string, options: ResolvedSubtreeOptions = { maxNodes: MAX_SUBTREE_NODES, maxDepth: MAX_SUBTREE_DEPTH }): SQL {
  return sql`
WITH RECURSIVE
-- The requested id folded onto its canonical node. Empty when the id names
-- nothing — then nothing below has a row either.
root AS (
  SELECT COALESCE(n.merged_into, n.id) AS canonical_id
  FROM nodes n
  WHERE n.id = ${rootId}::uuid
),
-- Every merged-away node grouped by its survivor (retrieval.ts's alias
-- CTE; one hop by the nodes_merged_into_canonical_trigger invariant).
-- probe_ids below is [canonical] || aliases, so \`dst_id = ANY(probe_ids)\`
-- finds an edge pointing at a merged-away duplicate of a node in the same
-- indexed probe that finds the survivor's own.
alias AS (
  SELECT merged_into AS canonical_id, array_agg(id ORDER BY id) AS alias_ids
  FROM nodes WHERE merged_into IS NOT NULL GROUP BY merged_into
),
-- Downward walk along child_of from the root. UNION, not UNION ALL: one
-- row per (node, parent, depth). The depth cap is what stops a cycle (see
-- the module header); the <> guard drops merge-induced self-loops.
descendants(node_id, parent_id, depth, probe_ids) AS (
  SELECT r.canonical_id, NULL::uuid, 0,
         ARRAY[r.canonical_id] || COALESCE(a.alias_ids, ARRAY[]::uuid[])
  FROM root r
  LEFT JOIN alias a ON a.canonical_id = r.canonical_id
  UNION
  SELECT c.canonical_id, d.node_id, d.depth + 1,
         ARRAY[c.canonical_id] || COALESCE(a.alias_ids, ARRAY[]::uuid[])
  FROM descendants d
  JOIN edges e ON e.dst_id = ANY (d.probe_ids) AND e.edge_type = ${CHILD_OF_EDGE_TYPE}
  JOIN nodes s ON s.id = e.src_id
  CROSS JOIN LATERAL (SELECT COALESCE(s.merged_into, s.id) AS canonical_id) c
  LEFT JOIN alias a ON a.canonical_id = c.canonical_id
  WHERE d.depth < ${options.maxDepth}::int
    AND c.canonical_id <> d.node_id
),
-- Each node once, at its least depth; among equal depths the lesser
-- parent id, so the placement is the same on every call (Postgres's sort
-- is not stable).
placed AS (
  SELECT DISTINCT ON (d.node_id) d.node_id, d.parent_id, d.depth
  FROM descendants d
  ORDER BY d.node_id, d.depth, d.parent_id
)
SELECT p.node_id AS id, p.parent_id, n.node_type, n.title, n.external_id,
       n.metadata->>'path' AS path, n.metadata->>'language' AS language
FROM placed p
JOIN resolved_nodes n ON n.id = p.node_id
ORDER BY p.depth, n.title, p.node_id
LIMIT ${options.maxNodes + 1}::int
`;
}

// A type alias, not an interface: `db.execute<T>` wants an index signature,
// which only the alias form gets implicitly (views.ts's RawResolvedRow).
type RawSubtreeRow = {
  id: string;
  parent_id: string | null;
  node_type: string;
  title: string;
  external_id: string;
  path: string | null;
  language: string | null;
};

function mapSubtreeRow(row: RawSubtreeRow): SubtreeNode {
  return {
    id: row.id,
    parentId: row.parent_id,
    nodeType: row.node_type,
    title: row.title,
    externalId: row.external_id,
    path: row.path,
    language: row.language,
  };
}

/**
 * The subtree under `rootId` (code-view spec, "A subtree can be read in
 * one request"): the root and every `child_of` descendant within the
 * bounds, each placed once under one parent, shallowest first then by
 * title, without content. Throws `InvalidLookupIdError` for a malformed id
 * and `InvalidLookupOptionError` for a bound outside its range, both
 * before any SQL runs; `NodeNotFoundError` when the id names no node
 * (directly or through a merge), the treatment `getNeighbors` gives a
 * single required id. A merged-away root answers its survivor's subtree
 * and reports the survivor as `rootId`.
 */
export async function getSubtree(db: Database, rootId: string, options: GetSubtreeOptions = {}): Promise<Subtree> {
  const trimmed = typeof rootId === "string" ? rootId.trim() : "";
  if (!UUID_RE.test(trimmed)) {
    throw new InvalidLookupIdError(rootId, "must be a valid uuid");
  }
  const resolved = resolveGetSubtreeOptions(options);

  let result: { rows: RawSubtreeRow[] };
  try {
    result = await db.execute<RawSubtreeRow>(buildGetSubtreeQuery(trimmed, resolved));
  } catch (err) {
    throw new LookupFailedError(`getSubtree query failed${formatPgInfo(asPgError(err))}`, "getSubtree", { cause: err });
  }

  const root = result.rows[0];
  if (!root) {
    throw new NodeNotFoundError(trimmed);
  }

  const truncated = result.rows.length > resolved.maxNodes;
  const rows = truncated ? result.rows.slice(0, resolved.maxNodes) : result.rows;
  return { rootId: root.id, nodes: rows.map(mapSubtreeRow), truncated };
}
