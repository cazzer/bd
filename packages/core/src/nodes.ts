import { sql } from "drizzle-orm";
import type { Database } from "@breakdown/db";
import { computeContentHash } from "./content-hash.js";
import {
  ContentTooLargeError,
  DuplicateNodeInBatchError,
  InvalidNodeContentError,
  InvalidNodeInputError,
  MetadataTooLargeError,
  NodeUpsertFailedError,
} from "./errors.js";
import type { IngestRunHandle } from "./ingest-runs.js";
import { asPgError, chunk, formatPgInfo, sqlArray } from "./sql-helpers.js";

/**
 * Default cap on a node's `content` length, in UTF-16 code units.
 *
 * Deliberately not a database CHECK constraint (see the migration/schema
 * comments) — a hard schema limit would reject a legitimately large
 * document with an opaque constraint-violation error. 1,000,000 characters
 * (~1-2MB depending on encoding) is comfortably larger than any single
 * document breakdown ingests today (a README, a PR body, a chat thread,
 * a spec) while still catching a caller mistake — an entire repo dumped
 * into one field, or a binary file misread as text. Override per call via
 * `UpsertNodesOptions.maxContentLength` if a source genuinely needs more.
 */
export const DEFAULT_MAX_CONTENT_LENGTH = 1_000_000;

/**
 * Default cap on a node's `metadata`, measured as `JSON.stringify(metadata).length`.
 *
 * `metadata` is meant for small structured key/value data attached to a
 * node (tags, external urls, a status flag) — not document content, which
 * `content` already exists for. Unlike `content`, nothing bounded this at
 * all before bd-vt2.5's review: an oversized value wrote successfully and
 * then reappeared in full in every read that returned it. 50,000
 * characters is generous for genuine metadata while still catching the
 * failure mode that motivated this — a multi-megabyte value dumped into
 * the field by mistake (or by a less careful caller treating it as a
 * second content field). Override per call via
 * `UpsertNodesOptions.maxMetadataLength` if a source genuinely needs more.
 */
export const DEFAULT_MAX_METADATA_LENGTH = 50_000;

/** Default chunk size for the `unnest(...)` batch upsert — see design.md "Writes". */
export const DEFAULT_NODE_CHUNK_SIZE = 1000;

export interface NodeInput {
  nodeType: string;
  sourceSystem: string;
  externalId: string;
  title?: string;
  content?: string;
  metadata?: Record<string, unknown>;
}

export interface UpsertNodesOptions {
  /** Rows per `unnest(...)` statement. Default `DEFAULT_NODE_CHUNK_SIZE` (1000). */
  chunkSize?: number;
  /** Max `content` length, in characters. Default `DEFAULT_MAX_CONTENT_LENGTH`. */
  maxContentLength?: number;
  /** Max serialized `metadata` length, in characters. Default `DEFAULT_MAX_METADATA_LENGTH`. */
  maxMetadataLength?: number;
}

export type NodeUpsertAction = "created" | "updated" | "unchanged";

export interface NodeUpsertResultRow {
  id: string;
  sourceSystem: string;
  externalId: string;
  action: NodeUpsertAction;
}

export interface UpsertNodesResult {
  created: number;
  updated: number;
  unchanged: number;
  rows: NodeUpsertResultRow[];
}

// --- Unsafe internals (exported for human-writes.ts's annotateNode only) ---
//
// Everything below named `unsafe*` — PreparedNode, unsafePrepareNodes,
// unsafeBuildUpsertNodesQuery, unsafeWrapNodeWriteError — exists to let
// `annotateNode` compose a note insert and its edge insert into one
// transaction (upsertNodes always opens its own, which would defeat the
// point). It is NOT a second public write API.
//
// The `unsafe` marker is load-bearing, not decorative: the `nodes` table
// has zero CHECK constraints on content length or control characters —
// unlike `edges_weight_range_check`, there is NO database-level backstop
// here. `unsafePrepareNodes` is the ENTIRE validation for those
// properties. Call `unsafeBuildUpsertNodesQuery` with a `PreparedNode`
// that didn't come from `unsafePrepareNodes` — e.g. hand-built with a
// fabricated `contentHash` and no length check — and it writes verbatim,
// nothing thrown, nothing caught, at any size, with any byte. Always call
// `unsafePrepareNodes` first and pass its own output straight through.
// Never call any of these from outside this package; use `upsertNodes`.

export interface PreparedNode {
  index: number;
  nodeType: string;
  sourceSystem: string;
  externalId: string;
  title: string;
  content: string;
  contentHash: string;
  metadataJson: string;
}

// C0 control characters (code points 0-31) other than tab, newline, and
// carriage return, plus DEL (127). Postgres "text" columns cannot store a
// literal NUL byte (code point 0) at all - the write dies with an
// unhelpful driver-level error - and the rest are never legitimate in
// prose; scraped repo/chat content is a plausible source of either.
// Scoped to title/content only (the two raw text columns, matching
// ContentTooLargeError's scope): metadata goes through JSON.stringify,
// which escapes control characters as harmless six-character text
// sequences rather than raw bytes, so it is not vulnerable the same way
// (see the "genuine database failure in a later chunk" test in
// nodes.test.ts for the one Postgres quirk this does not cover: an
// escaped NUL sequence inside a jsonb string, which jsonb itself
// rejects).
const CONTROL_CHAR_CODE_POINTS = new Set<number>([
  0, 1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 127,
]);

function findControlChar(value: string): { charPosition: number; codePoint: number } | undefined {
  for (let i = 0; i < value.length; i += 1) {
    const codePoint = value.codePointAt(i);
    if (codePoint !== undefined && CONTROL_CHAR_CODE_POINTS.has(codePoint)) {
      return { charPosition: i, codePoint };
    }
  }
  return undefined;
}

/**
 * Validates and hashes every row before any SQL runs. Boundary validation
 * (content length, control characters, required fields, duplicate keys
 * within the batch) lives here rather than being left to the database, so
 * a bad row is rejected with a message naming it — not a bare constraint
 * violation — and so an invalid batch never touches the database at all
 * (the strongest form of "the whole batch is rejected, nothing is
 * persisted").
 *
 * Exported (as `unsafePrepareNodes`) so `human-writes.ts`'s `annotateNode`
 * can validate/hash a note this exact way while composing it into a
 * hand-built transaction alongside an edge insert — reusing this
 * function (not reimplementing it) is what keeps that path subject to
 * the same validation as every other node write, per the knowledge-store
 * spec's "A person's write is validated like any other".
 *
 * UNSAFE outside this package: this IS the content-length/control-character
 * check — `nodes` has no CHECK constraint backing it. See the "Unsafe
 * internals" banner above.
 */
export function unsafePrepareNodes(input: readonly NodeInput[], maxContentLength: number, maxMetadataLength: number): PreparedNode[] {
  const prepared: PreparedNode[] = [];
  const seen = new Map<string, number>();

  input.forEach((n, index) => {
    const nodeType = n.nodeType.trim();
    const sourceSystem = n.sourceSystem.trim();
    const externalId = n.externalId.trim();
    if (!nodeType) {
      throw new InvalidNodeInputError("nodeType must be a non-empty string", index, n.sourceSystem, n.externalId);
    }
    if (!sourceSystem) {
      throw new InvalidNodeInputError("sourceSystem must be a non-empty string", index, n.sourceSystem, n.externalId);
    }
    if (!externalId) {
      throw new InvalidNodeInputError("externalId must be a non-empty string", index, n.sourceSystem, n.externalId);
    }

    const title = n.title ?? "";
    const content = n.content ?? "";
    if (content.length > maxContentLength) {
      throw new ContentTooLargeError(index, sourceSystem, externalId, content.length, maxContentLength);
    }

    const titleControl = findControlChar(title);
    if (titleControl) {
      throw new InvalidNodeContentError(index, sourceSystem, externalId, "title", titleControl.charPosition, titleControl.codePoint);
    }
    const contentControl = findControlChar(content);
    if (contentControl) {
      throw new InvalidNodeContentError(index, sourceSystem, externalId, "content", contentControl.charPosition, contentControl.codePoint);
    }

    // See MetadataTooLargeError: unlike content, nothing bounded metadata
    // at all before this check existed — a multi-megabyte value would
    // write successfully and reappear whole in every read that returns
    // it.
    const metadataJson = JSON.stringify(n.metadata ?? {});
    if (metadataJson.length > maxMetadataLength) {
      throw new MetadataTooLargeError(index, sourceSystem, externalId, metadataJson.length, maxMetadataLength);
    }

    const key = `${sourceSystem} ${externalId}`;
    const firstIndex = seen.get(key);
    if (firstIndex !== undefined) {
      throw new DuplicateNodeInBatchError(sourceSystem, externalId, firstIndex, index);
    }
    seen.set(key, index);

    prepared.push({
      index,
      nodeType,
      sourceSystem,
      externalId,
      title,
      content,
      contentHash: computeContentHash(title, content),
      metadataJson,
    });
  });

  return prepared;
}

export type UpsertNodeRow = {
  id: string;
  source_system: string;
  external_id: string;
  action: NodeUpsertAction;
}

/**
 * UNSAFE: writes `rows` to the database verbatim, trusting `contentHash`
 * and every length/control-character property is already correct — it
 * does not re-validate. `nodes` has no CHECK constraint on content
 * length or control characters, so calling this with a `PreparedNode`
 * that did not come from `unsafePrepareNodes` (e.g. hand-built with a
 * fabricated hash) writes that data at any size, with any byte, nothing
 * thrown. Always call `unsafePrepareNodes` first and pass its output
 * straight through. See the "Unsafe internals" banner above.
 */
export function unsafeBuildUpsertNodesQuery(rows: readonly PreparedNode[], ingestRunId: string) {
  return sql`
    WITH input(node_type, source_system, external_id, title, content, content_hash, metadata) AS (
      SELECT * FROM unnest(
        ${sqlArray(rows.map((r) => r.nodeType), "text")},
        ${sqlArray(rows.map((r) => r.sourceSystem), "text")},
        ${sqlArray(rows.map((r) => r.externalId), "text")},
        ${sqlArray(rows.map((r) => r.title), "text")},
        ${sqlArray(rows.map((r) => r.content), "text")},
        ${sqlArray(rows.map((r) => r.contentHash), "text")},
        ${sqlArray(rows.map((r) => r.metadataJson), "jsonb")}
      )
    ),
    -- Reads each row's pre-upsert node_type/content_hash/metadata. Safe to
    -- read nodes directly here (not through the upsert CTE) even though
    -- upsert modifies the same table in the same statement: Postgres
    -- evaluates every CTE in a data-modifying WITH against the snapshot at
    -- the start of the statement, so this always sees the row as it was
    -- before this statement's INSERT ... ON CONFLICT DO UPDATE touched it.
    existing AS (
      SELECT n.source_system, n.external_id,
        n.node_type AS old_node_type,
        n.content_hash AS old_content_hash,
        n.metadata AS old_metadata
      FROM nodes n
      JOIN input i ON i.source_system = n.source_system AND i.external_id = n.external_id
    ),
    upsert AS (
      INSERT INTO nodes (node_type, source_system, external_id, title, content, content_hash, metadata, ingest_run_id)
      SELECT node_type, source_system, external_id, title, content, content_hash, metadata, ${ingestRunId}::uuid
      FROM input
      ON CONFLICT (source_system, external_id) DO UPDATE SET
        node_type = excluded.node_type,
        title = excluded.title,
        content = excluded.content,
        content_hash = excluded.content_hash,
        metadata = excluded.metadata,
        ingest_run_id = excluded.ingest_run_id,
        -- Bump updated_at when ANY mutable column actually differs from
        -- what was stored, not just content_hash — content_hash only
        -- covers title/content, and node_type/metadata are just as
        -- mutable and just as real a change (bd-vt2.3 review: a
        -- metadata-only correction was silently reported "unchanged" and
        -- left updated_at frozen, which the "updated since" retrieval
        -- filter in bd-vt2.4 would build directly on). An "unchanged" row
        -- (none of these differ) must still not advance its timestamp
        -- (knowledge-store spec, "Load re-run over unchanged input").
        updated_at = CASE
          WHEN nodes.content_hash IS DISTINCT FROM excluded.content_hash
            OR nodes.node_type IS DISTINCT FROM excluded.node_type
            OR nodes.metadata IS DISTINCT FROM excluded.metadata
          THEN now()
          ELSE nodes.updated_at
        END
      RETURNING id, source_system, external_id, node_type, content_hash, metadata, (xmax = 0) AS inserted
    )
    -- xmax = 0 on the RETURNING row is the standard way to tell an
    -- INSERT ... ON CONFLICT DO UPDATE's freshly-inserted rows from its
    -- updated ones within the same statement (xmax is the row's deleting
    -- transaction id; 0 means "never deleted/updated", i.e. this row was
    -- just born). Combined with the pre-image from existing, this lets
    -- SQL — not application code — classify every row as created,
    -- updated, or unchanged, over the same three columns updated_at is
    -- conditioned on above.
    SELECT u.id, u.source_system, u.external_id,
      CASE
        WHEN u.inserted THEN 'created'
        WHEN e.old_content_hash IS DISTINCT FROM u.content_hash
          OR e.old_node_type IS DISTINCT FROM u.node_type
          OR e.old_metadata IS DISTINCT FROM u.metadata
        THEN 'updated'
        ELSE 'unchanged'
      END AS action
    FROM upsert u
    LEFT JOIN existing e ON e.source_system = u.source_system AND e.external_id = u.external_id
  `;
}

/**
 * UNSAFE-adjacent: not itself a validation gap, but part of the same
 * exported kit (see the "Unsafe internals" banner above) — carries the
 * `unsafe` marker so nothing in this group reads as an ordinary public
 * helper. Wraps a genuine database failure from `unsafeBuildUpsertNodesQuery`
 * as a typed `NodeUpsertFailedError`, identical to what `upsertNodes` does
 * internally.
 */
export function unsafeWrapNodeWriteError(err: unknown, rows: readonly PreparedNode[]): NodeUpsertFailedError {
  const start = rows[0]?.index ?? -1;
  const end = rows[rows.length - 1]?.index ?? -1;
  const pgInfo = formatPgInfo(asPgError(err));
  return new NodeUpsertFailedError(
    `node batch write failed for batch indexes ${start}-${end}${pgInfo}`,
    start,
    end,
    { cause: err },
  );
}

/**
 * Batch-upserts nodes on the `(source_system, external_id)` dedup key.
 * Runs in chunks of `options.chunkSize` `unnest(...)` statements, all
 * inside one transaction — any failure (validation, at the boundary, or
 * a database error mid-batch) rolls back everything written so far in
 * this call, and no partial batch is left for the caller to untangle.
 *
 * `content_hash` is computed here from `title`/`content`; callers never
 * supply it. Every returned row is classified `created` / `updated` /
 * `unchanged` by SQL (see unsafeBuildUpsertNodesQuery) — `unchanged` rows do
 * not advance `updated_at`.
 */
export async function upsertNodes(
  db: Database,
  run: IngestRunHandle,
  input: readonly NodeInput[],
  options: UpsertNodesOptions = {},
): Promise<UpsertNodesResult> {
  if (input.length === 0) {
    return { created: 0, updated: 0, unchanged: 0, rows: [] };
  }

  const chunkSize = options.chunkSize ?? DEFAULT_NODE_CHUNK_SIZE;
  const maxContentLength = options.maxContentLength ?? DEFAULT_MAX_CONTENT_LENGTH;
  const maxMetadataLength = options.maxMetadataLength ?? DEFAULT_MAX_METADATA_LENGTH;

  // Validate and hash the whole batch before any SQL runs — see
  // unsafePrepareNodes.
  const prepared = unsafePrepareNodes(input, maxContentLength, maxMetadataLength);
  const chunks = chunk(prepared, chunkSize);

  const result: UpsertNodesResult = { created: 0, updated: 0, unchanged: 0, rows: [] };

  await db.transaction(async (tx) => {
    for (const rows of chunks) {
      let queryResult: { rows: UpsertNodeRow[] };
      try {
        queryResult = await tx.execute<UpsertNodeRow>(unsafeBuildUpsertNodesQuery(rows, run.id));
      } catch (err) {
        throw unsafeWrapNodeWriteError(err, rows);
      }

      for (const row of queryResult.rows) {
        result.rows.push({ id: row.id, sourceSystem: row.source_system, externalId: row.external_id, action: row.action });
        result[row.action] += 1;
      }
    }
  });

  return result;
}
