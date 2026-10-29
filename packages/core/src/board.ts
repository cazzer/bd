// The work board read (live-beads-board change; work-board spec): every work
// item of the selected projects with its board column, nearest epic, and open
// blockers, in ONE SQL statement (design decision 4). No content comes back —
// the board draws titles and badges; a card opens the graph for the rest.
//
// The statement, in CTE order:
//
//   registered   (no project named) the `beads_project` registry nodes' keys.
//   filtered     canonical `work_item` nodes (via resolved_nodes) whose
//                metadata contains {"project": k} for a named key, or for any
//                registered key when none is named — containment against an
//                array of single-key objects, which nodes_metadata_gin_idx
//                (jsonb_path_ops) serves; `metadata ? 'project'` is not
//                servable by that opclass and would seq-scan. A work item
//                whose project is not registered is not on the all-projects
//                board (work-board spec). Closed cards are ranked here, per
//                project, over the whole filtered set.
//   items_raw    every filtered row except closed cards past rank
//                CLOSED_PER_PROJECT, ordered open-work-first (non-closed rows
//                and epics, newest first, then kept closed rows) and cut at
//                the cap + 1 so `truncated` can be read off it. The cap trims
//                kept-closed rows before any non-closed row, so an old open
//                backlog never loses to recently closed rows.
//   items        the first `maxItems` of items_raw.
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
// (`readWorkItemFields`'s rule for a missing or unknown status) and is Blocked
// with an open blocker or a cycle membership, else Ready. `blockedFlag` is set for
// every card in Blocked, and for an In progress card with an open blocker or
// a cycle; it is never set for Closed or Deferred. A closed card names no
// blockers.
//
// Closed cards are ranked per project by `closed_at` descending, text order
// (the stored form is an ISO-8601 instant; casting it would let one
// malformed value fail the whole board), a missing `closed_at` last, then
// most recently updated, then id. The first CLOSED_PER_PROJECT are kept; the
// rest are counted into `omittedClosed[project]` (only projects that omitted
// something appear), exactly, because the rank runs over the full filtered
// set before the item cap. Closed epics are not cards and are not ranked.
//
// Priority is read as an integer 0-4 only when it is a JSON number whose text
// is a single digit in that range; anything else (2.5, 1e12, 7) reads as the
// default, like `readWorkItemFields` and the readiness query — a cast of
// arbitrary stored numbers would let one raw-written row fail the whole
// board. `cycle_members` is a subset of `blocked_by` (a cycle member has an
// open blocker), so the `OR` on cycle membership below is redundant; it is
// kept so the column rule reads as the spec states it.
//
// Reviews (board-visual-reviews, design.md decision 2): a card carries only
// `review` (labelled `review` exactly), so the board stays light. The drawer
// reads one item through `getBoardItem` — content, labels, the review
// object, and the comment thread. It finds the `nodes` row of that project
// with that external id and answers its canonical row, folded through
// `merged_into` the way lookup.ts folds (so the drawer opened on a bead id
// that was merged away shows the survivor rather than waiting forever). The
// survivor must belong to the same project too: a merge into another
// project's node, or a project-less one, answers null rather than a node
// labelled with a project it is not in. A
// row that is itself canonical wins over a merged-away one, then the
// `beads` row, then the lesser id. The stored review and comments are
// re-normalized on read (reviews.ts; both are idempotent), so a raw-written
// or pre-contract value is answered in the contract's shape, a malformed
// review as `{ invalid: true }`; neither is read off an item that is not a
// review.
//
// The drawer's header names the item's parent: one `child_of` hop from the
// item (or any id merged into it), the target folded through `merged_into`,
// kept only when it is a work item of the same project and not the item
// itself (a merge can make a self-loop). Several parents (two systems each
// asserted one) resolve to the heavier edge, then `beads`, then the lesser
// id, so the answer is stable.

import { sql, type SQL } from "drizzle-orm";
import type { Database } from "@breakdown/db";
import { InvalidLookupOptionError, LookupFailedError } from "./errors.js";
import {
  normalizeReviewComments,
  normalizeReviewMetadata,
  REVIEW_COMMENTS_KEY,
  REVIEW_LABEL,
  REVIEW_METADATA_KEY,
  type InvalidReview,
  type ReviewComment,
  type ReviewMetadata,
} from "./reviews.js";
import { asPgError, formatPgInfo, sqlArray } from "./sql-helpers.js";
import { MAX_RESOLVE_DEPTH } from "./views.js";
import {
  buildBlockingCtes,
  CHILD_OF_EDGE_TYPE,
  DEFAULT_WORK_ITEM_PRIORITY,
  PROJECT_KEY_PATTERN,
  readWorkItemFields,
  WORK_ITEM_NODE_TYPE,
} from "./work-items.js";

export const BOARD_COLUMNS = ["ready", "blocked", "in_progress", "deferred", "closed"] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];

/** Items read for one board (after the per-project closed cap); the answer says `truncated` when the store held more. */
export const MAX_BOARD_ITEMS = 3000;
/** Closed cards shown per project; the rest are counted, not listed. */
export const CLOSED_PER_PROJECT = 25;
/** Project keys one board read may name. */
export const MAX_BOARD_PROJECTS = 20;
/** The node type that registers a beads checkout under a project key (beads-ingest.ts). */
const BEADS_PROJECT_NODE_TYPE = "beads_project";

export interface WorkBoardOptions {
  /** Project keys to read. Absent reads every registered project; an empty array reads none and answers an empty board. */
  projects?: readonly string[];
  /** Internal, for tests: the item cap, 1..MAX_BOARD_ITEMS. Never exposed over the API. */
  maxItems?: number;
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
  /** Labelled `review` exactly (reviews.ts): the card opens a review in the drawer. */
  review: boolean;
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

/** Pure: builds the board statement from already-validated project keys (null = every registered project; non-empty otherwise) and a validated item cap. */
export function buildWorkBoardQuery(projects: readonly string[] | null, maxItems: number = MAX_BOARD_ITEMS): SQL {
  const projectKeys =
    projects === null
      ? sql`ARRAY(SELECT jsonb_build_object('project', r.key) FROM registered r)`
      : sqlArray(
          projects.map((k) => JSON.stringify({ project: k })),
          "jsonb",
        );
  return sql`
WITH RECURSIVE
registered(key) AS (
  SELECT metadata->>'project'
  FROM resolved_nodes
  WHERE node_type = ${BEADS_PROJECT_NODE_TYPE} AND source_system = 'beads' AND metadata->>'project' IS NOT NULL
),
filtered AS (
  SELECT id, title, external_id, updated_at,
         -- A work item written without a status key reads as open (readWorkItemFields).
         COALESCE(metadata->>'status', 'open') AS status,
         CASE WHEN jsonb_typeof(metadata->'priority') = 'number' AND metadata->>'priority' ~ '^[0-4]$'
              THEN (metadata->>'priority')::int
              ELSE ${DEFAULT_WORK_ITEM_PRIORITY}::int END AS priority,
         metadata->>'project' AS project,
         metadata->>'issue_type' AS issue_type,
         metadata->>'assignee' AS assignee,
         metadata->>'closed_at' AS closed_at,
         -- Label 'review' exactly (reviews.ts); non-array labels read as not a review.
         (jsonb_typeof(metadata->'labels') = 'array' AND metadata->'labels' @> '["review"]'::jsonb) IS TRUE AS review
  FROM resolved_nodes
  WHERE node_type = ${WORK_ITEM_NODE_TYPE}
    AND metadata @> ANY (${projectKeys})
),
filtered_ranked AS (
  SELECT f.*,
         (f.status = 'closed' AND f.issue_type IS DISTINCT FROM 'epic') AS closed_card,
         row_number() OVER (
           PARTITION BY f.project, (f.status = 'closed' AND f.issue_type IS DISTINCT FROM 'epic')
           ORDER BY f.closed_at DESC NULLS LAST, f.updated_at DESC, f.id DESC) AS closed_rank
  FROM filtered f
),
items_raw AS (
  SELECT id, title, external_id, updated_at, status, priority, project, issue_type, assignee, closed_at, review, closed_card
  FROM filtered_ranked
  WHERE NOT closed_card OR closed_rank <= ${CLOSED_PER_PROJECT}::int
  ORDER BY closed_card, updated_at DESC, id
  LIMIT ${maxItems + 1}::int
),
items AS (
  SELECT * FROM items_raw ORDER BY closed_card, updated_at DESC, id LIMIT ${maxItems}::int
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
lane_epics AS (
  SELECT e.id, e.title, e.status, e.project
  FROM items e
  WHERE e.issue_type = 'epic'
    -- A closed epic with no card in its lane would be an empty header.
    AND (e.status <> 'closed' OR e.id IN (SELECT epic_id FROM classified WHERE epic_id IS NOT NULL))
  UNION
  SELECT n.id, n.title, COALESCE(n.metadata->>'status', 'open'), n.metadata->>'project'
  FROM resolved_nodes n
  WHERE n.id IN (SELECT epic_id FROM classified WHERE epic_id IS NOT NULL)
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
      'updated_at', k.updated_at, 'closed_at', k.closed_at, 'review', k.review
    ) ORDER BY k.priority ASC, k.updated_at DESC, k.id DESC)
    FROM classified k
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
      FROM filtered_ranked r WHERE r.closed_card
      GROUP BY r.project HAVING count(*) > ${CLOSED_PER_PROJECT}::int
    ) o
  ), '{}'::jsonb),
  'truncated', (SELECT count(*) FROM items_raw) > ${maxItems}::int
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
  review: boolean;
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
  const maxItems = options.maxItems ?? MAX_BOARD_ITEMS;
  if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > MAX_BOARD_ITEMS) {
    throw new InvalidLookupOptionError("maxItems", maxItems, `must be an integer from 1 to ${MAX_BOARD_ITEMS}`);
  }
  // An explicit empty selection names nothing: an empty board, no query.
  if (projects !== null && projects.length === 0) {
    return { cards: [], epics: [], omittedClosed: {}, truncated: false };
  }
  let result: { rows: { result: RawBoard }[] };
  try {
    result = await db.execute<{ result: RawBoard }>(buildWorkBoardQuery(projects, maxItems));
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
      review: c.review,
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

/**
 * The registered checkout for `key`, trusted to run a command in: the
 * canonical `beads_project` row a beads ingest writes (`beads` source,
 * external id `project:<key>`, the key in its metadata) whose last writer —
 * its `ingest_run_id` — was itself a `beads` ingest run. A registry-shaped
 * node written or last touched by any other run (an agent's `brain_write`,
 * a merge under an agent run) is not a registration and answers null, as
 * does a missing key or path. Throws `InvalidLookupOptionError` for a
 * malformed key and `LookupFailedError` for a database failure.
 */
export async function getRegisteredBeadsProject(db: Database, key: string): Promise<BeadsProject | null> {
  if (typeof key !== "string" || !PROJECT_KEY_PATTERN.test(key)) {
    throw new InvalidLookupOptionError("project", key, `must match ${PROJECT_KEY_PATTERN}`);
  }
  let result: { rows: RawProjectRow[] };
  try {
    result = await db.execute<RawProjectRow>(sql`
      SELECT r.id, r.metadata->>'project' AS project, r.metadata->>'path' AS path, r.updated_at
      FROM resolved_nodes r
      JOIN ingest_runs ir ON ir.id = r.ingest_run_id
      WHERE r.node_type = ${BEADS_PROJECT_NODE_TYPE}
        AND r.source_system = 'beads'
        AND r.external_id = ${`project:${key}`}
        AND r.metadata->>'project' = ${key}
        AND ir.source_system = 'beads'
      LIMIT 1
    `);
  } catch (err) {
    throw new LookupFailedError(`getRegisteredBeadsProject query failed${formatPgInfo(asPgError(err))}`, "getRegisteredBeadsProject", { cause: err });
  }
  const r = result.rows[0];
  if (!r || r.project === null || r.path === null || r.path === "") return null;
  return { key: r.project, path: r.path, nodeId: r.id, updatedAt: new Date(r.updated_at) };
}

/** Longest external id `getBoardItem` accepts (the board address carries it). */
export const MAX_BOARD_ITEM_ID_LENGTH = 200;

export interface BoardItemOptions {
  project: string;
  /** The item's external id (a bead id). */
  externalId: string;
}

/** One work item as the board's drawer shows it (module header). */
export interface BoardItem {
  id: string;
  externalId: string;
  /** The row's source system; `beads` for an item a tracker loaded. */
  sourceSystem: string;
  project: string;
  title: string;
  content: string;
  status: string;
  priority: number;
  issueType: string | null;
  assignee: string | null;
  labels: string[];
  closedAt: string | null;
  closedReason: string | null;
  updatedAt: Date;
  isReview: boolean;
  /** A review item's review; null when the item is not a review or carries no review metadata. */
  review: ReviewMetadata | InvalidReview | null;
  /** Oldest first; empty when there are none. */
  comments: ReviewComment[];
  /** The item's `child_of` parent in the same project (module header); null when it has none. */
  parent: { externalId: string; title: string } | null;
}

type RawItemRow = {
  id: string;
  external_id: string;
  source_system: string;
  title: string;
  content: string;
  metadata: Record<string, unknown> | null;
  updated_at: string | Date;
  parent_external_id: string | null;
  parent_title: string | null;
};

/**
 * The canonical work item of `project` whose external id is `externalId`, or
 * null when there is none (module header). Throws `InvalidLookupOptionError`
 * for a malformed project key or id and `LookupFailedError` for a database
 * failure.
 */
export async function getBoardItem(db: Database, options: BoardItemOptions): Promise<BoardItem | null> {
  const { project, externalId } = options;
  if (typeof project !== "string" || !PROJECT_KEY_PATTERN.test(project)) {
    throw new InvalidLookupOptionError("project", project, `must match ${PROJECT_KEY_PATTERN}`);
  }
  if (typeof externalId !== "string" || externalId.length === 0 || externalId.length > MAX_BOARD_ITEM_ID_LENGTH) {
    throw new InvalidLookupOptionError("externalId", externalId, `must be a non-empty string of at most ${MAX_BOARD_ITEM_ID_LENGTH} characters`);
  }
  let result: { rows: RawItemRow[] };
  try {
    result = await db.execute<RawItemRow>(sql`
      WITH item AS (
        SELECT r.id, r.external_id, r.source_system, r.title, r.content, r.metadata, r.updated_at
        FROM nodes n
        JOIN resolved_nodes r ON r.id = COALESCE(n.merged_into, n.id)
        WHERE n.node_type = ${WORK_ITEM_NODE_TYPE}
          AND n.metadata @> ${JSON.stringify({ project })}::jsonb
          AND n.external_id = ${externalId}
          AND r.node_type = ${WORK_ITEM_NODE_TYPE}
          AND r.metadata @> ${JSON.stringify({ project })}::jsonb
        ORDER BY (n.merged_into IS NULL) DESC, (n.source_system = 'beads') DESC, n.id
        LIMIT 1
      )
      SELECT item.*, parent.external_id AS parent_external_id, parent.title AS parent_title
      FROM item
      LEFT JOIN LATERAL (
        SELECT p.external_id, p.title
        FROM edges e
        JOIN nodes d ON d.id = e.dst_id
        JOIN resolved_nodes p ON p.id = COALESCE(d.merged_into, d.id)
        WHERE e.edge_type = ${CHILD_OF_EDGE_TYPE}
          AND (e.src_id = item.id OR e.src_id IN (SELECT a.id FROM nodes a WHERE a.merged_into = item.id))
          AND p.id <> item.id
          AND p.node_type = ${WORK_ITEM_NODE_TYPE}
          AND p.metadata @> ${JSON.stringify({ project })}::jsonb
        ORDER BY e.weight DESC, (e.source_system = 'beads') DESC, p.id
        LIMIT 1
      ) parent ON true
    `);
  } catch (err) {
    throw new LookupFailedError(`getBoardItem query failed${formatPgInfo(asPgError(err))}`, "getBoardItem", { cause: err });
  }
  const row = result.rows[0];
  if (!row) return null;
  const metadata = row.metadata ?? {};
  const fields = readWorkItemFields(metadata);
  const labels = Array.isArray(metadata["labels"]) ? metadata["labels"].filter((l): l is string => typeof l === "string") : [];
  const isReview = labels.includes(REVIEW_LABEL);
  return {
    id: row.id,
    externalId: row.external_id,
    sourceSystem: row.source_system,
    project,
    title: row.title,
    content: row.content,
    status: fields.status,
    priority: fields.priority,
    issueType: typeof metadata["issue_type"] === "string" ? metadata["issue_type"] : null,
    assignee: fields.assignee,
    labels,
    closedAt: fields.closedAt,
    closedReason: fields.closedReason,
    updatedAt: new Date(row.updated_at),
    isReview,
    review: isReview && metadata[REVIEW_METADATA_KEY] !== undefined && metadata[REVIEW_METADATA_KEY] !== null ? normalizeReviewMetadata(metadata[REVIEW_METADATA_KEY]) : null,
    comments: isReview ? normalizeReviewComments(metadata[REVIEW_COMMENTS_KEY]) : [],
    parent: row.parent_external_id === null || row.parent_title === null ? null : { externalId: row.parent_external_id, title: row.parent_title },
  };
}
