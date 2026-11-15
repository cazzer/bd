// The roadmap read (roadmap-milestones change; local-web-api spec, "Roadmap
// read"; work-roadmap spec, "Progress rolls up from items to epics to
// milestones"): every milestone and epic of the selected projects with its
// planning dates and progress rolled up from its items, in ONE SQL statement
// (design.md decision 2). No content comes back, and nothing is written.
//
// The statement, in CTE order:
//
//   registered   the board's registry CTE (board.ts), for the all-projects
//                read.
//   filtered     canonical `work_item` rows (resolved_nodes) of the selected
//                projects, selected by the board's own containment
//                (`projectContainmentArray`), with status (missing reads as
//                open) and the planning dates read off metadata.
//   leaves       filtered rows that are neither epics nor milestones: the
//                items progress counts. Counted, never returned.
//   heads_raw,
//   heads        the milestones and epics the answer draws, ordered
//                milestones first, then not-closed before closed, then most
//                recently updated, then id, and cut at the cap + 1 so
//                `truncated` can be read off it (the board's pattern). The
//                cap (MAX_ROADMAP_ROWS) bounds rows returned; leaves are not
//                capped, as the board does not cap its walk seed.
//   alias,
//   ancestors    the board's upward child_of walk (`buildAncestorWalkCte`:
//                alias probe, merged_into fold, self-loop guard,
//                MAX_RESOLVE_DEPTH cap), seeded once from every leaf and
//                every epic head, so the board and the roadmap cannot
//                disagree about ancestry.
//   item_epic    per leaf, EVERY epic ancestor (nested epics each count the
//                item) that is not past a milestone (`notPastMilestoneCondition`,
//                the board's boundary rule): a milestone bounds epic lookup,
//                so an item placed under a milestone that itself sits under
//                an epic is not counted by that epic. The board's nearest
//                epic for a card is therefore always one of its item_epic
//                rows. Epics of any project count here, as on the board, so
//                "outside epics" below agrees with the board's "No epic".
//   nearest_milestone  per leaf and per epic head, the nearest milestone
//                ancestor (DISTINCT ON, nearest first, lesser id on a tie —
//                the board's `nearest_epic` rule). An item belongs to at
//                most one milestone, so none is counted twice.
//   epic_progress,
//   milestone_progress  `count(DISTINCT leaf)` per status group; the
//                DISTINCT is what makes a child_of cycle count an item once.
//                An epic also gets `min(started_at)` over its counted items,
//                so its bar can start when the first item was claimed. A
//                milestone also gets `unepicked`: the same counts over its
//                items that belong to no epic.
//
// Status groups (design.md decision 3): closed; in_progress; deferred;
// everything else (open, blocked, unknown, missing) is open. The share —
// closed / (total − deferred) — is the reader's to compute; an empty
// denominator has no share.
//
// Dates (`due_at`, `started_at`, `closed_at`) are compared and min()-ed as
// text: the work-item contract stores them in the fixed-width
// `toISOString()` form (event-time.ts), where text order is time order. A
// stored value not in that exact form (a row written before the contract)
// reads as null rather than being cast, so one malformed row never fails
// the whole read.
//
// Cross-project parents: only the selected projects' items are leaves, and
// only their milestones and epics are heads. An epic's items in a project
// that is not selected are not counted under it.

import { sql, type SQL } from "drizzle-orm";
import type { Database } from "@breakdown/db";
import {
  ancestorAliasCte,
  buildAncestorWalkCte,
  notPastMilestoneCondition,
  projectContainmentArray,
  registeredProjectsCte,
  resolveBoardProjects,
} from "./board.js";
import { InvalidLookupOptionError, LookupFailedError } from "./errors.js";
import { asPgError, formatPgInfo } from "./sql-helpers.js";
import { WORK_ITEM_NODE_TYPE } from "./work-items.js";

/** Milestones plus epics one roadmap read returns; the answer says `truncated` when the store held more. */
export const MAX_ROADMAP_ROWS = 500;

/** The canonical stored instant (event-time.ts): anything else reads as absent. */
const CANONICAL_INSTANT_PATTERN = "^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z$";

export interface RoadmapOptions {
  /** Project keys to read, validated as the board validates them. Absent reads every registered project; an empty array reads none. */
  projects?: readonly string[];
  /** Internal, for tests: the row cap, 1..MAX_ROADMAP_ROWS. Never exposed over the API. */
  maxRows?: number;
}

/** Counts of contained non-epic, non-milestone items by status group, each item once. */
export interface RoadmapProgress {
  total: number;
  closed: number;
  inProgress: number;
  deferred: number;
  /** Every status that is not closed, in_progress, or deferred. */
  open: number;
}

export interface RoadmapMilestone {
  id: string;
  externalId: string;
  title: string;
  status: string;
  project: string;
  /** Canonical instant, or null when absent or not in the canonical form. */
  dueAt: string | null;
  /** Every item whose nearest milestone this is, through an epic or directly. */
  progress: RoadmapProgress;
  /** The subset of `progress`'s items that belong to no epic. */
  unepicked: RoadmapProgress;
}

export interface RoadmapEpic {
  id: string;
  externalId: string;
  title: string;
  status: string;
  project: string;
  /** Canonical id of the epic's nearest milestone ancestor; null when it has none. */
  milestoneId: string | null;
  dueAt: string | null;
  startedAt: string | null;
  closedAt: string | null;
  /** The earliest `startedAt` among the items `progress` counts; null when none has one. */
  firstStartedAt: string | null;
  /** Every item with this epic among its ancestors, nested epics' items included. */
  progress: RoadmapProgress;
}

export interface Roadmap {
  /** Ordered by project, then due (undated last), then title, then id. */
  milestones: RoadmapMilestone[];
  /** Ordered by project, then title, then id. */
  epics: RoadmapEpic[];
  /** True when the store held more than the cap's milestones and epics. */
  truncated: boolean;
}

const EMPTY_PROGRESS_JSON = JSON.stringify({ total: 0, closed: 0, inProgress: 0, deferred: 0, open: 0 } satisfies RoadmapProgress);

/** A metadata date read only in its canonical form (module header). `key` is a fixed literal, never input. */
function canonicalDate(key: "due_at" | "started_at" | "closed_at"): SQL {
  const field = sql.raw(`metadata->>'${key}'`);
  return sql`CASE WHEN ${field} ~ ${CANONICAL_INSTANT_PATTERN}::text THEN ${field} END`;
}

/** The progress object over leaf alias `l`, restricted by `scope` (a boolean expression). */
function progressJson(scope: SQL = sql`true`): SQL {
  const count = (group: SQL) => sql`count(DISTINCT l.id) FILTER (WHERE ${scope} AND ${group})`;
  return sql`jsonb_build_object(
    'total', ${count(sql`true`)},
    'closed', ${count(sql`l.status = 'closed'`)},
    'inProgress', ${count(sql`l.status = 'in_progress'`)},
    'deferred', ${count(sql`l.status = 'deferred'`)},
    'open', ${count(sql`l.status NOT IN ('closed', 'in_progress', 'deferred')`)}
  )`;
}

/** Pure: builds the roadmap statement from already-validated project keys (null = every registered project; non-empty otherwise) and a validated row cap. */
export function buildRoadmapQuery(projects: readonly string[] | null, maxRows: number = MAX_ROADMAP_ROWS): SQL {
  const headOrder = sql`(issue_type = 'milestone') DESC, (status = 'closed'), updated_at DESC, id`;
  return sql`
WITH RECURSIVE
${registeredProjectsCte()},
filtered AS (
  SELECT id, external_id, title, updated_at,
         COALESCE(metadata->>'status', 'open') AS status,
         metadata->>'project' AS project,
         metadata->>'issue_type' AS issue_type,
         ${canonicalDate("due_at")} AS due_at,
         ${canonicalDate("started_at")} AS started_at,
         ${canonicalDate("closed_at")} AS closed_at
  FROM resolved_nodes
  WHERE node_type = ${WORK_ITEM_NODE_TYPE}
    AND metadata @> ANY (${projectContainmentArray(projects)})
),
leaves AS (
  SELECT id, status, started_at
  FROM filtered
  WHERE issue_type IS DISTINCT FROM 'epic' AND issue_type IS DISTINCT FROM 'milestone'
),
heads_raw AS (
  SELECT * FROM filtered
  WHERE issue_type IN ('epic', 'milestone')
  ORDER BY ${headOrder}
  LIMIT ${maxRows + 1}::int
),
heads AS (
  SELECT * FROM heads_raw ORDER BY ${headOrder} LIMIT ${maxRows}::int
),
${ancestorAliasCte()},
${buildAncestorWalkCte("ancestors", sql`SELECT id FROM leaves UNION ALL SELECT id FROM heads WHERE issue_type = 'epic'`)},
item_epic AS (
  SELECT DISTINCT anc.start_id AS item_id, anc.node_id AS epic_id
  FROM ancestors anc
  JOIN leaves l ON l.id = anc.start_id
  JOIN resolved_nodes n ON n.id = anc.node_id
  WHERE anc.depth >= 1
    AND n.node_type = ${WORK_ITEM_NODE_TYPE}
    AND n.metadata->>'issue_type' = 'epic'
    AND ${notPastMilestoneCondition("ancestors", "anc")}
),
nearest_milestone AS (
  SELECT DISTINCT ON (anc.start_id) anc.start_id, anc.node_id AS milestone_id
  FROM ancestors anc
  JOIN resolved_nodes n ON n.id = anc.node_id
  WHERE anc.depth >= 1
    AND n.node_type = ${WORK_ITEM_NODE_TYPE}
    AND n.metadata->>'issue_type' = 'milestone'
  ORDER BY anc.start_id, anc.depth, anc.node_id
),
epic_progress AS (
  SELECT ie.epic_id, ${progressJson()} AS progress, min(l.started_at) AS first_started_at
  FROM item_epic ie
  JOIN leaves l ON l.id = ie.item_id
  WHERE ie.epic_id IN (SELECT id FROM heads)
  GROUP BY ie.epic_id
),
epicked AS (
  SELECT DISTINCT item_id FROM item_epic
),
milestone_progress AS (
  SELECT nm.milestone_id, ${progressJson()} AS progress, ${progressJson(sql`ep.item_id IS NULL`)} AS unepicked
  FROM nearest_milestone nm
  JOIN leaves l ON l.id = nm.start_id
  LEFT JOIN epicked ep ON ep.item_id = l.id
  WHERE nm.milestone_id IN (SELECT id FROM heads)
  GROUP BY nm.milestone_id
)
SELECT jsonb_build_object(
  'milestones', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', h.id, 'externalId', h.external_id, 'title', h.title, 'status', h.status,
      'project', h.project, 'dueAt', h.due_at,
      'progress', COALESCE(mp.progress, ${EMPTY_PROGRESS_JSON}::jsonb),
      'unepicked', COALESCE(mp.unepicked, ${EMPTY_PROGRESS_JSON}::jsonb)
    ) ORDER BY h.project, h.due_at NULLS LAST, h.title, h.id)
    FROM heads h
    LEFT JOIN milestone_progress mp ON mp.milestone_id = h.id
    WHERE h.issue_type = 'milestone'
  ), '[]'::jsonb),
  'epics', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', h.id, 'externalId', h.external_id, 'title', h.title, 'status', h.status,
      'project', h.project, 'milestoneId', nm.milestone_id,
      'dueAt', h.due_at, 'startedAt', h.started_at, 'closedAt', h.closed_at,
      'firstStartedAt', ep.first_started_at,
      'progress', COALESCE(ep.progress, ${EMPTY_PROGRESS_JSON}::jsonb)
    ) ORDER BY h.project, h.title, h.id)
    FROM heads h
    LEFT JOIN nearest_milestone nm ON nm.start_id = h.id
    LEFT JOIN epic_progress ep ON ep.epic_id = h.id
    WHERE h.issue_type = 'epic'
  ), '[]'::jsonb),
  'truncated', (SELECT count(*) FROM heads_raw) > ${maxRows}::int
) AS result
`;
}

/**
 * The roadmap for the selected projects (module header). One statement, one
 * round trip, no writes. Throws `InvalidLookupOptionError` for a malformed
 * project list (naming `projects`, as the board does) or row cap, and
 * `LookupFailedError` for a database failure.
 */
export async function getRoadmap(db: Database, options: RoadmapOptions = {}): Promise<Roadmap> {
  const projects = resolveBoardProjects(options);
  const maxRows = options.maxRows ?? MAX_ROADMAP_ROWS;
  if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > MAX_ROADMAP_ROWS) {
    throw new InvalidLookupOptionError("maxRows", maxRows, `must be an integer from 1 to ${MAX_ROADMAP_ROWS}`);
  }
  if (projects !== null && projects.length === 0) {
    return { milestones: [], epics: [], truncated: false };
  }
  let result: { rows: { result: Roadmap }[] };
  try {
    result = await db.execute<{ result: Roadmap }>(buildRoadmapQuery(projects, maxRows));
  } catch (err) {
    throw new LookupFailedError(`getRoadmap query failed${formatPgInfo(asPgError(err))}`, "getRoadmap", { cause: err });
  }
  const row = result.rows[0];
  if (!row) {
    throw new LookupFailedError("getRoadmap query returned no row", "getRoadmap");
  }
  return row.result;
}
