// The six write procedures (bd-hmd.3, tasks.md 3.4): createNote,
// annotateNode, updateNodeContent, assertEdge, retractEdge, reweightEdge.
// Thin handlers over packages/core/src/human-writes.ts, which already
// attributes every write to an ingest run with source_system: "human".
// The one attribution this layer adds is the run's actor: the admitted
// token client (`ctx.client`, set by the dispatcher, never from input),
// passed as core's trailing option. On a read-only server
// (BRAIN_READ_ONLY, `ctx.readOnly`) every procedure is refused before it
// touches the database, as the inbox procedures are. Every argument is untrusted
// input from the browser, validated by `.input(schema)` before the
// resolver runs, and never interpolated as anything but a literal
// value/parameter by the core functions these call (there is no SQL
// passthrough anywhere in this server).
//
// bd-hmd.3 review, two fixes here:
//   - `title` had no length cap anywhere — not in Zod, not in core's
//     unsafePrepareNodes (fixed separately in packages/core; see
//     DEFAULT_MAX_TITLE_LENGTH's comment there). titleSchema below is
//     this layer's defense-in-depth counterpart, same relationship
//     metadataSchema already has to core's MetadataTooLargeError.
//   - `targetNodeId`/`nodeId` used a bare `z.string().min(1)` while the
//     edge procedures used the stricter uuid regex below — inconsistent
//     for no reason, since every one of these ids is a node id. Both now
//     use `uuidField`.

import { annotateNode, assertEdge, createNote, DEFAULT_MAX_METADATA_LENGTH, DEFAULT_MAX_TITLE_LENGTH, retractEdge, reweightEdge, updateNodeContent } from "@breakdown/core";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { Context } from "../context.js";
import { mapCoreError } from "../errors.js";
import { humanProcedure, router } from "../trpc.js";

function refuseIfReadOnly(ctx: Context): void {
  if (ctx.readOnly) throw new TRPCError({ code: "FORBIDDEN", message: "The server is read-only (BRAIN_READ_ONLY)." });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidField = z.string().regex(UUID_RE, "must be a valid uuid");

/** Zod-layer counterpart to core's `TitleTooLargeError` (`DEFAULT_MAX_TITLE_LENGTH`) — see the module header. */
const titleSchema = z.string().max(DEFAULT_MAX_TITLE_LENGTH, `title must be at most ${DEFAULT_MAX_TITLE_LENGTH} characters`);

/**
 * A `Record<string, unknown>` field capped at `DEFAULT_MAX_METADATA_LENGTH`
 * of serialized JSON — the Zod-layer counterpart to core's
 * `MetadataTooLargeError`, mirroring apps/mcp/src/tools/write.ts's
 * `boundedRecordSchema` (metadata is for small structured data, not
 * document content; this rejects an obviously-oversized value before it
 * reaches core at all, which still enforces the same limit itself).
 */
const metadataSchema = z
  .record(z.string(), z.unknown())
  .refine(
    (value) => JSON.stringify(value).length <= DEFAULT_MAX_METADATA_LENGTH,
    `metadata must serialize to at most ${DEFAULT_MAX_METADATA_LENGTH} characters — it is for small structured data, not documents`,
  );

// --- createNote --------------------------------------------------------

export const createNoteInputSchema = z.object({
  title: titleSchema.optional(),
  content: z.string().optional(),
  metadata: metadataSchema.optional(),
});

const createNoteProcedure = humanProcedure.input(createNoteInputSchema).mutation(async ({ ctx, input }) => {
  refuseIfReadOnly(ctx);
  try {
    return await createNote(ctx.db, input, { actor: ctx.client ?? undefined });
  } catch (err) {
    throw mapCoreError("createNote", err);
  }
});

// --- annotateNode --------------------------------------------------------

export const annotateNodeInputSchema = z.object({
  targetNodeId: uuidField,
  title: titleSchema.optional(),
  content: z.string().optional(),
  metadata: metadataSchema.optional(),
});

const annotateNodeProcedure = humanProcedure.input(annotateNodeInputSchema).mutation(async ({ ctx, input }) => {
  refuseIfReadOnly(ctx);
  try {
    return await annotateNode(ctx.db, input.targetNodeId, { title: input.title, content: input.content, metadata: input.metadata }, { actor: ctx.client ?? undefined });
  } catch (err) {
    throw mapCoreError("annotateNode", err);
  }
});

// --- updateNodeContent --------------------------------------------------

export const updateNodeContentInputSchema = z.object({
  nodeId: uuidField,
  title: titleSchema.optional(),
  content: z.string().optional(),
  metadata: metadataSchema.optional(),
});

const updateNodeContentProcedure = humanProcedure.input(updateNodeContentInputSchema).mutation(async ({ ctx, input }) => {
  refuseIfReadOnly(ctx);
  try {
    return await updateNodeContent(ctx.db, input.nodeId, { title: input.title, content: input.content, metadata: input.metadata }, { actor: ctx.client ?? undefined });
  } catch (err) {
    throw mapCoreError("updateNodeContent", err);
  }
});

// --- assertEdge ------------------------------------------------------------

const assertEdgeInputSchema = z.object({
  srcId: uuidField,
  dstId: uuidField,
  edgeType: z.string().min(1, "must not be empty"),
  weight: z.number().min(0).max(1).optional(),
  props: metadataSchema.optional(),
});

const assertEdgeProcedure = humanProcedure.input(assertEdgeInputSchema).mutation(async ({ ctx, input }) => {
  refuseIfReadOnly(ctx);
  try {
    return await assertEdge(ctx.db, input, { actor: ctx.client ?? undefined });
  } catch (err) {
    throw mapCoreError("assertEdge", err);
  }
});

// --- retractEdge ------------------------------------------------------------

const retractEdgeInputSchema = z.object({
  srcId: uuidField,
  dstId: uuidField,
  edgeType: z.string().min(1, "must not be empty"),
});

const retractEdgeProcedure = humanProcedure.input(retractEdgeInputSchema).mutation(async ({ ctx, input }) => {
  refuseIfReadOnly(ctx);
  try {
    return await retractEdge(ctx.db, input);
  } catch (err) {
    throw mapCoreError("retractEdge", err);
  }
});

// --- reweightEdge ------------------------------------------------------------

const reweightEdgeInputSchema = z.object({
  srcId: uuidField,
  dstId: uuidField,
  edgeType: z.string().min(1, "must not be empty"),
  weight: z.number().min(0).max(1),
});

const reweightEdgeProcedure = humanProcedure.input(reweightEdgeInputSchema).mutation(async ({ ctx, input }) => {
  refuseIfReadOnly(ctx);
  try {
    return await reweightEdge(ctx.db, input, { actor: ctx.client ?? undefined });
  } catch (err) {
    throw mapCoreError("reweightEdge", err);
  }
});

export const writeRouter = router({
  createNote: createNoteProcedure,
  annotateNode: annotateNodeProcedure,
  updateNodeContent: updateNodeContentProcedure,
  assertEdge: assertEdgeProcedure,
  retractEdge: retractEdgeProcedure,
  reweightEdge: reweightEdgeProcedure,
});
