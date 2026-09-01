import { sql } from "drizzle-orm";
import type { Database } from "@breakdown/db";
import {
  DuplicateEdgeInBatchError,
  EdgeUpsertFailedError,
  InvalidEdgeInputError,
  InvalidEdgeWeightError,
} from "./errors.js";
import type { IngestRunHandle } from "./ingest-runs.js";
import { asPgError, chunk, formatPgInfo, sqlArray } from "./sql-helpers.js";

/** Default chunk size for the `unnest(...)` batch upsert — see design.md "Writes". */
export const DEFAULT_EDGE_CHUNK_SIZE = 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface EdgeInput {
  srcId: string;
  dstId: string;
  edgeType: string;
  sourceSystem: string;
  /** Confidence weight in [0, 1]. Default 1.0 (matches the column default). */
  weight?: number;
  props?: Record<string, unknown>;
}

export interface UpsertEdgesOptions {
  /** Rows per `unnest(...)` statement. Default `DEFAULT_EDGE_CHUNK_SIZE` (1000). */
  chunkSize?: number;
}

export type EdgeUpsertAction = "created" | "updated";

export interface EdgeUpsertResultRow {
  id: string;
  srcId: string;
  dstId: string;
  edgeType: string;
  sourceSystem: string;
  action: EdgeUpsertAction;
}

export interface UpsertEdgesResult {
  created: number;
  updated: number;
  rows: EdgeUpsertResultRow[];
}

// --- Unsafe internals (exported for human-writes.ts only) ------------------
//
// Everything below named `unsafe*` — PreparedEdge, unsafePrepareEdges,
// unsafeBuildUpsertEdgesQuery, unsafeWrapEdgeWriteError — exists to let
// `human-writes.ts` compose an edge insert into a hand-built transaction
// alongside a node insert (`annotateNode`) or without opening its own
// ingest run first (`reweightEdge`). It is NOT a second public write API.
//
// Unlike nodes.ts's unsafe kit, weight IS backstopped by the database —
// `edges_weight_range_check` catches an out-of-range weight even if
// `unsafePrepareEdges` is skipped. But `edgeType`/`sourceSystem`/`props`
// have no equivalent CHECK, and calling `unsafeBuildUpsertEdgesQuery`
// with a hand-built `PreparedEdge` (not the output of
// `unsafePrepareEdges`) bypasses the uuid-shape and non-empty-string
// checks all the same. Carries the same `unsafe` marker as the nodes.ts
// kit so nothing in either group reads as an ordinary public helper.
// Never call any of these from outside this package; use `upsertEdges`.

export interface PreparedEdge {
  index: number;
  srcId: string;
  dstId: string;
  edgeType: string;
  sourceSystem: string;
  weight: number;
  propsJson: string;
}

/**
 * Validates every row before any SQL runs — including weight range, which
 * the knowledge-store spec requires to be rejected "before hitting the
 * database with an error that names the offending edge" (a bare
 * `edges_weight_range_check` violation is not actionable enough for an
 * agent calling this over MCP).
 *
 * Exported (as `unsafePrepareEdges`, alongside `unsafeBuildUpsertEdgesQuery`/
 * `unsafeWrapEdgeWriteError`) so `human-writes.ts`'s `annotateNode` and
 * `reweightEdge`/`retractEdge` can reuse this exact validation — including
 * `InvalidEdgeWeightError`'s "naming the edge" contract — rather than
 * re-deriving it, and so `annotateNode` can compose a note insert and its
 * edge insert into one hand-built transaction (upsertEdges always opens
 * its own). See the "Unsafe internals" banner above for what calling
 * `unsafeBuildUpsertEdgesQuery` without this first would skip.
 */
export function unsafePrepareEdges(input: readonly EdgeInput[]): PreparedEdge[] {
  const prepared: PreparedEdge[] = [];
  const seen = new Map<string, number>();

  input.forEach((e, index) => {
    const srcId = e.srcId.trim();
    const dstId = e.dstId.trim();
    const edgeType = e.edgeType.trim();
    const sourceSystem = e.sourceSystem.trim();

    if (!UUID_RE.test(srcId)) {
      throw new InvalidEdgeInputError(`srcId ${JSON.stringify(e.srcId)} is not a valid uuid`, index, srcId, dstId, edgeType, sourceSystem);
    }
    if (!UUID_RE.test(dstId)) {
      throw new InvalidEdgeInputError(`dstId ${JSON.stringify(e.dstId)} is not a valid uuid`, index, srcId, dstId, edgeType, sourceSystem);
    }
    if (!edgeType) {
      throw new InvalidEdgeInputError("edgeType must be a non-empty string", index, srcId, dstId, edgeType, sourceSystem);
    }
    if (!sourceSystem) {
      throw new InvalidEdgeInputError("sourceSystem must be a non-empty string", index, srcId, dstId, edgeType, sourceSystem);
    }

    const weight = e.weight ?? 1.0;
    if (!Number.isFinite(weight) || weight < 0 || weight > 1) {
      throw new InvalidEdgeWeightError(index, srcId, dstId, edgeType, sourceSystem, weight);
    }

    const key = `${srcId} ${dstId} ${edgeType} ${sourceSystem}`;
    const firstIndex = seen.get(key);
    if (firstIndex !== undefined) {
      throw new DuplicateEdgeInBatchError(srcId, dstId, edgeType, sourceSystem, firstIndex, index);
    }
    seen.set(key, index);

    prepared.push({
      index,
      srcId,
      dstId,
      edgeType,
      sourceSystem,
      weight,
      propsJson: JSON.stringify(e.props ?? {}),
    });
  });

  return prepared;
}

export type UpsertEdgeRow = {
  id: string;
  src_id: string;
  dst_id: string;
  edge_type: string;
  source_system: string;
  action: EdgeUpsertAction;
}

/**
 * UNSAFE: writes `rows` to the database trusting every field is already
 * validated — it does not re-check uuid shape, non-empty `edgeType`/
 * `sourceSystem`, or weight range (weight alone has a database-level
 * backstop, `edges_weight_range_check`; the rest do not). Always call
 * `unsafePrepareEdges` first and pass its output straight through. See
 * the "Unsafe internals" banner above.
 */
export function unsafeBuildUpsertEdgesQuery(rows: readonly PreparedEdge[], ingestRunId: string) {
  return sql`
    WITH input(src_id, dst_id, edge_type, source_system, weight, props) AS (
      SELECT * FROM unnest(
        ${sqlArray(rows.map((r) => r.srcId), "uuid")},
        ${sqlArray(rows.map((r) => r.dstId), "uuid")},
        ${sqlArray(rows.map((r) => r.edgeType), "text")},
        ${sqlArray(rows.map((r) => r.sourceSystem), "text")},
        ${sqlArray(rows.map((r) => r.weight), "real")},
        ${sqlArray(rows.map((r) => r.propsJson), "jsonb")}
      )
    ),
    upsert AS (
      INSERT INTO edges (src_id, dst_id, edge_type, source_system, weight, props, ingest_run_id)
      SELECT src_id, dst_id, edge_type, source_system, weight, props, ${ingestRunId}::uuid
      FROM input
      -- Collapses re-assertion by one source system to a single row
      -- (knowledge-store spec, "Same relationship asserted twice by one
      -- source"); a different source_system is a distinct row under the
      -- same unique constraint, so it is retained separately.
      ON CONFLICT (src_id, dst_id, edge_type, source_system) DO UPDATE SET
        weight = excluded.weight,
        props = excluded.props,
        ingest_run_id = excluded.ingest_run_id
      RETURNING id, src_id, dst_id, edge_type, source_system, (xmax = 0) AS inserted
    )
    SELECT id, src_id, dst_id, edge_type, source_system,
      CASE WHEN inserted THEN 'created' ELSE 'updated' END AS action
    FROM upsert
  `;
}

/**
 * On a genuine database-level failure (e.g. src_id/dst_id referencing a
 * node that does not exist — an FK violation, since this is the one
 * failure mode boundary validation can't catch without an extra
 * existence-check query), tries to identify the offending edge from
 * Postgres's own error detail (`Key (src_id)=(<uuid>) is not present...`)
 * rather than surfacing only the constraint name.
 *
 * UNSAFE-adjacent: not itself a validation gap, but part of the same
 * exported kit (see the "Unsafe internals" banner above) — carries the
 * `unsafe` marker so nothing in this group reads as an ordinary public
 * helper. Wraps a genuine database failure from `unsafeBuildUpsertEdgesQuery`
 * as a typed `EdgeUpsertFailedError`, identical to what `upsertEdges` does
 * internally.
 */
export function unsafeWrapEdgeWriteError(err: unknown, rows: readonly PreparedEdge[]): EdgeUpsertFailedError {
  const start = rows[0]?.index ?? -1;
  const end = rows[rows.length - 1]?.index ?? -1;
  const pg = asPgError(err);

  let offending: PreparedEdge | undefined;
  if (pg?.detail) {
    const match = /Key \((src_id|dst_id)\)=\(([0-9a-fA-F-]+)\)/.exec(pg.detail);
    if (match) {
      const [, column, value] = match;
      offending = rows.find((r) => (column === "src_id" ? r.srcId : r.dstId) === value);
    }
  }

  const pgInfo = formatPgInfo(pg);
  const message = offending
    ? `edge ${offending.srcId} -[${offending.edgeType}]-> ${offending.dstId} (source_system=${offending.sourceSystem}, batch index ${offending.index}) failed to write${pgInfo}`
    : `edge batch write failed for batch indexes ${start}-${end}${pgInfo}`;

  return new EdgeUpsertFailedError(message, start, end, { cause: err });
}

/**
 * Batch-upserts edges on the `(src_id, dst_id, edge_type, source_system)`
 * dedup key. Runs in chunks of `options.chunkSize` `unnest(...)`
 * statements, all inside one transaction — any failure rolls back
 * everything written so far in this call.
 *
 * Weight is validated against [0, 1] before any SQL runs, naming the
 * offending edge on rejection. Edges have no `unchanged` state to report
 * (unlike nodes, they carry no timestamp that must be preserved) — a
 * conflicting row is simply `updated`.
 */
export async function upsertEdges(
  db: Database,
  run: IngestRunHandle,
  input: readonly EdgeInput[],
  options: UpsertEdgesOptions = {},
): Promise<UpsertEdgesResult> {
  if (input.length === 0) {
    return { created: 0, updated: 0, rows: [] };
  }

  const chunkSize = options.chunkSize ?? DEFAULT_EDGE_CHUNK_SIZE;

  // Validate the whole batch before any SQL runs — see unsafePrepareEdges.
  const prepared = unsafePrepareEdges(input);
  const chunks = chunk(prepared, chunkSize);

  const result: UpsertEdgesResult = { created: 0, updated: 0, rows: [] };

  await db.transaction(async (tx) => {
    for (const rows of chunks) {
      let queryResult: { rows: UpsertEdgeRow[] };
      try {
        queryResult = await tx.execute<UpsertEdgeRow>(unsafeBuildUpsertEdgesQuery(rows, run.id));
      } catch (err) {
        throw unsafeWrapEdgeWriteError(err, rows);
      }

      for (const row of queryResult.rows) {
        result.rows.push({
          id: row.id,
          srcId: row.src_id,
          dstId: row.dst_id,
          edgeType: row.edge_type,
          sourceSystem: row.source_system,
          action: row.action,
        });
        result[row.action] += 1;
      }
    }
  });

  return result;
}
