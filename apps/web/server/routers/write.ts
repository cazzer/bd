// The six write procedures (bd-hmd.3, tasks.md 3.4): createNote,
// annotateNode, updateNodeContent, assertEdge, retractEdge, reweightEdge.
// Thin handlers over packages/core/src/human-writes.ts, which already
// attributes every write to an ingest run with source_system: "human" —
// nothing here manages attribution itself. Every argument is untrusted
// input from the browser, validated by `.input(schema)` before the
// resolver runs, and never interpolated as anything but a literal
// value/parameter by the core functions these call (there is no SQL
// passthrough anywhere in this server).

import { annotateNode, assertEdge, createNote, DEFAULT_MAX_METADATA_LENGTH, retractEdge, reweightEdge, updateNodeContent } from "@breakdown/core";
import { z } from "zod";
import { mapCoreError } from "../errors.js";
import { publicProcedure, router } from "../trpc.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidField = z.string().regex(UUID_RE, "must be a valid uuid");

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

const createNoteInputSchema = z.object({
  title: z.string().optional(),
  content: z.string().optional(),
  metadata: metadataSchema.optional(),
});

const createNoteProcedure = publicProcedure.input(createNoteInputSchema).mutation(async ({ ctx, input }) => {
  try {
    return await createNote(ctx.db, input);
  } catch (err) {
    throw mapCoreError("createNote", err);
  }
});

// --- annotateNode --------------------------------------------------------

const annotateNodeInputSchema = z.object({
  targetNodeId: z.string().min(1, "must not be empty"),
  title: z.string().optional(),
  content: z.string().optional(),
  metadata: metadataSchema.optional(),
});

const annotateNodeProcedure = publicProcedure.input(annotateNodeInputSchema).mutation(async ({ ctx, input }) => {
  try {
    return await annotateNode(ctx.db, input.targetNodeId, { title: input.title, content: input.content, metadata: input.metadata });
  } catch (err) {
    throw mapCoreError("annotateNode", err);
  }
});

// --- updateNodeContent --------------------------------------------------

const updateNodeContentInputSchema = z.object({
  nodeId: z.string().min(1, "must not be empty"),
  title: z.string().optional(),
  content: z.string().optional(),
  metadata: metadataSchema.optional(),
});

const updateNodeContentProcedure = publicProcedure.input(updateNodeContentInputSchema).mutation(async ({ ctx, input }) => {
  try {
    return await updateNodeContent(ctx.db, input.nodeId, { title: input.title, content: input.content, metadata: input.metadata });
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

const assertEdgeProcedure = publicProcedure.input(assertEdgeInputSchema).mutation(async ({ ctx, input }) => {
  try {
    return await assertEdge(ctx.db, input);
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

const retractEdgeProcedure = publicProcedure.input(retractEdgeInputSchema).mutation(async ({ ctx, input }) => {
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

const reweightEdgeProcedure = publicProcedure.input(reweightEdgeInputSchema).mutation(async ({ ctx, input }) => {
  try {
    return await reweightEdge(ctx.db, input);
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
