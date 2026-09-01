// The three write tools: brain_write, brain_link, brain_merge. Every
// argument here is untrusted model output — validated by `schema` before
// the handler runs (server.ts), and never interpolated as anything but
// literal text/parameter values by the `@breakdown/core` functions these
// call (there is no SQL passthrough anywhere in this server).
//
// brain_write/brain_link wrap their per-item schema in a top-level
// `{ items: ... }` object rather than accepting a bare array or union at
// the top level: MCP tool call arguments are always a JSON object, so a
// tool's input schema must be `type: "object"` — the "single item or a
// batch in one call" flexibility the spec asks for lives in the `items`
// field's own union, not at the argument root.

import type { EdgeInput, NodeInput } from "@breakdown/core";
import { DEFAULT_MAX_METADATA_LENGTH, mergeNodes, upsertEdges, upsertNodes } from "@breakdown/core";
import { z } from "zod";
import { AGENT_SOURCE_SYSTEM, withAgentIngestRun } from "../attribution.js";
import { boundResponse } from "../budget.js";
import type { ToolContext, ToolDef } from "../types.js";

function toArray<T>(value: T | readonly T[]): T[] {
  return Array.isArray(value) ? value : [value as T];
}

/**
 * Hard ceiling on how many items one brain_write/brain_link call — or one
 * brain_get lookup — can carry (bd-vt2.5 review: an unbounded batch of
 * 30,000 items succeeded in testing). 1,000 stays comfortably above the
 * spec's own bulk-load scenario (50 nodes) and above upsertNodes'/
 * upsertEdges' own internal chunk size, while keeping one call's
 * transaction — and its potential rollback — bounded to something a
 * single request is meant to carry, not tens of gigabytes.
 */
const MAX_BATCH_ITEMS = 1000;

/**
 * A `Record<string, unknown>` field capped at `maxChars` of serialized
 * JSON — the Zod-layer counterpart to core's `MetadataTooLargeError`
 * (`packages/core/src/nodes.ts`). `metadata`/`props` are for small
 * structured key/value data, not document content; nothing bounded them
 * at the MCP boundary before this (bd-vt2.5 review: 5MB of metadata wrote
 * successfully in 114ms and then reappeared in full in every brain_get
 * response that returned it, at ~200x the response budget). This is a
 * boundary check — reject obviously-bad input before it reaches core at
 * all — not a substitute for core's own guard, which is the actual
 * invariant a caller other than this MCP server (e.g. a future db:seed
 * loader) would otherwise miss.
 */
function boundedRecordSchema(maxChars: number, fieldLabel: string) {
  return z
    .record(z.string(), z.unknown())
    .refine((value) => JSON.stringify(value).length <= maxChars, `${fieldLabel} must serialize to at most ${maxChars} characters — it is for small structured data, not documents`);
}

// --- brain_write -----------------------------------------------------------

const nodeItemSchema = z.object({
  nodeType: z.string().min(1),
  externalId: z.string().min(1),
  /** Defaults to "agent" — see attribution.ts. Set explicitly (e.g. "github") when loading content whose provenance should read as that source rather than the agent itself. */
  sourceSystem: z.string().min(1).optional(),
  title: z.string().optional(),
  content: z.string().optional(),
  metadata: boundedRecordSchema(DEFAULT_MAX_METADATA_LENGTH, "metadata").optional(),
});

const writeSchema = z.object({
  items: z.union([nodeItemSchema, z.array(nodeItemSchema).min(1, "batch must contain at least one item").max(MAX_BATCH_ITEMS, `batch must contain at most ${MAX_BATCH_ITEMS} items`)]),
});

export const writeTool: ToolDef<typeof writeSchema> = {
  name: "brain_write",
  description:
    "Create or update one node, or a batch of nodes in one call (pass items as a single object or an array, up to 1000 items). Each item is upserted on (sourceSystem, externalId) — re-writing identical content is a no-op reported as 'unchanged'; changed content is 'updated'; a new key is 'created'. sourceSystem defaults to \"agent\" when omitted. All items in one call share a single ingest run attributed to source_system='agent', so this call's writes are identifiable and revertible as a unit.",
  schema: writeSchema,
  isWrite: true,
  async handler(ctx: ToolContext, args) {
    const items = toArray(args.items);
    const input: NodeInput[] = items.map((item) => ({
      nodeType: item.nodeType,
      externalId: item.externalId,
      sourceSystem: item.sourceSystem ?? AGENT_SOURCE_SYSTEM,
      title: item.title,
      content: item.content,
      metadata: item.metadata,
    }));

    const { ingestRunId, result } = await withAgentIngestRun(ctx.db, (run) => upsertNodes(ctx.db, run, input));

    return boundResponse(
      result.rows,
      (r) => r.id,
      (kept, meta) => ({
        ingestRunId,
        created: result.created,
        updated: result.updated,
        unchanged: result.unchanged,
        items: kept,
        truncated: meta.truncated,
        ...(meta.truncated
          ? {
              truncationNote:
                `The response-size budget was reached (created/updated/unchanged counts above are exact regardless). ` +
                (meta.droppedIds.length > 0 ? `${meta.droppedIds.length} result row(s) were dropped from this listing — fetch content with brain_get using droppedNodeIds. ` : "") +
                (meta.shrunkIds.length > 0 ? `${meta.shrunkIds.length} result row(s) had oversized fields truncated in place — droppedNodeIds does not apply to those.` : ""),
            }
          : {}),
        droppedNodeIds: meta.droppedIds,
        shrunkNodeIds: meta.shrunkIds,
      }),
      ctx.responseCharBudget,
    );
  },
};

// --- brain_link ------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidField = z.string().regex(UUID_RE, "must be a valid uuid (a node id returned by brain_search, brain_get, or brain_write)");

const edgeItemSchema = z.object({
  srcId: uuidField,
  dstId: uuidField,
  edgeType: z.string().min(1),
  /** Defaults to "agent" — see attribution.ts. */
  sourceSystem: z.string().min(1).optional(),
  weight: z.number().min(0).max(1).optional(),
  props: boundedRecordSchema(DEFAULT_MAX_METADATA_LENGTH, "props").optional(),
});

const linkSchema = z.object({
  items: z.union([edgeItemSchema, z.array(edgeItemSchema).min(1, "batch must contain at least one item").max(MAX_BATCH_ITEMS, `batch must contain at most ${MAX_BATCH_ITEMS} items`)]),
});

export const linkTool: ToolDef<typeof linkSchema> = {
  name: "brain_link",
  description:
    "Assert one edge, or a batch of edges in one call (pass items as a single object or an array, up to 1000 items), between existing node ids. Each edge is upserted on (srcId, dstId, edgeType, sourceSystem) — re-asserting the same edge just updates its weight/props. weight defaults to 1.0 when omitted; sourceSystem defaults to \"agent\". All edges in one call share a single ingest run attributed to source_system='agent'.",
  schema: linkSchema,
  isWrite: true,
  async handler(ctx: ToolContext, args) {
    const items = toArray(args.items);
    const input: EdgeInput[] = items.map((item) => ({
      srcId: item.srcId,
      dstId: item.dstId,
      edgeType: item.edgeType,
      sourceSystem: item.sourceSystem ?? AGENT_SOURCE_SYSTEM,
      weight: item.weight,
      props: item.props,
    }));

    const { ingestRunId, result } = await withAgentIngestRun(ctx.db, (run) => upsertEdges(ctx.db, run, input));

    return boundResponse(
      result.rows,
      (r) => r.id,
      (kept, meta) => ({
        ingestRunId,
        created: result.created,
        updated: result.updated,
        items: kept,
        truncated: meta.truncated,
        ...(meta.truncated
          ? {
              truncationNote:
                `The response-size budget was reached (created/updated counts above are exact regardless). Edges have no brain_get equivalent — match ` +
                `dropped/shrunk edge ids against your own input items to see what they were.`,
            }
          : {}),
        droppedEdgeIds: meta.droppedIds,
        shrunkEdgeIds: meta.shrunkIds,
      }),
      ctx.responseCharBudget,
    );
  },
};

// --- brain_merge -----------------------------------------------------------

const mergeSchema = z.object({
  loserId: uuidField,
  survivorId: uuidField,
});

export const mergeTool: ToolDef<typeof mergeSchema> = {
  name: "brain_merge",
  description:
    "Merge a duplicate node (loserId) into a survivor (survivorId) — for when you notice two nodes describe the same thing (no similarity scoring runs automatically). Idempotent: merging a node that is already merged into the same survivor succeeds and changes nothing. Afterward, brain_get/brain_neighbors/brain_search on loserId resolve to survivorId.",
  schema: mergeSchema,
  isWrite: true,
  async handler(ctx: ToolContext, args) {
    const result = await mergeNodes(ctx.db, args.loserId, args.survivorId);
    return {
      survivorId: result.survivorId,
      mergedNodeIds: result.mergedNodeIds,
      noOp: result.mergedNodeIds.length === 0,
    };
  },
};

export const writeTools: ToolDef[] = [writeTool, linkTool, mergeTool];
