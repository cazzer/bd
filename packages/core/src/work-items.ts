// Work items (work-items change; work-items spec): the lifecycle contract a
// `work_item` node's metadata obeys, the patch primitive that changes its
// fields, the dependency edge conventions, and the readiness query.
//
// The contract is enforced here and at the tool boundary, never by the
// database: `node_type` stays open text and `upsertNodes` stays
// type-agnostic. Every writer of work items — the MCP write tool, the patch
// primitive below, the beads importer — calls `normalizeWorkItemMetadata`,
// so the three cannot disagree about what a valid item is. The event-time
// contract (event-time.ts) is applied beside it wherever a document is
// written, so `occurred_at` on a work item is canonical too.
//
// `patchWorkItem` is a read-modify-write under `SELECT ... FOR UPDATE`,
// written through the same unsafe upsert kit `annotateNode` uses, inside
// one transaction: title and content are re-sent unchanged, so
// `content_hash` is unchanged, the upsert's own "metadata differs" rule
// bumps `updated_at` and reports updated/unchanged, and the node-history
// trigger records the revision. The row lock is what makes two concurrent
// patches serialize instead of one silently overwriting the other.
//
// The readiness query folds `blocks` edge endpoints through `merged_into`
// (lookup.ts's precedent, for the same reason: an edge attached to a
// merged-away duplicate must still count against its survivor) and finds
// cycle members on read with a set-semantics transitive closure over open
// blockers (never a simple-path enumeration, which is exponential). The
// database trigger (migrations/0003_*.sql) refuses cycles at insert time,
// but a merge can create one the trigger never sees, so detection here is
// required, not redundant.

import { sql, type SQL } from "drizzle-orm";
import type { Database } from "@breakdown/db";
import {
  InvalidLookupIdError,
  InvalidLookupOptionError,
  InvalidWorkItemError,
  LookupFailedError,
  NodeNotFoundError,
  NodeUpsertFailedError,
  NotAWorkItemError,
} from "./errors.js";
import { normalizeOccurredAt } from "./event-time.js";
import type { IngestRunHandle } from "./ingest-runs.js";
import {
  DEFAULT_MAX_CONTENT_LENGTH,
  DEFAULT_MAX_METADATA_LENGTH,
  DEFAULT_MAX_TITLE_LENGTH,
  type NodeUpsertAction,
  type UpsertNodeRow,
  unsafeBuildUpsertNodesQuery,
  unsafePrepareNodes,
  unsafeWrapNodeWriteError,
} from "./nodes.js";
import { asPgError, formatPgInfo } from "./sql-helpers.js";

// --- Conventions ------------------------------------------------------------

export const WORK_ITEM_NODE_TYPE = "work_item";
export const WORK_ITEM_STATUSES = ["open", "in_progress", "blocked", "closed", "deferred"] as const;
export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];
export const DEFAULT_WORK_ITEM_STATUS: WorkItemStatus = "open";
/** 0 is most urgent, 4 is backlog. */
export const MIN_WORK_ITEM_PRIORITY = 0;
export const MAX_WORK_ITEM_PRIORITY = 4;
export const DEFAULT_WORK_ITEM_PRIORITY = 2;
export const MAX_ASSIGNEE_LENGTH = 200;
export const MAX_SPEC_ID_LENGTH = 200;
export const MAX_CLOSED_REASON_LENGTH = 2000;

/** Source blocks target: the source must be closed before the target can be worked. */
export const BLOCKS_EDGE_TYPE = "blocks";
/** Source is a child of target. */
export const CHILD_OF_EDGE_TYPE = "child_of";

/** The contract's fields, read out of a work item's metadata. */
export interface WorkItemFields {
  status: WorkItemStatus;
  priority: number;
  assignee: string | null;
  closedAt: string | null;
  closedReason: string | null;
  specId: string | null;
  /** The tracker a loader owns this item for (live-beads-board); null when it has none. */
  project: string | null;
}

// Metadata keys are snake_case to match every other loader's metadata
// (`state`, `labels` from the GitHub importer); the TypeScript field names
// are camelCase like the rest of core's public types.
const KEY = {
  status: "status",
  priority: "priority",
  assignee: "assignee",
  closedAt: "closed_at",
  closedReason: "closed_reason",
  specId: "spec_id",
  project: "project",
} as const;

/**
 * `project` (live-beads-board design.md decision 1) is a selection key for
 * views and the board, so a typo'd value would silently form its own
 * board: lowercase letters, digits, `.`, `_`, `-`, 1..64 characters after
 * trimming. It is deliberately absent from `WorkItemPatch` — the loader
 * that owns an item is the only writer of its project.
 */
export const PROJECT_KEY_PATTERN = /^[a-z0-9._-]{1,64}$/;

function isStatus(value: unknown): value is WorkItemStatus {
  return typeof value === "string" && (WORK_ITEM_STATUSES as readonly string[]).includes(value);
}

function optionalString(
  metadata: Record<string, unknown>,
  key: string,
  maxLength: number,
  index: number | undefined,
): string | null {
  const value = metadata[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new InvalidWorkItemError(key, value, "must be a string or null", index);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > maxLength) {
    throw new InvalidWorkItemError(key, value, `must be at most ${maxLength} characters`, index);
  }
  return trimmed;
}

export interface NormalizeWorkItemOptions {
  /** The instant a newly closed item's `closed_at` defaults to. Default: now. */
  now?: Date;
  /** Batch position, carried into `InvalidWorkItemError` so a writer can find the item. */
  index?: number;
}

/**
 * Applies the contract to a work item's metadata (work-items spec, "Work
 * items carry a validated lifecycle contract"): defaults a missing status
 * and priority, validates every contract key, applies the closing rules,
 * and passes every other key through untouched. Pure. Throws
 * `InvalidWorkItemError` naming the first offending field.
 */
export function normalizeWorkItemMetadata(
  metadata: Record<string, unknown> | undefined,
  options: NormalizeWorkItemOptions = {},
): Record<string, unknown> {
  const input = metadata ?? {};
  const { index } = options;
  const out: Record<string, unknown> = { ...input };

  const status = input[KEY.status] ?? DEFAULT_WORK_ITEM_STATUS;
  if (!isStatus(status)) {
    throw new InvalidWorkItemError(KEY.status, input[KEY.status], `must be one of ${WORK_ITEM_STATUSES.join(", ")}`, index);
  }
  out[KEY.status] = status;

  const priority = input[KEY.priority] ?? DEFAULT_WORK_ITEM_PRIORITY;
  if (!Number.isInteger(priority) || (priority as number) < MIN_WORK_ITEM_PRIORITY || (priority as number) > MAX_WORK_ITEM_PRIORITY) {
    throw new InvalidWorkItemError(KEY.priority, input[KEY.priority], `must be an integer from ${MIN_WORK_ITEM_PRIORITY} to ${MAX_WORK_ITEM_PRIORITY}`, index);
  }
  out[KEY.priority] = priority;

  for (const [key, max] of [
    [KEY.assignee, MAX_ASSIGNEE_LENGTH],
    [KEY.specId, MAX_SPEC_ID_LENGTH],
    [KEY.closedReason, MAX_CLOSED_REASON_LENGTH],
  ] as const) {
    const value = optionalString(input, key, max, index);
    if (value === null) delete out[key];
    else out[key] = value;
  }

  const projectRaw = input[KEY.project];
  if (projectRaw === undefined || projectRaw === null) {
    delete out[KEY.project];
  } else {
    if (typeof projectRaw !== "string") {
      throw new InvalidWorkItemError(KEY.project, projectRaw, "must be a string or null", index);
    }
    const project = projectRaw.trim();
    if (project.length === 0) delete out[KEY.project];
    else if (!PROJECT_KEY_PATTERN.test(project)) {
      throw new InvalidWorkItemError(KEY.project, projectRaw, "must be 1 to 64 characters of lowercase letters, digits, '.', '_' or '-'", index);
    } else out[KEY.project] = project;
  }

  const closedAtRaw = input[KEY.closedAt];
  let closedAt: string | null = null;
  if (closedAtRaw !== undefined && closedAtRaw !== null) {
    const parsed = typeof closedAtRaw === "string" ? new Date(closedAtRaw) : new Date(Number.NaN);
    if (Number.isNaN(parsed.getTime())) {
      throw new InvalidWorkItemError(KEY.closedAt, closedAtRaw, "must be an ISO-8601 timestamp string or null", index);
    }
    closedAt = parsed.toISOString();
  }

  // Closing rules: entering `closed` stamps the time if the caller did not;
  // being anything else clears the closing fields, so a reopened item
  // cannot carry a stale closed_at or closed_reason.
  if (status === "closed") {
    out[KEY.closedAt] = closedAt ?? (options.now ?? new Date()).toISOString();
  } else {
    delete out[KEY.closedAt];
    delete out[KEY.closedReason];
  }

  return out;
}

/**
 * Reads the contract fields out of metadata leniently — for reporting what
 * an item looked like *before* a patch, when it may predate the contract.
 * Invalid or missing values read as their defaults or null; nothing
 * throws. Use `normalizeWorkItemMetadata` for anything that is written.
 */
export function readWorkItemFields(metadata: Record<string, unknown>): WorkItemFields {
  const status = metadata[KEY.status];
  const priority = metadata[KEY.priority];
  const str = (key: string): string | null => (typeof metadata[key] === "string" ? (metadata[key] as string) : null);
  return {
    status: isStatus(status) ? status : DEFAULT_WORK_ITEM_STATUS,
    priority: Number.isInteger(priority) && (priority as number) >= MIN_WORK_ITEM_PRIORITY && (priority as number) <= MAX_WORK_ITEM_PRIORITY ? (priority as number) : DEFAULT_WORK_ITEM_PRIORITY,
    assignee: str(KEY.assignee),
    closedAt: str(KEY.closedAt),
    closedReason: str(KEY.closedReason),
    specId: str(KEY.specId),
    project: str(KEY.project),
  };
}

// --- Patch ------------------------------------------------------------------

/** Fields a patch may set. `null` removes the key; an absent field is left alone. */
export interface WorkItemPatch {
  status?: WorkItemStatus;
  priority?: number;
  assignee?: string | null;
  closedAt?: string | null;
  closedReason?: string | null;
  specId?: string | null;
}

export interface PatchWorkItemResult {
  /** The canonical node actually patched (the survivor, if `requestedId` was merged away). */
  id: string;
  requestedId: string;
  action: NodeUpsertAction;
  before: WorkItemFields;
  after: WorkItemFields;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type LockedNodeRow = {
  id: string;
  node_type: string;
  source_system: string;
  external_id: string;
  title: string;
  content: string;
  metadata: Record<string, unknown>;
};

/**
 * Changes specific fields of a work item in one attributed transaction. See
 * the module header for the locking and write-path reasoning.
 *
 * Throws `InvalidLookupIdError` (malformed id), `NodeNotFoundError`,
 * `NotAWorkItemError`, `InvalidWorkItemError` (the merged document fails
 * the contract), or `NodeUpsertFailedError` (the write itself failed).
 */
export async function patchWorkItem(db: Database, run: IngestRunHandle, id: string, patch: WorkItemPatch): Promise<PatchWorkItemResult> {
  const requestedId = typeof id === "string" ? id.trim() : "";
  if (!UUID_RE.test(requestedId)) {
    throw new InvalidLookupIdError(id, "must be a valid uuid");
  }

  return db.transaction(async (tx) => {
    let canonical: { rows: { canonical_id: string }[] };
    try {
      canonical = await tx.execute<{ canonical_id: string }>(sql`
        SELECT COALESCE(merged_into, id) AS canonical_id FROM nodes WHERE id = ${requestedId}::uuid
      `);
    } catch (err) {
      throw new LookupFailedError(`patchWorkItem lookup failed${formatPgInfo(asPgError(err))}`, "patchWorkItem", { cause: err });
    }
    const canonicalId = canonical.rows[0]?.canonical_id;
    if (!canonicalId) {
      throw new NodeNotFoundError(requestedId);
    }

    let locked: { rows: LockedNodeRow[] };
    try {
      locked = await tx.execute<LockedNodeRow>(sql`
        SELECT id, node_type, source_system, external_id, title, content, metadata
        FROM nodes WHERE id = ${canonicalId}::uuid
        FOR UPDATE
      `);
    } catch (err) {
      throw new LookupFailedError(`patchWorkItem lock failed${formatPgInfo(asPgError(err))}`, "patchWorkItem", { cause: err });
    }
    const existing = locked.rows[0];
    if (!existing) {
      throw new NodeNotFoundError(canonicalId);
    }
    if (existing.node_type !== WORK_ITEM_NODE_TYPE) {
      throw new NotAWorkItemError(canonicalId, existing.node_type);
    }

    const merged: Record<string, unknown> = { ...existing.metadata };
    const apply = (key: string, value: unknown) => {
      if (value === undefined) return;
      if (value === null) delete merged[key];
      else merged[key] = value;
    };
    apply(KEY.status, patch.status);
    apply(KEY.priority, patch.priority);
    apply(KEY.assignee, patch.assignee);
    apply(KEY.closedAt, patch.closedAt);
    apply(KEY.closedReason, patch.closedReason);
    apply(KEY.specId, patch.specId);

    // Both contracts run over the merged document: the patch cannot set
    // occurred_at, but a row written outside the contract may carry one
    // that is not canonical, and it leaves here canonical or not at all.
    const normalized = normalizeWorkItemMetadata(normalizeOccurredAt(merged));

    const prepared = unsafePrepareNodes(
      [
        {
          nodeType: existing.node_type,
          sourceSystem: existing.source_system,
          externalId: existing.external_id,
          title: existing.title,
          content: existing.content,
          metadata: normalized,
        },
      ],
      DEFAULT_MAX_CONTENT_LENGTH,
      DEFAULT_MAX_METADATA_LENGTH,
      DEFAULT_MAX_TITLE_LENGTH,
    );

    let written: { rows: UpsertNodeRow[] };
    try {
      written = await tx.execute<UpsertNodeRow>(unsafeBuildUpsertNodesQuery(prepared, run.id));
    } catch (err) {
      throw unsafeWrapNodeWriteError(err, prepared);
    }
    const row = written.rows[0];
    if (!row) {
      throw new NodeUpsertFailedError(`patchWorkItem: upsert returned no row for node ${canonicalId}`, 0, 0);
    }

    return {
      id: row.id,
      requestedId,
      action: row.action,
      before: readWorkItemFields(existing.metadata),
      after: readWorkItemFields(normalized),
    };
  });
}

// --- Readiness --------------------------------------------------------------

export const DEFAULT_READINESS_LIMIT = 50;
export const MAX_READINESS_LIMIT = 500;

export interface WorkItemReadinessOptions {
  /** Only items whose `spec_id` equals this. Blockers are still considered store-wide. */
  specId?: string | null;
  /** Max ready items. Default `DEFAULT_READINESS_LIMIT` (50), max `MAX_READINESS_LIMIT` (500). */
  readyLimit?: number;
  /** Max blocked items. Same defaults. */
  blockedLimit?: number;
}

export interface ReadyWorkItem {
  id: string;
  title: string;
  sourceSystem: string;
  externalId: string;
  status: WorkItemStatus;
  priority: number;
  assignee: string | null;
  specId: string | null;
  updatedAt: Date;
}

export interface BlockedWorkItem extends ReadyWorkItem {
  /** Canonical ids of the sources of `blocks` edges into this item that are not closed work items. */
  openBlockerIds: string[];
  /** True when this item reaches itself through open blockers. */
  inCycle: boolean;
}

export interface WorkItemReadinessResult {
  ready: ReadyWorkItem[];
  readyHasMore: boolean;
  blocked: BlockedWorkItem[];
  blockedHasMore: boolean;
  /** Canonical ids of work items (matching the spec filter) that reach themselves through open blockers. Never ready. At most `MAX_READINESS_LIMIT` ids. */
  cycleMemberIds: string[];
}

export interface BuildWorkItemReadinessQueryParams {
  specId: string | null;
  readyLimit: number;
  blockedLimit: number;
}

type RawReadyItem = {
  id: string;
  title: string;
  source_system: string;
  external_id: string;
  status: string;
  priority: number;
  assignee: string | null;
  spec_id: string | null;
  updated_at: string;
};
type RawBlockedItem = RawReadyItem & { open_blocker_ids: string[]; in_cycle: boolean };
type RawReadinessResult = {
  ready: RawReadyItem[];
  ready_has_more: boolean;
  blocked: RawBlockedItem[];
  blocked_has_more: boolean;
  cycle_member_ids: string[];
};

/**
 * The blocking CTEs, shared verbatim by the readiness query and the board
 * query (board.ts) so the two can never disagree about what blocks: `blocks`
 * (folded edges), `open_blocks`, `reach`, `cycle_members`, `blocked_by`.
 * Store-wide by construction: no CTE here is scoped to a spec or project, so
 * a cross-project blocker counts. Must be spliced into a `WITH RECURSIVE`
 * list (it declares a recursive CTE) after the caller's own CTEs, and
 * carries no trailing comma. Pure.
 */
export function buildBlockingCtes(): SQL {
  return sql`
-- Every blocks edge with both endpoints folded onto canonical ids. A
-- merge-induced self-loop (loser blocked survivor, then merged into it)
-- is dropped: it says an item blocks itself, which is not a dependency.
blocks AS (
  SELECT DISTINCT COALESCE(s.merged_into, s.id) AS src_id, COALESCE(d.merged_into, d.id) AS dst_id
  FROM edges e
  JOIN nodes s ON s.id = e.src_id
  JOIN nodes d ON d.id = e.dst_id
  WHERE e.edge_type = ${BLOCKS_EDGE_TYPE}
    AND COALESCE(s.merged_into, s.id) <> COALESCE(d.merged_into, d.id)
),
-- An open blocker is any source that is not a closed work item: a
-- non-work-item source has no status to be closed, so it blocks.
open_blocks AS (
  SELECT b.src_id, b.dst_id
  FROM blocks b
  JOIN resolved_nodes n ON n.id = b.src_id
  WHERE NOT (n.node_type = ${WORK_ITEM_NODE_TYPE} AND COALESCE(n.metadata->>'status', 'open') = 'closed')
),
-- Transitive closure over open blockers with set semantics: UNION feeds
-- only unseen (start, node) pairs forward, so the working set is bounded
-- by V^2 pairs, each expanded once (O(V*E)), and it terminates on a cycle
-- without tracking paths. Enumerating simple paths instead (UNION ALL
-- with a path array, or the CYCLE clause) is exponential on a dense
-- layered DAG and must not be used here.
reach(start_id, node_id) AS (
  SELECT src_id, dst_id FROM open_blocks
  UNION
  SELECT r.start_id, ob.dst_id
  FROM reach r
  JOIN open_blocks ob ON ob.src_id = r.node_id
),
cycle_members AS (
  SELECT DISTINCT start_id AS id FROM reach WHERE node_id = start_id
),
blocked_by AS (
  SELECT ob.dst_id AS id, array_agg(ob.src_id ORDER BY ob.src_id) AS open_blocker_ids
  FROM open_blocks ob
  GROUP BY ob.dst_id
)
`;
}

/** Pure: builds the readiness statement from already-validated params. */
export function buildWorkItemReadinessQuery(params: BuildWorkItemReadinessQueryParams): SQL {
  const specId = params.specId === null ? sql`NULL::text` : sql`${params.specId}::text`;
  return sql`
WITH RECURSIVE
items AS (
  SELECT id, title, source_system, external_id, updated_at,
         -- A work item written without a status key (possible via raw upsertNodes)
         -- reads as open, matching readWorkItemFields.
         COALESCE(metadata->>'status', 'open') AS status,
         CASE WHEN jsonb_typeof(metadata->'priority') = 'number'
              THEN (metadata->>'priority')::int
              ELSE ${DEFAULT_WORK_ITEM_PRIORITY}::int END AS priority,
         metadata->>'assignee' AS assignee,
         metadata->>'spec_id' AS spec_id
  FROM resolved_nodes
  WHERE node_type = ${WORK_ITEM_NODE_TYPE}
    AND (${specId} IS NULL OR metadata->>'spec_id' = ${specId})
),
${buildBlockingCtes()},
ready AS (
  SELECT i.*
  FROM items i
  WHERE i.status = 'open'
    AND NOT EXISTS (SELECT 1 FROM blocked_by b WHERE b.id = i.id)
    AND NOT EXISTS (SELECT 1 FROM cycle_members c WHERE c.id = i.id)
  ORDER BY i.priority ASC, i.updated_at DESC, i.id DESC
  LIMIT ${params.readyLimit + 1}::int
),
blocked AS (
  SELECT i.*, b.open_blocker_ids,
         EXISTS (SELECT 1 FROM cycle_members c WHERE c.id = i.id) AS in_cycle
  FROM items i
  JOIN blocked_by b ON b.id = i.id
  WHERE i.status IN ('open', 'in_progress', 'blocked')
  ORDER BY i.priority ASC, i.updated_at DESC, i.id DESC
  LIMIT ${params.blockedLimit + 1}::int
)
SELECT jsonb_build_object(
  'ready', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', r.id, 'title', r.title, 'source_system', r.source_system, 'external_id', r.external_id,
      'status', r.status, 'priority', r.priority, 'assignee', r.assignee, 'spec_id', r.spec_id,
      'updated_at', r.updated_at
    ) ORDER BY r.priority ASC, r.updated_at DESC, r.id DESC)
    FROM (SELECT * FROM ready ORDER BY priority ASC, updated_at DESC, id DESC LIMIT ${params.readyLimit}::int) r
  ), '[]'::jsonb),
  'ready_has_more', (SELECT count(*) FROM ready) > ${params.readyLimit}::int,
  'blocked', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', b.id, 'title', b.title, 'source_system', b.source_system, 'external_id', b.external_id,
      'status', b.status, 'priority', b.priority, 'assignee', b.assignee, 'spec_id', b.spec_id,
      'updated_at', b.updated_at, 'open_blocker_ids', to_jsonb(b.open_blocker_ids), 'in_cycle', b.in_cycle
    ) ORDER BY b.priority ASC, b.updated_at DESC, b.id DESC)
    FROM (SELECT * FROM blocked ORDER BY priority ASC, updated_at DESC, id DESC LIMIT ${params.blockedLimit}::int) b
  ), '[]'::jsonb),
  'blocked_has_more', (SELECT count(*) FROM blocked) > ${params.blockedLimit}::int,
  'cycle_member_ids', COALESCE((
    SELECT jsonb_agg(c.id ORDER BY c.id)
    FROM (SELECT c.id FROM cycle_members c JOIN items i ON i.id = c.id LIMIT ${MAX_READINESS_LIMIT}::int) c
  ), '[]'::jsonb)
) AS result
`;
}

function resolveReadinessOptions(options: WorkItemReadinessOptions): BuildWorkItemReadinessQueryParams {
  const check = (name: string, value: number): number => {
    if (!Number.isInteger(value) || value <= 0 || value > MAX_READINESS_LIMIT) {
      throw new InvalidLookupOptionError(name, value, `must be a positive integer no greater than ${MAX_READINESS_LIMIT}`);
    }
    return value;
  };
  let specId: string | null = null;
  if (options.specId !== null && options.specId !== undefined) {
    if (typeof options.specId !== "string" || options.specId.trim().length === 0 || options.specId.length > MAX_SPEC_ID_LENGTH) {
      throw new InvalidLookupOptionError("specId", options.specId, `must be a non-empty string of at most ${MAX_SPEC_ID_LENGTH} characters, or null`);
    }
    specId = options.specId.trim();
  }
  return {
    specId,
    readyLimit: check("readyLimit", options.readyLimit ?? DEFAULT_READINESS_LIMIT),
    blockedLimit: check("blockedLimit", options.blockedLimit ?? DEFAULT_READINESS_LIMIT),
  };
}

function mapReadyItem(row: RawReadyItem): ReadyWorkItem {
  return {
    id: row.id,
    title: row.title,
    sourceSystem: row.source_system,
    externalId: row.external_id,
    status: isStatus(row.status) ? row.status : DEFAULT_WORK_ITEM_STATUS,
    priority: row.priority,
    assignee: row.assignee,
    specId: row.spec_id,
    updatedAt: new Date(row.updated_at),
  };
}

/**
 * The readiness report (work-items spec, "Readiness"). See the module
 * header for the folding and cycle-detection reasoning.
 */
export async function getWorkItemReadiness(db: Database, options: WorkItemReadinessOptions = {}): Promise<WorkItemReadinessResult> {
  const params = resolveReadinessOptions(options);

  let result: { rows: { result: RawReadinessResult }[] };
  try {
    result = await db.execute<{ result: RawReadinessResult }>(buildWorkItemReadinessQuery(params));
  } catch (err) {
    throw new LookupFailedError(`getWorkItemReadiness query failed${formatPgInfo(asPgError(err))}`, "getWorkItemReadiness", { cause: err });
  }
  const row = result.rows[0];
  if (!row) {
    throw new LookupFailedError("getWorkItemReadiness query returned no row", "getWorkItemReadiness");
  }

  return {
    ready: row.result.ready.map(mapReadyItem),
    readyHasMore: row.result.ready_has_more,
    blocked: row.result.blocked.map((b) => ({ ...mapReadyItem(b), openBlockerIds: b.open_blocker_ids, inCycle: b.in_cycle })),
    blockedHasMore: row.result.blocked_has_more,
    cycleMemberIds: row.result.cycle_member_ids,
  };
}
