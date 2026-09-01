/**
 * The write functions a person needs (bd-hmd.2, knowledge-store spec:
 * "People are a distinct authoring source", "Notes can annotate an
 * existing node", "Edges can be asserted, retracted, and reweighted by
 * hand"). Every write here is attributed to an ingest run with
 * `source_system: HUMAN_SOURCE_SYSTEM` ("human") — the same
 * per-call-attribution shape `apps/mcp/src/attribution.ts`'s
 * `withAgentIngestRun` already gives agent writes, so a bad round of
 * human edits is identifiable and revertible as a unit via
 * `getIngestRunContents`.
 *
 * Every function below goes through the existing write path
 * (`upsertNodes`/`upsertEdges`, or — for `annotateNode`, which needs a
 * note and its edge to commit or roll back together — the exact
 * validation/query-building internals those two functions are built on,
 * `prepareNodes`/`buildUpsertNodesQuery`/`prepareEdges`/
 * `buildUpsertEdgesQuery`). Nothing here hand-rolls an INSERT/UPDATE that
 * bypasses that validation, deduplication, or attribution.
 */

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Database } from "@breakdown/db";
import { edges, nodes } from "@breakdown/db";
import { isEditableSourceSystem } from "./editability.js";
import {
  EdgeNotFoundError,
  EdgeUpsertFailedError,
  InvalidLookupIdError,
  NodeNotEditableError,
  NodeNotFoundError,
  NodeUpsertFailedError,
} from "./errors.js";
import {
  buildUpsertEdgesQuery,
  prepareEdges,
  upsertEdges,
  wrapEdgeWriteError,
  type EdgeUpsertAction,
  type UpsertEdgeRow,
} from "./edges.js";
import { closeIngestRun, openIngestRun, type IngestRunHandle } from "./ingest-runs.js";
import {
  buildUpsertNodesQuery,
  prepareNodes,
  upsertNodes,
  wrapNodeWriteError,
  DEFAULT_MAX_CONTENT_LENGTH,
  DEFAULT_MAX_METADATA_LENGTH,
  type NodeInput,
  type NodeUpsertAction,
  type UpsertNodeRow,
} from "./nodes.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The `source_system` every function in this module attributes its ingest run — and, for note/edge creation, the row itself — to. See the module header. */
export const HUMAN_SOURCE_SYSTEM = "human";

/** `node_type` for a person-authored note. Requires no migration — `node_type` is open text by design (see design.md, "Repo-sourced nodes are read-only"). */
export const NOTE_NODE_TYPE = "note";

/** `edge_type` for the edge an annotation creates, `note ---annotates---> target`. */
export const ANNOTATES_EDGE_TYPE = "annotates";

/**
 * Opens an ingest run attributed to `HUMAN_SOURCE_SYSTEM`, runs `fn` with
 * the handle, and always closes the run afterward — including when `fn`
 * throws — mirroring `apps/mcp/src/attribution.ts`'s `withAgentIngestRun`
 * exactly, so a human write and an agent write are revertible-as-a-unit
 * the same way.
 */
async function withHumanIngestRun<T>(db: Database, fn: (run: IngestRunHandle) => Promise<T>): Promise<{ ingestRunId: string; result: T }> {
  const run = await openIngestRun(db, HUMAN_SOURCE_SYSTEM);
  try {
    const result = await fn(run);
    return { ingestRunId: run.id, result };
  } finally {
    await closeIngestRun(db, run);
  }
}

/**
 * A note's `external_id`: `note-<uuid>`, generated fresh for every call.
 * Stable — once assigned it never changes for that note's lifetime,
 * since `updateNodeContent` (below) reuses the row's existing
 * `external_id` rather than regenerating one — and non-colliding: a
 * `crypto.randomUUID()` v4 UUID has 122 bits of randomness, the same
 * collision guarantee every node/edge primary key in this schema already
 * relies on (`uuid("id").defaultRandom()`), so two notes independently
 * generating the same external_id is not a realistic failure mode. The
 * `note-` prefix is cosmetic — it makes a note's external_id
 * recognizable in `brain_get`/`getNodes` output or ad-hoc SQL without
 * needing to also check node_type.
 */
function generateNoteExternalId(): string {
  return `note-${randomUUID()}`;
}

function trimmedUuid(value: string, label: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!UUID_RE.test(trimmed)) {
    throw new InvalidLookupIdError(value, `${label} must be a valid uuid`);
  }
  return trimmed;
}

// --- Note creation (task 2.1) ----------------------------------------------

export interface CreateNoteInput {
  title?: string;
  content?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateNoteResult {
  id: string;
  externalId: string;
  ingestRunId: string;
}

/**
 * Creates a standalone `note` node — no edges. Attributed to a fresh
 * `HUMAN_SOURCE_SYSTEM` ingest run; content/title/metadata are validated
 * exactly as any other node write is (`upsertNodes`), so oversized
 * content or a control character is rejected the same way regardless of
 * who wrote it (knowledge-store spec, "A person's write is validated
 * like any other").
 *
 * For a note that annotates an existing node, use `annotateNode` instead
 * — it creates the note and its `annotates` edge together, in one
 * transaction.
 */
export async function createNote(db: Database, input: CreateNoteInput = {}): Promise<CreateNoteResult> {
  const externalId = generateNoteExternalId();
  const nodeInput: NodeInput = {
    nodeType: NOTE_NODE_TYPE,
    sourceSystem: HUMAN_SOURCE_SYSTEM,
    externalId,
    title: input.title,
    content: input.content,
    metadata: input.metadata,
  };

  const { ingestRunId, result } = await withHumanIngestRun(db, (run) => upsertNodes(db, run, [nodeInput]));
  const row = result.rows[0];
  if (!row) {
    // upsertNodes was called with exactly one input row — it always
    // returns exactly one result row, or throws. This is unreachable in
    // practice; guarded so a future refactor that breaks that invariant
    // fails loudly here instead of returning a broken result.
    throw new NodeUpsertFailedError(`createNote: upsert returned no row for external_id ${externalId}`, 0, 0);
  }

  return { id: row.id, externalId: row.externalId, ingestRunId };
}

// --- Annotation (task 2.2) --------------------------------------------------

export interface AnnotateNodeInput {
  title?: string;
  content?: string;
  metadata?: Record<string, unknown>;
}

export interface AnnotateNodeResult {
  noteId: string;
  noteExternalId: string;
  annotationEdgeId: string;
  ingestRunId: string;
}

/**
 * Creates a note and the `annotates` edge joining it to `targetNodeId`
 * (`note ---annotates---> target`), in one Postgres transaction: if the
 * edge insert fails, the note insert is rolled back with it — no orphan
 * note is ever left behind. Permitted regardless of the target's
 * `source_system` (knowledge-store spec: "Annotation SHALL be permitted
 * regardless of the annotated node's source system") — annotating a
 * file-backed (e.g. `repo`) node is exactly the intended escape valve for
 * content that itself can't be edited (design.md, "Repo-sourced nodes are
 * read-only").
 *
 * Never touches the target row itself — only reads it, to confirm it
 * exists before creating anything — so the target's own `content` and
 * `content_hash` are byte-for-byte unchanged. That is what lets a later
 * `db:seed` re-run over the unchanged source file still report the node
 * `unchanged` (not `updated`) with the annotation and its edge intact.
 *
 * Throws `NodeNotFoundError` if `targetNodeId` does not exist. Note
 * validation (content length, control characters, metadata size) reuses
 * `prepareNodes` — the exact function `upsertNodes` itself validates
 * with — and edge validation reuses `prepareEdges` the same way, so
 * nothing here bypasses that path.
 */
export async function annotateNode(db: Database, targetNodeId: string, input: AnnotateNodeInput = {}): Promise<AnnotateNodeResult> {
  const trimmedTarget = trimmedUuid(targetNodeId, "targetNodeId");

  const externalId = generateNoteExternalId();
  const preparedNotes = prepareNodes(
    [
      {
        nodeType: NOTE_NODE_TYPE,
        sourceSystem: HUMAN_SOURCE_SYSTEM,
        externalId,
        title: input.title,
        content: input.content,
        metadata: input.metadata,
      },
    ],
    DEFAULT_MAX_CONTENT_LENGTH,
    DEFAULT_MAX_METADATA_LENGTH,
  );

  const { ingestRunId, result } = await withHumanIngestRun(db, (run) =>
    db.transaction(async (tx) => {
      // Boundary check before creating anything: a named NodeNotFoundError,
      // not an opaque foreign-key violation surfacing out of the edge
      // insert below.
      const targetRows = await tx.select({ id: nodes.id }).from(nodes).where(eq(nodes.id, trimmedTarget));
      if (targetRows.length === 0) {
        throw new NodeNotFoundError(trimmedTarget);
      }

      let noteQueryResult: { rows: UpsertNodeRow[] };
      try {
        noteQueryResult = await tx.execute<UpsertNodeRow>(buildUpsertNodesQuery(preparedNotes, run.id));
      } catch (err) {
        throw wrapNodeWriteError(err, preparedNotes);
      }
      const noteRow = noteQueryResult.rows[0];
      if (!noteRow) {
        throw new NodeUpsertFailedError(`annotateNode: note upsert returned no row for external_id ${externalId}`, 0, 0);
      }

      const preparedEdges = prepareEdges([
        { srcId: noteRow.id, dstId: trimmedTarget, edgeType: ANNOTATES_EDGE_TYPE, sourceSystem: HUMAN_SOURCE_SYSTEM },
      ]);

      let edgeQueryResult: { rows: UpsertEdgeRow[] };
      try {
        edgeQueryResult = await tx.execute<UpsertEdgeRow>(buildUpsertEdgesQuery(preparedEdges, run.id));
      } catch (err) {
        // Rethrown, not caught-and-swallowed: this throw is what makes the
        // surrounding db.transaction() roll back, undoing the note insert
        // above. Nothing about that node ever becomes visible to another
        // transaction.
        throw wrapEdgeWriteError(err, preparedEdges);
      }
      const edgeRow = edgeQueryResult.rows[0];
      if (!edgeRow) {
        throw new EdgeUpsertFailedError(`annotateNode: edge upsert returned no row for note ${noteRow.id}`, 0, 0);
      }

      return { noteId: noteRow.id, noteExternalId: noteRow.external_id, annotationEdgeId: edgeRow.id };
    }),
  );

  return { ...result, ingestRunId };
}

// --- Content update (task 2.3) ---------------------------------------------

export interface UpdateNodeContentInput {
  title?: string;
  content?: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateNodeContentResult {
  id: string;
  action: NodeUpsertAction;
  ingestRunId: string;
}

/**
 * Updates an existing node's title/content/metadata — whichever of the
 * three `input` supplies; any field left `undefined` keeps its current
 * value rather than being cleared. Refuses to edit a node whose
 * `source_system` is not `"human"` or `"agent"` (see
 * `isEditableSourceSystem` in editability.ts, the one place this rule is
 * defined) with a named `NodeNotEditableError` identifying the node and
 * its actual source system — never a generic failure.
 *
 * Reuses `upsertNodes` for the actual write (same `(source_system,
 * external_id)` dedup key, same content-hash/validation path, same
 * `created`/`updated`/`unchanged` classification), which is what keeps a
 * human edit and a loader's re-write of the same node consistent with
 * each other.
 */
export async function updateNodeContent(db: Database, nodeId: string, input: UpdateNodeContentInput = {}): Promise<UpdateNodeContentResult> {
  const trimmedId = trimmedUuid(nodeId, "nodeId");

  const [existing] = await db
    .select({
      nodeType: nodes.nodeType,
      sourceSystem: nodes.sourceSystem,
      externalId: nodes.externalId,
      title: nodes.title,
      content: nodes.content,
      metadata: nodes.metadata,
    })
    .from(nodes)
    .where(eq(nodes.id, trimmedId));
  if (!existing) {
    throw new NodeNotFoundError(trimmedId);
  }
  if (!isEditableSourceSystem(existing.sourceSystem)) {
    throw new NodeNotEditableError(trimmedId, existing.sourceSystem);
  }

  const merged: NodeInput = {
    nodeType: existing.nodeType,
    sourceSystem: existing.sourceSystem,
    externalId: existing.externalId,
    title: input.title ?? existing.title,
    content: input.content ?? existing.content,
    metadata: input.metadata ?? (existing.metadata as Record<string, unknown>),
  };

  const { ingestRunId, result } = await withHumanIngestRun(db, (run) => upsertNodes(db, run, [merged]));
  const row = result.rows[0];
  if (!row) {
    throw new NodeUpsertFailedError(`updateNodeContent: upsert returned no row for node ${trimmedId}`, 0, 0);
  }

  return { id: row.id, action: row.action, ingestRunId };
}

// --- Edge assert / retract / reweight (task 2.4) ----------------------------

export interface AssertEdgeInput {
  srcId: string;
  dstId: string;
  edgeType: string;
  /** Confidence weight in [0, 1]. Default 1.0. */
  weight?: number;
  props?: Record<string, unknown>;
}

export interface AssertEdgeResult {
  id: string;
  action: EdgeUpsertAction;
  ingestRunId: string;
}

/**
 * Asserts an edge attributed to `HUMAN_SOURCE_SYSTEM`. Re-asserting a
 * relationship already asserted by a person is a no-op at the data level
 * — `upsertEdges`'s `(src_id, dst_id, edge_type, source_system)` dedup
 * key means this just re-writes the same row (weight/props included when
 * unchanged) rather than creating a duplicate or erroring
 * (knowledge-store spec, "Asserting an edge that already exists from the
 * same source").
 */
export async function assertEdge(db: Database, input: AssertEdgeInput): Promise<AssertEdgeResult> {
  const { ingestRunId, result } = await withHumanIngestRun(db, (run) =>
    upsertEdges(db, run, [
      { srcId: input.srcId, dstId: input.dstId, edgeType: input.edgeType, sourceSystem: HUMAN_SOURCE_SYSTEM, weight: input.weight, props: input.props },
    ]),
  );
  const row = result.rows[0];
  if (!row) {
    throw new EdgeUpsertFailedError("assertEdge: upsert returned no row", 0, 0);
  }

  return { id: row.id, action: row.action, ingestRunId };
}

export interface RetractEdgeInput {
  srcId: string;
  dstId: string;
  edgeType: string;
}

export interface RetractEdgeResult {
  /** True if a human-asserted edge existed and was removed; false if there was nothing to remove. */
  retracted: boolean;
}

/**
 * Removes only the assertion of `srcId -[edgeType]-> dstId` made by
 * `HUMAN_SOURCE_SYSTEM` — the `DELETE` is scoped to
 * `source_system = 'human'` in the same `WHERE` clause as the rest of the
 * unique key, so a loader's or an agent's assertion of the identical
 * relationship (a distinct row under that same key) is untouched and the
 * relationship remains present from that source (knowledge-store spec,
 * "Retracting a hand-authored edge leaves other sources alone").
 *
 * Idempotent, deliberately: retracting an edge that was already retracted
 * (or never asserted by a human at all) is not an error, just
 * `{ retracted: false }` — the caller's desired end state (no such
 * human-authored edge) already holds, and a retry after a dropped
 * response must not fail. This is a plain `DELETE`, so — unlike every
 * other write in this module — there is no persisted row left to carry an
 * `ingest_run_id`; nothing is opened here to attribute it to.
 */
export async function retractEdge(db: Database, input: RetractEdgeInput): Promise<RetractEdgeResult> {
  // Reuses prepareEdges purely for its boundary validation (uuid shape,
  // non-empty edgeType) — the weight it fills in with a default is
  // irrelevant here and never used.
  const [prepared] = prepareEdges([{ srcId: input.srcId, dstId: input.dstId, edgeType: input.edgeType, sourceSystem: HUMAN_SOURCE_SYSTEM }]);
  if (!prepared) {
    throw new EdgeUpsertFailedError("retractEdge: validation produced no row", 0, 0);
  }

  const deleted = await db
    .delete(edges)
    .where(
      and(
        eq(edges.srcId, prepared.srcId),
        eq(edges.dstId, prepared.dstId),
        eq(edges.edgeType, prepared.edgeType),
        eq(edges.sourceSystem, HUMAN_SOURCE_SYSTEM),
      ),
    )
    .returning({ id: edges.id });

  return { retracted: deleted.length > 0 };
}

export interface ReweightEdgeInput {
  srcId: string;
  dstId: string;
  edgeType: string;
  /** New confidence weight in [0, 1]. */
  weight: number;
}

export interface ReweightEdgeResult {
  id: string;
  weight: number;
  ingestRunId: string;
}

/**
 * Changes the weight of an edge the caller (`HUMAN_SOURCE_SYSTEM`)
 * asserted. An out-of-range weight is rejected by `prepareEdges` — the
 * same `InvalidEdgeWeightError` `upsertEdges` throws, naming the edge —
 * before any SQL runs. Unlike `assertEdge`, this never creates a row: if
 * no edge asserted by a person matches `(srcId, dstId, edgeType)`, it
 * throws `EdgeNotFoundError` rather than silently asserting a new one —
 * a caller reweighting an edge they believe already exists deserves a
 * loud failure, not a surprise creation (role lens: "fail loudly").
 */
export async function reweightEdge(db: Database, input: ReweightEdgeInput): Promise<ReweightEdgeResult> {
  const [prepared] = prepareEdges([
    { srcId: input.srcId, dstId: input.dstId, edgeType: input.edgeType, sourceSystem: HUMAN_SOURCE_SYSTEM, weight: input.weight },
  ]);
  if (!prepared) {
    throw new EdgeUpsertFailedError("reweightEdge: validation produced no row", 0, 0);
  }

  const { ingestRunId, result } = await withHumanIngestRun(db, async (run) => {
    const [row] = await db
      .update(edges)
      .set({ weight: prepared.weight, ingestRunId: run.id })
      .where(
        and(
          eq(edges.srcId, prepared.srcId),
          eq(edges.dstId, prepared.dstId),
          eq(edges.edgeType, prepared.edgeType),
          eq(edges.sourceSystem, HUMAN_SOURCE_SYSTEM),
        ),
      )
      .returning({ id: edges.id, weight: edges.weight });
    return row;
  });

  if (!result) {
    throw new EdgeNotFoundError(prepared.srcId, prepared.dstId, prepared.edgeType, HUMAN_SOURCE_SYSTEM);
  }

  return { id: result.id, weight: result.weight, ingestRunId };
}
