// The work board read (live-beads-board change; work-board spec): every work
// item of the selected projects with its board column, nearest epic, and open
// blockers, in ONE SQL statement (design decision 4). No content comes back —
// the board draws titles and badges; a card opens the graph for the rest.
//
// The statement, in CTE order:
//
//   items        canonical `work_item` nodes (via resolved_nodes) whose
//                metadata contains {"project": k} for a selected key, or that
//                carry any `project` when none is named; served by
//                nodes_metadata_gin_idx. Capped at MAX_BOARD_ITEMS (newest
//                first); one extra row is read to set `truncated`.
//   blocks,
//   open_blocks,
//   reach,
//   cycle_members,
//   blocked_by   the readiness query's own CTEs, spliced from
//                `buildBlockingCtes` so the board and `getWorkItemReadiness`
//                can never disagree about what blocks. Store-wide: a blocker
//                in another project, or one that is not a work item, counts.
//   alias,
//   ancestors    a recursive child_of walk seeded from the non-epic items (a
//                subquery, not an id array, so resolveDefaultViews's
//                200-id cap does not apply) copying resolveDefaultViews's
//                shape (views.ts): alias probe ids so an edge asserted on a
//                merged-away duplicate is found by the same indexed probe,
//                endpoints folded through `merged_into`, a self-loop guard
//                (`<>`), and the MAX_RESOLVE_DEPTH cap — which is what ends a
//                child_of cycle (there is no acyclicity trigger on
//                child_of), never the statement timeout.
//   nearest_epic DISTINCT ON (start_id) over ancestors at depth >= 1 that
//                are work items of issue type `epic`, nearest first, lesser
//                node id on a tie. Depth 0 is excluded: an item is never in
//                its own lane. A cycle yields the nearest epic reached before
//                the depth cap, or none ("No epic").
//   cards        the column CASE and the per-project closed rank.
//
// Epics head lanes and are not cards: items whose issue_type is `epic` are
// left out of `cards` and returned in `epics` (with any epic a card's lane
// names that the project filter did not select, e.g. a cross-project
// parent), so a lane with no cards still has a header.
//
// Column rules (work-board spec): closed -> Closed; deferred -> Deferred;
// in_progress -> In progress, flagged blocked when it has an open blocker or
// is in a blocking cycle; blocked -> Blocked; anything else is read as open
// (the readiness query's rule for an unknown status) and is Blocked with an
// open blocker or a cycle membership, else Ready. `blockedFlag` is set for
// every card in Blocked, and for an In progress card with an open blocker or
// a cycle; it is never set for Closed or Deferred. A closed card names no
// blockers.
//
// Closed cards are ranked per project by `closed_at` descending, text order
// (the stored form is an ISO-8601 instant; casting it would let one
// malformed value fail the whole board), a missing `closed_at` last, then
// most recently updated, then id. The first CLOSED_PER_PROJECT are kept; the
// rest are counted into `omittedClosed[project]` (only projects that omitted
// something appear). The closed cap is applied after the 3,000-item cap.

import { sql, type SQL } from "drizzle-orm";
import type { Database } from "@breakdown/db";
import { InvalidLookupOptionError, LookupFailedError } from "./errors.js";
import { asPgError, formatPgInfo, sqlArray } from "./sql-helpers.js";
import { MAX_RESOLVE_DEPTH } from "./views.js";
import {
  buildBlockingCtes,
  CHILD_OF_EDGE_TYPE,
  DEFAULT_WORK_ITEM_PRIORITY,
  PROJECT_KEY_PATTERN,
  WORK_ITEM_NODE_TYPE,
} from "./work-items.js";

export const BOARD_COLUMNS = ["ready", "blocked", "in_progress", "deferred", "closed"] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];

/** Items read for one board; the answer says `truncated` when the store held more. */
export const MAX_BOARD_ITEMS = 3000;
/** Closed cards shown per project; the rest are counted, not listed. */
export const CLOSED_PER_PROJECT = 25;
/** Project keys one board read may name. */
export const MAX_BOARD_PROJECTS = 20;
/** The node type that registers a beads checkout under a project key (beads-ingest.ts). */
const BEADS_PROJECT_NODE_TYPE = "beads_project";

export interface WorkBoardOptions {
  /** Project keys to read. Absent or empty reads every project. */
  projects?: readonly string[];
}

export interface BoardCard {
  id: string;
  externalId: string;
  title: string;
  project: string;
  status: string;
  priority: number;
  issueType: string | null;
  assignee: string | null;
  column: BoardColumn;
  /** Canonical id of the nearest epic ancestor; null reads as the "No epic" lane. */
  epicId: string | null;
  /** Canonical ids of the sources of `blocks` edges into this card that are not closed work items. Empty for a closed card. */
  openBlockerIds: string[];
  blockedFlag: boolean;
  updatedAt: Date;
  closedAt: string | null;
}

export interface BoardEpic {
  id: string;
  title: string;
  status: string;
  project: string | null;
}

export interface WorkBoard {
  /** Ordered by priority (most urgent first), then most recently updated. */
  cards: BoardCard[];
  epics: BoardEpic[];
  /** Closed items not shown, per project; projects that omitted none are absent. */
  omittedClosed: Record<string, number>;
  /** True when the store held more than MAX_BOARD_ITEMS matching items. */
  truncated: boolean;
}

export interface BeadsProject {
  /** The project key (node `metadata.project`). */
  key: string;
  /** Absolute path of the registered checkout. */
  path: string;
  /** Canonical id of the registry node. */
  nodeId: string;
  /** When the registry node was last written. */
  updatedAt: Date;
}

function resolveBoardProjects(options: WorkBoardOptions): string[] | null {
  const projects = options.projects;
  if (projects === undefined || projects === null) return null;
  if (!Array.isArray(projects)) {
    throw new InvalidLookupOptionError("projects", projects, "must be an array of project keys");
  }
  if (projects.length === 0) return null;
  if (projects.length > MAX_BOARD_PROJECTS) {
    throw new InvalidLookupOptionError("projects", projects.length, `must name at most ${MAX_BOARD_PROJECTS} projects`);
  }
  for (const p of projects) {
    if (typeof p !== "string" || !PROJECT_KEY_PATTERN.test(p)) {
      throw new InvalidLookupOptionError("projects", p, `each project key must match ${PROJECT_KEY_PATTERN}`);
    }
  }
  return [...new Set(projects)];
}

/** Pure: builds the board statement from already-validated project keys (null = every project). */
export function buildWorkBoardQuery(projects: readonly string[] | null): SQL {
  const projectFilter =
    projects === null
      ? sql`metadata ? 'project'`
      : sql`metadata @> ANY (${sqlArray(
          projects.map((k) => JSON.stringify({ project: k })),
          "jsonb",
        )})`;
  return sql`
WITH RECURSIVE
items_raw AS (
  SELECT id, title, external_id, updated_at, metadata,
         -- A work item written without a status key reads as open (readWorkItemFields).
         COALESCE(metadata->>'status', 'open') AS status,
         CASE WHEN jsonb_typeof(metadata->'priority') = 'number'
              THEN (metadata->>'priority')::int
              ELSE ${DEFAULT_WORK_ITEM_PRIORITY}::int END AS priority,
         metadata->>'project' AS project,
         metadata->>'issue_type' AS issue_type,
         metadata->>'assignee' AS assignee,
         metadata->>'closed_at' AS closed_at
  FROM resolved_nodes
  WHERE node_type = ${WORK_ITEM_NODE_TYPE}
    AND ${projectFilter}
  ORDER BY updated_at DESC, id
  LIMIT ${MAX_BOARD_ITEMS + 1}::int
),
items AS (
  SELECT * FROM items_raw ORDER BY updated_at DESC, id LIMIT ${MAX_BOARD_ITEMS}::int
),
${buildBlockingCtes()},
-- Every merged-away node grouped by its survivor (views.ts's alias CTE).
alias AS (
  SELECT merged_into AS canonical_id, array_agg(id ORDER BY id) AS alias_ids
  FROM nodes WHERE merged_into IS NOT NULL GROUP BY merged_into
),
-- Upward child_of walk from every non-epic item. UNION, not UNION ALL; the
-- depth cap ends a cycle and the <> guard drops merge-induced self-loops
-- (see the module header).
ancestors(start_id, node_id, depth, probe_ids) AS (
  SELECT s.id, s.id, 0, ARRAY[s.id] || COALESCE(a.alias_ids, ARRAY[]::uuid[])
  FROM (SELECT id FROM items WHERE issue_type IS DISTINCT FROM 'epic') s
  LEFT JOIN alias a ON a.canonical_id = s.id
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
nearest_epic AS (
  SELECT DISTINCT ON (anc.start_id) anc.start_id, anc.node_id AS epic_id
  FROM ancestors anc
  JOIN resolved_nodes n ON n.id = anc.node_id
  WHERE anc.depth >= 1
    AND n.node_type = ${WORK_ITEM_NODE_TYPE}
    AND n.metadata->>'issue_type' = 'epic'
  ORDER BY anc.start_id, anc.depth, anc.node_id
),
classified AS (
  SELECT i.*,
         ne.epic_id,
         COALESCE(bb.open_blocker_ids, ARRAY[]::uuid[]) AS open_blocker_ids,
         (bb.id IS NOT NULL OR cm.id IS NOT NULL) AS obstructed,
         CASE
           WHEN i.status = 'closed' THEN 'closed'
           WHEN i.status = 'deferred' THEN 'deferred'
           WHEN i.status = 'in_progress' THEN 'in_progress'
           WHEN i.status = 'blocked' THEN 'blocked'
           WHEN bb.id IS NOT NULL OR cm.id IS NOT NULL THEN 'blocked'
           ELSE 'ready'
         END AS board_column
  FROM items i
  LEFT JOIN nearest_epic ne ON ne.start_id = i.id
  LEFT JOIN blocked_by bb ON bb.id = i.id
  LEFT JOIN cycle_members cm ON cm.id = i.id
  WHERE i.issue_type IS DISTINCT FROM 'epic'
),
ranked AS (
  SELECT c.*,
         CASE WHEN c.board_column = 'closed'
              THEN row_number() OVER (
                     PARTITION BY c.project
                     ORDER BY c.closed_at DESC NULLS LAST, c.updated_at DESC, c.id DESC)
              END AS closed_rank
  FROM classified c
),
kept AS (
  SELECT * FROM ranked WHERE closed_rank IS NULL OR closed_rank <= ${CLOSED_PER_PROJECT}::int
),
lane_epics AS (
  SELECT e.id, e.title, e.status, e.project
  FROM items e WHERE e.issue_type = 'epic'
  UNION
  SELECT n.id, n.title, COALESCE(n.metadata->>'status', 'open'), n.metadata->>'project'
  FROM resolved_nodes n
  WHERE n.id IN (SELECT epic_id FROM kept WHERE epic_id IS NOT NULL)
)
SELECT jsonb_build_object(
  'cards', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', k.id, 'external_id', k.external_id, 'title', k.title, 'project', k.project,
      'status', k.status, 'priority', k.priority, 'issue_type', k.issue_type,
      'assignee', k.assignee, 'column', k.board_column, 'epic_id', k.epic_id,
      'open_blocker_ids', to_jsonb(CASE WHEN k.board_column = 'closed' THEN ARRAY[]::uuid[] ELSE k.open_blocker_ids END),
      'blocked_flag', (k.board_column = 'blocked'
                       OR (k.board_column = 'in_progress' AND k.obstructed)),
      'updated_at', k.updated_at, 'closed_at', k.closed_at
    ) ORDER BY k.priority ASC, k.updated_at DESC, k.id DESC)
    FROM kept k
  ), '[]'::jsonb),
  'epics', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', le.id, 'title', le.title, 'status', le.status, 'project', le.project
    ) ORDER BY le.project NULLS LAST, le.title, le.id)
    FROM lane_epics le
  ), '[]'::jsonb),
  'omitted_closed', COALESCE((
    SELECT jsonb_object_agg(o.project, o.omitted)
    FROM (
      SELECT r.project, count(*) - ${CLOSED_PER_PROJECT}::int AS omitted
      FROM ranked r WHERE r.board_column = 'closed'
      GROUP BY r.project HAVING count(*) > ${CLOSED_PER_PROJECT}::int
    ) o
  ), '{}'::jsonb),
  'truncated', (SELECT count(*) FROM items_raw) > ${MAX_BOARD_ITEMS}::int
) AS result
`;
}

type RawCard = {
  id: string;
  external_id: string;
  title: string;
  project: string;
  status: string;
  priority: number;
  issue_type: string | null;
  assignee: string | null;
  column: BoardColumn;
  epic_id: string | null;
  open_blocker_ids: string[];
  blocked_flag: boolean;
  updated_at: string;
  closed_at: string | null;
};
type RawBoard = {
  cards: RawCard[];
  epics: BoardEpic[];
  omitted_closed: Record<string, number>;
  truncated: boolean;
};

/**
 * The board for the selected projects (work-board spec; module header). One
 * statement, one round trip. Throws `InvalidLookupOptionError` for a
 * malformed project list and `LookupFailedError` for a database failure.
 */
export async function getWorkBoard(db: Database, options: WorkBoardOptions = {}): Promise<WorkBoard> {
  const projects = resolveBoardProjects(options);
  let result: { rows: { result: RawBoard }[] };
  try {
    result = await db.execute<{ result: RawBoard }>(buildWorkBoardQuery(projects));
  } catch (err) {
    throw new LookupFailedError(`getWorkBoard query failed${formatPgInfo(asPgError(err))}`, "getWorkBoard", { cause: err });
  }
  const row = result.rows[0];
  if (!row) {
    throw new LookupFailedError("getWorkBoard query returned no row", "getWorkBoard");
  }
  const raw = row.result;
  return {
    cards: raw.cards.map((c) => ({
      id: c.id,
      externalId: c.external_id,
      title: c.title,
      project: c.project,
      status: c.status,
      priority: c.priority,
      issueType: c.issue_type,
      assignee: c.assignee,
      column: c.column,
      epicId: c.epic_id,
      openBlockerIds: c.open_blocker_ids,
      blockedFlag: c.blocked_flag,
      updatedAt: new Date(c.updated_at),
      closedAt: c.closed_at,
    })),
    epics: raw.epics,
    omittedClosed: raw.omitted_closed,
    truncated: raw.truncated,
  };
}

type RawProjectRow = { id: string; project: string | null; path: string | null; updated_at: string };

/**
 * Every registered beads project (the `beads_project` registry nodes
 * beads-ingest.ts writes), by key. A registry node missing its key or path
 * (hand-written) is skipped rather than guessed at.
 */
export async function listBeadsProjects(db: Database): Promise<BeadsProject[]> {
  let result: { rows: RawProjectRow[] };
  try {
    result = await db.execute<RawProjectRow>(sql`
      SELECT id, metadata->>'project' AS project, metadata->>'path' AS path, updated_at
      FROM resolved_nodes
      WHERE node_type = ${BEADS_PROJECT_NODE_TYPE} AND source_system = 'beads'
      ORDER BY metadata->>'project', id
    `);
  } catch (err) {
    throw new LookupFailedError(`listBeadsProjects query failed${formatPgInfo(asPgError(err))}`, "listBeadsProjects", { cause: err });
  }
  return result.rows
    .filter((r): r is RawProjectRow & { project: string; path: string } => r.project !== null && r.path !== null)
    .map((r) => ({ key: r.project, path: r.path, nodeId: r.id, updatedAt: new Date(r.updated_at) }));
}
