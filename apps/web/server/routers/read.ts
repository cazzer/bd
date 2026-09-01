// The four read procedures (bd-hmd.3, tasks.md 3.3): search, getNeighbors,
// getNodes, getStoreSummary. Thin handlers — each parses input (validated
// by `.input(schema)` before the resolver runs), calls exactly one
// `@breakdown/core` function, and shapes the result. All business logic —
// scoring, traversal, merge folding, degree, pagination — lives in
// `packages/core`, not here. Every core call is wrapped so a thrown
// `KnowledgeStoreError` becomes a safe `TRPCError` (see ../errors.ts).
//
// bd-hmd.3 review, two defense-in-depth layers added here on top of the
// core-level fixes:
//   - seedLimit/fanout/nodeBudget/limit/recentNodesLimit are capped here
//     too (mirroring the new MAX_SEED_LIMIT/MAX_FANOUT/MAX_NODE_BUDGET/
//     MAX_NEIGHBOR_LIMIT/MAX_RECENT_NODES_LIMIT ceilings packages/core now
//     enforces) so an out-of-range value is rejected by Zod, naming the
//     field, before it ever reaches a core call.
//   - nodeTypes/sourceSystems/edgeTypes filter arrays are capped at
//     MAX_FILTER_VALUES: nothing bounded these before, and a filter list
//     is a set of distinct vocabulary terms, not a document — dozens is
//     already generous (getStoreSummary's own nodeTypes/sourceSystems/
//     edgeTypes counts, the closest thing to "how many distinct values
//     exist", are all single digits in the seeded corpus).
//
// Response-size budgeting (bd-hmd.3 review, defect 4): `search.nodes`,
// `getNodes.nodes`, and `getStoreSummary.recentNodes` are all bounded via
// ../budget.ts (ported from apps/mcp/src/budget.ts) — see that file's
// header for the concrete finding (three ~999,000-character notes alone
// produced a ~3MB response with no truncation, and the schema's own
// ceiling put a ~1GB response within reach before this).

import {
  DEFAULT_DECAY,
  DEFAULT_FANOUT,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MIN_RELEVANCE,
  DEFAULT_NEIGHBOR_LIMIT,
  DEFAULT_NODE_BUDGET,
  DEFAULT_RECENT_NODES_LIMIT,
  DEFAULT_SEED_LIMIT,
  getNeighbors,
  getNodes,
  getStoreSummary,
  MAX_ALLOWED_DEPTH,
  MAX_FANOUT,
  MAX_NEIGHBOR_LIMIT,
  MAX_NODE_BUDGET,
  MAX_RECENT_NODES_LIMIT,
  MAX_SEED_LIMIT,
  retrieve,
  type NeighborsCursor,
  type RetrieveOptions,
} from "@breakdown/core";
import { z } from "zod";
import { boundResponse } from "../budget.js";
import { toLookedUpNodeDto, toNeighborDto, toRecentNodeDto, toRetrievedNodeDto } from "../dto.js";
import { mapCoreError } from "../errors.js";
import { publicProcedure, router } from "../trpc.js";

/** See the module header — bounds the nodeTypes/sourceSystems/edgeTypes filter arrays. */
const MAX_FILTER_VALUES = 50;

function filterArraySchema() {
  return z.array(z.string().min(1)).min(1).max(MAX_FILTER_VALUES, `must contain at most ${MAX_FILTER_VALUES} values`);
}

// --- search (retrieve) ------------------------------------------------------

export const searchInputSchema = z.object({
  query: z.string().min(1, "must not be empty"),
  seedLimit: z.number().int().positive().max(MAX_SEED_LIMIT).optional(),
  minRelevance: z.number().positive().optional(),
  maxDepth: z.number().int().min(0).max(MAX_ALLOWED_DEPTH).optional(),
  fanout: z.number().int().positive().max(MAX_FANOUT).optional(),
  nodeBudget: z.number().int().positive().max(MAX_NODE_BUDGET).optional(),
  decay: z.number().gt(0).max(1).optional(),
  nodeTypes: filterArraySchema().optional(),
  sourceSystems: filterArraySchema().optional(),
  edgeTypes: filterArraySchema().optional(),
  /** ISO-8601 instant; only nodes updated at or after this are considered. */
  updatedSince: z.string().datetime({ offset: true }).optional(),
});

const searchProcedure = publicProcedure.input(searchInputSchema).query(async ({ ctx, input }) => {
  const defaultsUsed = {
    seedLimit: input.seedLimit ?? DEFAULT_SEED_LIMIT,
    minRelevance: input.minRelevance ?? DEFAULT_MIN_RELEVANCE,
    maxDepth: input.maxDepth ?? DEFAULT_MAX_DEPTH,
    fanout: input.fanout ?? DEFAULT_FANOUT,
    nodeBudget: input.nodeBudget ?? DEFAULT_NODE_BUDGET,
    decay: input.decay ?? DEFAULT_DECAY,
  };

  const options: RetrieveOptions = {
    seedLimit: input.seedLimit,
    minRelevance: input.minRelevance,
    maxDepth: input.maxDepth,
    fanout: input.fanout,
    nodeBudget: input.nodeBudget,
    decay: input.decay,
    nodeTypes: input.nodeTypes ?? null,
    sourceSystems: input.sourceSystems ?? null,
    edgeTypes: input.edgeTypes ?? null,
    updatedSince: input.updatedSince ? new Date(input.updatedSince) : null,
  };

  let result;
  try {
    result = await retrieve(ctx.db, input.query, options);
  } catch (err) {
    throw mapCoreError("search", err);
  }

  if (result.mode === "empty") {
    return { mode: "empty" as const, triedModes: result.triedModes, defaultsUsed, nodes: [], edges: [] };
  }

  const dtoNodes = result.nodes.map(toRetrievedNodeDto);

  return boundResponse(
    dtoNodes,
    (n) => n.id,
    (kept, meta) => {
      const keptIds = new Set(kept.map((n) => n.id));
      return {
        mode: result.mode,
        seedCount: result.seedCount,
        nodeCount: kept.length,
        // Either the query's own nodeBudget truncated the neighborhood, or
        // this response's own character budget did — both are worth
        // surfacing under the one flag callers already check.
        truncated: result.truncated || meta.truncated,
        defaultsUsed,
        droppedNodeIds: meta.droppedIds,
        shrunkNodeIds: meta.shrunkIds,
        nodes: kept,
        // Edges are filtered to the nodes actually kept in this response —
        // an edge naming a dropped node would be a dangling reference the
        // client can't render anyway.
        edges: result.edges.filter((e) => keptIds.has(e.srcNodeId) && keptIds.has(e.dstNodeId)),
      };
    },
  );
});

// --- getNeighbors ------------------------------------------------------------

const neighborsCursorSchema = z.object({
  canonicalId: z.string().min(1),
  weight: z.number(),
  nodeId: z.string().min(1),
  edgeId: z.string().min(1),
}) satisfies z.ZodType<NeighborsCursor>;

export const getNeighborsInputSchema = z.object({
  id: z.string().min(1, "must not be empty"),
  limit: z.number().int().positive().max(MAX_NEIGHBOR_LIMIT).optional(),
  cursor: neighborsCursorSchema.optional(),
});

const getNeighborsProcedure = publicProcedure.input(getNeighborsInputSchema).query(async ({ ctx, input }) => {
  try {
    const result = await getNeighbors(ctx.db, input.id, { limit: input.limit, cursor: input.cursor ?? null });
    return {
      requestedId: result.requestedId,
      canonicalId: result.canonicalId,
      neighbors: result.neighbors.map(toNeighborDto),
      hasMore: result.hasMore,
      nextCursor: result.nextCursor,
      defaultsUsed: { limit: input.limit ?? DEFAULT_NEIGHBOR_LIMIT },
    };
  } catch (err) {
    throw mapCoreError("getNeighbors", err);
  }
});

// --- getNodes ------------------------------------------------------------

export const getNodesInputSchema = z.object({
  ids: z.array(z.string().min(1)).min(1, "must contain at least one id").max(1000, "must contain at most 1000 ids"),
});

const getNodesProcedure = publicProcedure.input(getNodesInputSchema).query(async ({ ctx, input }) => {
  let result;
  try {
    result = await getNodes(ctx.db, input.ids);
  } catch (err) {
    throw mapCoreError("getNodes", err);
  }

  const dtoNodes = result.nodes.map(toLookedUpNodeDto);

  return boundResponse(
    dtoNodes,
    (n) => n.id,
    (kept, meta) => ({
      nodes: kept,
      notFoundIds: result.notFoundIds,
      truncated: meta.truncated,
      droppedNodeIds: meta.droppedIds,
      shrunkNodeIds: meta.shrunkIds,
    }),
  );
});

// --- getStoreSummary -------------------------------------------------------

export const getStoreSummaryInputSchema = z
  .object({
    recentNodesLimit: z.number().int().positive().max(MAX_RECENT_NODES_LIMIT).optional(),
  })
  .optional();

const getStoreSummaryProcedure = publicProcedure.input(getStoreSummaryInputSchema).query(async ({ ctx, input }) => {
  const recentNodesLimit = input?.recentNodesLimit;
  let summary;
  try {
    summary = await getStoreSummary(ctx.db, { recentNodesLimit });
  } catch (err) {
    throw mapCoreError("getStoreSummary", err);
  }

  const dtoRecentNodes = summary.recentNodes.map(toRecentNodeDto);

  return boundResponse(
    dtoRecentNodes,
    (n) => n.id,
    (kept, meta) => ({
      totalNodes: summary.totalNodes,
      totalEdges: summary.totalEdges,
      nodeTypes: summary.nodeTypes,
      sourceSystems: summary.sourceSystems,
      edgeTypes: summary.edgeTypes,
      recentNodes: kept,
      defaultsUsed: { recentNodesLimit: recentNodesLimit ?? DEFAULT_RECENT_NODES_LIMIT },
      truncated: meta.truncated,
      droppedNodeIds: meta.droppedIds,
      shrunkNodeIds: meta.shrunkIds,
    }),
  );
});

export const readRouter = router({
  search: searchProcedure,
  getNeighbors: getNeighborsProcedure,
  getNodes: getNodesProcedure,
  getStoreSummary: getStoreSummaryProcedure,
});
