import { eq, sql } from "drizzle-orm";
import type { Database } from "@breakdown/db";
import { edges, ingestRuns, nodes } from "@breakdown/db";
import { InvalidIngestRunError } from "./errors.js";
import { CONTROL_CHAR_CODE_POINTS } from "./nodes.js";

/**
 * Not exported. `IngestRunHandle` below carries this as a property key, so
 * the only way to produce a value that structurally satisfies the type is
 * to have this symbol in scope — which only `openIngestRun` does. A caller
 * cannot write `{ id: "...", sourceSystem: "..." }` and pass it off as a
 * handle; it has to actually open a run. This is what keeps
 * `upsertNodes`/`upsertEdges` from being called without one in practice,
 * on top of the schema's `ingest_run_id NOT NULL`.
 */
const INGEST_RUN_HANDLE: unique symbol = Symbol("IngestRunHandle");

/** Proof that an ingest run was opened via `openIngestRun`. See the symbol comment above. */
export interface IngestRunHandle {
  readonly id: string;
  readonly sourceSystem: string;
  readonly [INGEST_RUN_HANDLE]: true;
}

export interface ClosedIngestRun {
  id: string;
  sourceSystem: string;
  /** Who or what drove the run, as recorded at open — see `OpenIngestRunOptions.actor`. `null` when the run was opened without one. */
  actor: string | null;
  startedAt: Date;
  finishedAt: Date;
  nodeCount: number;
  edgeCount: number;
  stats: Record<string, unknown>;
}

export interface IngestRunContents {
  nodes: (typeof nodes.$inferSelect)[];
  edges: (typeof edges.$inferSelect)[];
}

export interface OpenIngestRunOptions {
  /**
   * Who or what drove the run — the connected MCP client's `name version`,
   * `human` from the web app, a loader's script name. Attribution, not
   * authentication: recorded stripped of control characters, cut to
   * `MAX_ACTOR_LENGTH`, and trimmed (see `sanitizeActor`). Distinct from
   * `sourceSystem`, which is the provenance of the content: one source
   * system can be written by many actors (knowledge-store spec, "Two agents
   * writing under one source system"). Empty/whitespace records no actor
   * rather than refusing the write — a missing identity is not a reason to
   * lose the data it came with.
   */
  actor?: string;
}

/**
 * Hard cap on a recorded actor, in code points. The value comes from the
 * MCP client's initialize handshake — client-controlled and unbounded —
 * so it is bounded here rather than trusted; 200 is far more than any real
 * `name version` pair needs.
 */
export const MAX_ACTOR_LENGTH = 200;

/**
 * Bounds and sanitises a caller-supplied actor: C0 control characters —
 * the same set nodes.ts strips from title/content; a NUL in particular is
 * legal JSON but rejected by Postgres text columns (22021), which would
 * otherwise fail every write from that client with an unwrapped driver
 * error — are dropped, then the result is cut to `MAX_ACTOR_LENGTH` code
 * points (never mid surrogate pair) and trimmed. Blank after that records
 * no actor. Truncating rather than rejecting is deliberate: a bad identity
 * string is not a reason to lose the data it came with.
 */
function sanitizeActor(actor: string | undefined): string | null {
  if (actor === undefined) return null;
  const kept: string[] = [];
  for (const char of actor) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined || CONTROL_CHAR_CODE_POINTS.has(codePoint)) continue;
    kept.push(char);
    if (kept.length === MAX_ACTOR_LENGTH) break;
  }
  return kept.join("").trim() || null;
}

/** Opens a new ingest run for `sourceSystem`. Every batch write needs one. */
export async function openIngestRun(db: Database, sourceSystem: string, options: OpenIngestRunOptions = {}): Promise<IngestRunHandle> {
  const trimmed = sourceSystem.trim();
  if (!trimmed) {
    throw new InvalidIngestRunError("sourceSystem must be a non-empty string");
  }

  const [row] = await db
    .insert(ingestRuns)
    .values({ sourceSystem: trimmed, actor: sanitizeActor(options.actor) })
    .returning({ id: ingestRuns.id, sourceSystem: ingestRuns.sourceSystem });
  if (!row) {
    throw new InvalidIngestRunError("openIngestRun: insert returned no row");
  }

  return {
    id: row.id,
    sourceSystem: row.sourceSystem,
    [INGEST_RUN_HANDLE]: true,
  } as IngestRunHandle;
}

// `db.execute()` returns the raw driver row, not drizzle's schema-mapped
// row — timestamptz columns come back as Postgres's text representation
// (e.g. "2026-09-01 01:15:07.238158+00"), not a parsed Date. Coerced to
// Date explicitly below.
type ClosedIngestRunRow = {
  id: string;
  source_system: string;
  actor: string | null;
  started_at: string;
  finished_at: string;
  node_count: number;
  edge_count: number;
  stats: Record<string, unknown>;
}

/**
 * Closes an ingest run: records `finished_at` and counts of the nodes and
 * edges currently attributed to it. Counts are recomputed from the
 * `nodes`/`edges` tables rather than trusted from the caller, so they
 * reflect what's actually in the database — including if the caller made
 * several `upsertNodes`/`upsertEdges` calls against the same run, or if a
 * later write from a *different* run has since re-touched one of this
 * run's rows (see the schema comment on `edges.ingest_run_id`: it records
 * the most recent run that asserted a row, so this reflects a point-in-time
 * snapshot at close, not a permanent tally).
 *
 * Idempotent: closing an already-closed run just recomputes and re-records
 * the same kind of snapshot; it does not error or duplicate anything.
 */
export async function closeIngestRun(
  db: Database,
  run: IngestRunHandle,
  stats?: Record<string, unknown>,
): Promise<ClosedIngestRun> {
  const result = await db.execute<ClosedIngestRunRow>(sql`
    UPDATE ingest_runs
    SET finished_at = now(),
        node_count = (SELECT count(*)::int FROM nodes WHERE nodes.ingest_run_id = ingest_runs.id),
        edge_count = (SELECT count(*)::int FROM edges WHERE edges.ingest_run_id = ingest_runs.id),
        stats = COALESCE(${stats ? JSON.stringify(stats) : null}::jsonb, ingest_runs.stats)
    WHERE id = ${run.id}
    RETURNING id, source_system, actor, started_at, finished_at, node_count, edge_count, stats
  `);

  const row = result.rows[0];
  if (!row) {
    throw new InvalidIngestRunError(`closeIngestRun: run ${run.id} does not exist`);
  }

  return {
    id: row.id,
    sourceSystem: row.source_system,
    actor: row.actor,
    startedAt: new Date(row.started_at),
    // `finished_at` was just set by this statement's `now()`, so it is
    // never null here.
    finishedAt: new Date(row.finished_at),
    nodeCount: row.node_count,
    edgeCount: row.edge_count,
    stats: row.stats,
  };
}

/**
 * Everything a given ingest run produced: its nodes and its edges, as
 * currently attributed to it (see the `closeIngestRun` comment on what
 * "attributed" means). Accepts a plain run id — not an `IngestRunHandle`
 * — since this is a read-only audit query an operator may run against any
 * run id, including one from a run that has already been closed, or one
 * they only have a bare id string for.
 */
export async function getIngestRunContents(db: Database, runId: string): Promise<IngestRunContents> {
  const [nodeRows, edgeRows] = await Promise.all([
    db.select().from(nodes).where(eq(nodes.ingestRunId, runId)),
    db.select().from(edges).where(eq(edges.ingestRunId, runId)),
  ]);
  return { nodes: nodeRows, edges: edgeRows };
}
