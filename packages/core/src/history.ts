/**
 * Per-node revision history (node-history change; knowledge-store spec,
 * "A node's history is readable with what changed"). Reads
 * `node_revisions` — the append-only full snapshots the triggers in
 * migrations/0002_*.sql record for every change to a node's type, title,
 * content, metadata, or merge pointer — newest first, and computes what
 * changed between each revision and its predecessor at read time. Nothing
 * is ever stored as a diff (design.md, "Change detection on read, in SQL").
 *
 * Deliberately NOT merge-folded, unlike `getNodes`/`getNeighbors` in
 * lookup.ts: history is per node as stored. Asking for a merged-away
 * node's history returns that node's own revisions — including the one
 * that merged it, which is exactly what "what happened to this node"
 * means — never its survivor's. `NodeNotFoundError` here therefore means
 * the id matches no row at all.
 *
 * Structure mirrors lookup.ts's `getNeighbors`: a pure query builder,
 * option validation that throws before any SQL runs, keyset paging
 * (`before` on `revision_no`, one row beyond `limit` so `has_more` needs no
 * COUNT(*) over the whole history), and every failure a
 * `KnowledgeStoreError`.
 */

import { sql, type SQL } from "drizzle-orm";
import type { Database } from "@breakdown/db";
import { InvalidLookupIdError, InvalidLookupOptionError, LookupFailedError, NodeNotFoundError } from "./errors.js";
import { asPgError, formatPgInfo } from "./sql-helpers.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The node fields history tracks — the same five the AFTER UPDATE trigger's WHEN clause compares. */
export type RevisionField = "nodeType" | "title" | "content" | "metadata" | "mergedInto";

/**
 * One top-level metadata key's value on either side of a revision. An
 * absent key reads as `null` on that side — which also means a key whose
 * value is JSON `null` cannot be told apart from an absent one here.
 * Documented, not solved: nothing in the write path treats the two
 * differently either.
 */
export interface MetadataKeyChange {
  before: unknown;
  after: unknown;
}

/** The ingest run that recorded a revision — who did it, at the granularity the store can know. */
export interface RevisionIngestRun {
  id: string;
  sourceSystem: string;
  actor: string | null;
}

export interface NodeRevision {
  /** Counts from 1 per node, in the order recorded. */
  revisionNo: number;
  recordedAt: Date;
  ingestRun: RevisionIngestRun;
  nodeType: string;
  title: string;
  /** Present only when `includeContent` was true — the key is absent otherwise, not `undefined`. */
  content?: string;
  /** Always present: reveals whether title/content changed without carrying the content. */
  contentHash: string;
  metadata: Record<string, unknown>;
  mergedInto: string | null;
  /** Fields that differ from the previous revision. The first revision lists every present field — always nodeType/title/content/metadata (NOT NULL columns; an empty title is still a value), and mergedInto only when set. */
  changedFields: RevisionField[];
  /** Top-level metadata keys whose value differs from the previous revision, each with its value on both sides. Empty when metadata did not change. */
  metadataChanges: Record<string, MetadataKeyChange>;
}

export interface GetNodeHistoryOptions {
  /** Max revisions per page. Default `DEFAULT_HISTORY_LIMIT` (20); hard ceiling `MAX_HISTORY_LIMIT` (200). */
  limit?: number;
  /** Only revisions numbered strictly below this. Omit or pass `null` for the newest page; pass a previous result's `nextBefore` to continue. */
  before?: number | null;
  /** Include each revision's `content`. Default false — content can be large, and `contentHash` already shows whether it changed. */
  includeContent?: boolean;
}

export interface GetNodeHistoryResult {
  /** The requested id, trimmed — no merge folding (see the module header). */
  nodeId: string;
  /** At most `limit` revisions, newest first. */
  revisions: NodeRevision[];
  /** True when older revisions exist beyond this page. */
  hasMore: boolean;
  /** Pass as `before` for the next (older) page. `null` when `hasMore` is false. */
  nextBefore: number | null;
}

/** Resolved, validated arguments to `buildNodeHistoryQuery` — see `getNodeHistory` for how they are validated. */
export interface BuildNodeHistoryQueryParams {
  id: string;
  limit: number;
  before: number | null;
  includeContent: boolean;
}

/** Default page size — a work item's whole recent life fits in one call; a long-lived document pages. */
export const DEFAULT_HISTORY_LIMIT = 20;

/**
 * Hard ceiling on `limit`, for the same reason as lookup.ts's
 * `MAX_NEIGHBOR_LIMIT`: `buildNodeHistoryQuery` computes `limit + 1` in JS
 * and binds it as `::int`, so an unbounded value would overflow int4 at
 * bind time and surface as a `LookupFailedError` whose `.cause` embeds the
 * whole SQL statement — exactly what `InvalidLookupOptionError`'s
 * "rejected before any SQL runs" contract exists to prevent.
 */
export const MAX_HISTORY_LIMIT = 200;

/** Largest value Postgres `int4` holds — `before` is bound as `::int`, so anything above this must be rejected before it reaches the driver (same rationale as `MAX_HISTORY_LIMIT`). */
const INT4_MAX = 2_147_483_647;

/**
 * Pure query builder — no database. `id` must already be validated to
 * look like a uuid (see `getNodeHistory`); it need not exist — the query
 * reports whether it found anything (`found` in the raw result), which
 * `getNodeHistory` turns into `NodeNotFoundError` when it did not.
 */
export function buildNodeHistoryQuery(params: BuildNodeHistoryQueryParams): SQL {
  // NULL means "first page" — lookup.ts's nullable-filter convention
  // (`(:param IS NULL OR ...)`), rather than two query shapes.
  const before = params.before === null ? sql`NULL::int` : sql`${params.before}::int`;

  return sql`
WITH revs AS (
  -- Every revision of the node, each paired with its predecessor. This
  -- window runs over ALL of the node's revisions, before the before/limit
  -- page below is cut: cutting first would give the oldest revision on a
  -- page a NULL predecessor and misreport every field as changed. The
  -- planner cannot push the page filter below a window ordered by the same
  -- column, so this ordering is preserved, not just hoped for.
  SELECT r.revision_no, r.recorded_at, r.ingest_run_id,
         r.node_type, r.title, r.content, r.content_hash, r.metadata, r.merged_into,
         LAG(r.node_type)   OVER w AS prev_node_type,
         LAG(r.title)       OVER w AS prev_title,
         LAG(r.content)     OVER w AS prev_content,
         LAG(r.metadata)    OVER w AS prev_metadata,
         LAG(r.merged_into) OVER w AS prev_merged_into
  FROM node_revisions r
  WHERE r.node_id = ${params.id}::uuid
  WINDOW w AS (ORDER BY r.revision_no)
),
-- Keyset page: newest first, strictly older than \`before\` (NULL = first
-- page), one row beyond \`limit\` so has_more needs no COUNT(*) over the
-- whole history (lookup.ts's paged/page convention).
paged AS (
  SELECT * FROM revs
  WHERE ${before} IS NULL OR revision_no < ${before}
  ORDER BY revision_no DESC
  LIMIT ${params.limit + 1}::int
),
page AS (
  SELECT * FROM paged ORDER BY revision_no DESC LIMIT ${params.limit}::int
),
diffed AS (
  SELECT p.*,
    -- IS DISTINCT FROM against a NULL predecessor is what makes the first
    -- revision report every non-null field with no special case: NOT NULL
    -- columns are always "present" (an empty title is still a value) and
    -- merged_into is present only when set. content is compared directly,
    -- not by content_hash: the hash covers title AND content, so a
    -- title-only change would otherwise misreport content as changed.
    ARRAY_REMOVE(ARRAY[
      CASE WHEN p.node_type   IS DISTINCT FROM p.prev_node_type   THEN 'nodeType'   END,
      CASE WHEN p.title       IS DISTINCT FROM p.prev_title       THEN 'title'      END,
      CASE WHEN p.content     IS DISTINCT FROM p.prev_content     THEN 'content'    END,
      CASE WHEN p.metadata    IS DISTINCT FROM p.prev_metadata    THEN 'metadata'   END,
      CASE WHEN p.merged_into IS DISTINCT FROM p.prev_merged_into THEN 'mergedInto' END
    ]::text[], NULL) AS changed_fields,
    -- { key: { before, after } } over the union of both revisions' top-level
    -- keys, keeping only keys whose values differ. \`->\` on a missing key is
    -- SQL NULL, which jsonb_build_object renders as JSON null, so an added
    -- key shows before: null and a removed key shows after: null. The
    -- jsonb_typeof guard keeps a read from failing outright if some
    -- revision's metadata is not an object (nothing in the write path
    -- produces one, but the column does not forbid it) — such a revision
    -- still reports 'metadata' in changed_fields, just without per-key
    -- detail.
    CASE
      WHEN p.metadata IS DISTINCT FROM p.prev_metadata
       AND jsonb_typeof(p.metadata) = 'object'
       AND jsonb_typeof(COALESCE(p.prev_metadata, '{}'::jsonb)) = 'object'
      THEN COALESCE((
        SELECT jsonb_object_agg(k.key, jsonb_build_object(
                 'before', COALESCE(p.prev_metadata, '{}'::jsonb) -> k.key,
                 'after',  p.metadata -> k.key))
        FROM (
          SELECT jsonb_object_keys(COALESCE(p.prev_metadata, '{}'::jsonb)) AS key
          UNION
          SELECT jsonb_object_keys(p.metadata)
        ) k
        WHERE COALESCE(p.prev_metadata, '{}'::jsonb) -> k.key IS DISTINCT FROM p.metadata -> k.key
      ), '{}'::jsonb)
      ELSE '{}'::jsonb
    END AS metadata_changes
  FROM page p
)
SELECT jsonb_build_object(
  'found', EXISTS (SELECT 1 FROM nodes WHERE id = ${params.id}::uuid),
  'revisions', COALESCE((
    SELECT jsonb_agg(
      jsonb_build_object(
        'revision_no',      d.revision_no,
        'recorded_at',      d.recorded_at,
        'ingest_run',       jsonb_build_object('id', ir.id, 'source_system', ir.source_system, 'actor', ir.actor),
        'node_type',        d.node_type,
        'title',            d.title,
        'content_hash',     d.content_hash,
        'metadata',         d.metadata,
        'merged_into',      d.merged_into,
        'changed_fields',   to_jsonb(d.changed_fields),
        'metadata_changes', d.metadata_changes
      ) || CASE WHEN ${params.includeContent}::boolean THEN jsonb_build_object('content', d.content) ELSE '{}'::jsonb END
      ORDER BY d.revision_no DESC
    )
    FROM diffed d
    JOIN ingest_runs ir ON ir.id = d.ingest_run_id
  ), '[]'::jsonb),
  'has_more', (SELECT count(*) FROM paged) > ${params.limit}::int
) AS result
`;
}

// `db.execute()` returns the raw driver row: snake_case keys, timestamptz
// as text (coerced to Date in mapRevision), and `content` present only
// when the query was built with includeContent.
interface RawRevision {
  revision_no: number;
  recorded_at: string;
  ingest_run: { id: string; source_system: string; actor: string | null };
  node_type: string;
  title: string;
  content?: string;
  content_hash: string;
  metadata: Record<string, unknown>;
  merged_into: string | null;
  changed_fields: RevisionField[];
  metadata_changes: Record<string, MetadataKeyChange>;
}

interface RawNodeHistoryResult {
  found: boolean;
  revisions: RawRevision[];
  has_more: boolean;
}

function mapRevision(row: RawRevision): NodeRevision {
  return {
    revisionNo: row.revision_no,
    recordedAt: new Date(row.recorded_at),
    ingestRun: { id: row.ingest_run.id, sourceSystem: row.ingest_run.source_system, actor: row.ingest_run.actor },
    nodeType: row.node_type,
    title: row.title,
    // Spread conditionally so the key is genuinely absent (not
    // `undefined`) when content was not requested — JSON.stringify would
    // drop an undefined value anyway, but a consumer inspecting the object
    // with `"content" in revision` must see the truth too.
    ...(row.content !== undefined ? { content: row.content } : {}),
    contentHash: row.content_hash,
    metadata: row.metadata,
    mergedInto: row.merged_into,
    changedFields: row.changed_fields,
    metadataChanges: row.metadata_changes,
  };
}

/** Validates `limit`/`before`/`includeContent`, throwing `InvalidLookupOptionError` on the first problem found — before any SQL runs, same convention as lookup.ts's `resolveGetNeighborsOptions`. */
function resolveGetNodeHistoryOptions(options: GetNodeHistoryOptions): { limit: number; before: number | null; includeContent: boolean } {
  const limit = options.limit ?? DEFAULT_HISTORY_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_HISTORY_LIMIT) {
    throw new InvalidLookupOptionError("limit", limit, `must be a positive integer no greater than ${MAX_HISTORY_LIMIT}`);
  }

  const before = options.before ?? null;
  if (before !== null && (!Number.isInteger(before) || before <= 0 || before > INT4_MAX)) {
    throw new InvalidLookupOptionError("before", before, "must be a positive integer (a revisionNo from a previous page, e.g. nextBefore), or null for the newest page");
  }

  return { limit, before, includeContent: options.includeContent ?? false };
}

/**
 * A node's revisions, newest first, each stating what changed versus the
 * revision before it (see `NodeRevision.changedFields` /
 * `metadataChanges`). Throws `NodeNotFoundError` if `id` names no node —
 * with no merge folding, per the module header. Bounded: at most
 * `options.limit` (default `DEFAULT_HISTORY_LIMIT`) revisions come back;
 * `hasMore` reports whether older ones exist and `nextBefore` is the
 * `before` value that fetches them. Content is omitted unless
 * `options.includeContent` is true.
 */
export async function getNodeHistory(db: Database, id: string, options: GetNodeHistoryOptions = {}): Promise<GetNodeHistoryResult> {
  const trimmed = typeof id === "string" ? id.trim() : "";
  if (!UUID_RE.test(trimmed)) {
    throw new InvalidLookupIdError(id, "must be a valid uuid");
  }
  const { limit, before, includeContent } = resolveGetNodeHistoryOptions(options);

  let result: { rows: { result: RawNodeHistoryResult }[] };
  try {
    result = await db.execute<{ result: RawNodeHistoryResult }>(buildNodeHistoryQuery({ id: trimmed, limit, before, includeContent }));
  } catch (err) {
    throw new LookupFailedError(`getNodeHistory query failed${formatPgInfo(asPgError(err))}`, "getNodeHistory", { cause: err });
  }

  const row = result.rows[0];
  if (!row) {
    throw new LookupFailedError("getNodeHistory query returned no row", "getNodeHistory");
  }
  if (!row.result.found) {
    throw new NodeNotFoundError(trimmed);
  }

  const revisions = row.result.revisions.map(mapRevision);
  const oldest = revisions[revisions.length - 1];
  const hasMore = row.result.has_more;

  return {
    nodeId: trimmed,
    revisions,
    hasMore,
    nextBefore: hasMore && oldest ? oldest.revisionNo : null,
  };
}
