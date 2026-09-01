// The four read procedures (bd-hmd.3, tasks.md 3.3): search, getNeighbors,
// getNodes, getStoreSummary. Thin handlers — each parses input (validated
// by `.input(schema)` before the resolver runs), calls exactly one
// `@breakdown/core` function, and shapes the result. All business logic —
// scoring, traversal, merge folding, degree, pagination — lives in
// `packages/core`, not here. Every core call is wrapped so a thrown
// `KnowledgeStoreError` becomes a safe `TRPCError` (see ../errors.ts).

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
  MAX_NEIGHBOR_LIMIT,
  retrieve,
  type NeighborsCursor,
  type RetrieveOptions,
} from "@breakdown/core";
import { z } from "zod";
import { toLookedUpNodeDto, toRecentNodeDto, toRetrievedNodeDto } from "../dto.js";
import { mapCoreError } from "../errors.js";
import { publicProcedure, router } from "../trpc.js";

// --- search (retrieve) ------------------------------------------------------

const searchInputSchema = z.object({
  query: z.string().min(1, "must not be empty"),
  seedLimit: z.number().int().positive().optional(),
  minRelevance: z.number().positive().optional(),
  maxDepth: z.number().int().min(0).max(MAX_ALLOWED_DEPTH).optional(),
  fanout: z.number().int().positive().optional(),
  nodeBudget: z.number().int().positive().optional(),
  decay: z.number().gt(0).max(1).optional(),
  nodeTypes: z.array(z.string().min(1)).min(1).optional(),
  sourceSystems: z.array(z.string().min(1)).min(1).optional(),
  edgeTypes: z.array(z.string().min(1)).min(1).optional(),
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

  return {
    mode: result.mode,
    seedCount: result.seedCount,
    nodeCount: result.nodeCount,
    truncated: result.truncated,
    defaultsUsed,
    nodes: result.nodes.map(toRetrievedNodeDto),
    edges: result.edges,
  };
});

// --- getNeighbors ------------------------------------------------------------

const neighborsCursorSchema = z.object({
  canonicalId: z.string().min(1),
  weight: z.number(),
  nodeId: z.string().min(1),
  edgeId: z.string().min(1),
}) satisfies z.ZodType<NeighborsCursor>;

const getNeighborsInputSchema = z.object({
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
      neighbors: result.neighbors,
      hasMore: result.hasMore,
      nextCursor: result.nextCursor,
      defaultsUsed: { limit: input.limit ?? DEFAULT_NEIGHBOR_LIMIT },
    };
  } catch (err) {
    throw mapCoreError("getNeighbors", err);
  }
});

// --- getNodes ------------------------------------------------------------

const getNodesInputSchema = z.object({
  ids: z.array(z.string().min(1)).min(1, "must contain at least one id").max(1000, "must contain at most 1000 ids"),
});

const getNodesProcedure = publicProcedure.input(getNodesInputSchema).query(async ({ ctx, input }) => {
  try {
    const result = await getNodes(ctx.db, input.ids);
    return { nodes: result.nodes.map(toLookedUpNodeDto), notFoundIds: result.notFoundIds };
  } catch (err) {
    throw mapCoreError("getNodes", err);
  }
});

// --- getStoreSummary -------------------------------------------------------

const getStoreSummaryInputSchema = z
  .object({
    recentNodesLimit: z.number().int().positive().optional(),
  })
  .optional();

const getStoreSummaryProcedure = publicProcedure.input(getStoreSummaryInputSchema).query(async ({ ctx, input }) => {
  const recentNodesLimit = input?.recentNodesLimit;
  try {
    const summary = await getStoreSummary(ctx.db, { recentNodesLimit });
    return {
      totalNodes: summary.totalNodes,
      totalEdges: summary.totalEdges,
      nodeTypes: summary.nodeTypes,
      sourceSystems: summary.sourceSystems,
      edgeTypes: summary.edgeTypes,
      recentNodes: summary.recentNodes.map(toRecentNodeDto),
      defaultsUsed: { recentNodesLimit: recentNodesLimit ?? DEFAULT_RECENT_NODES_LIMIT },
    };
  } catch (err) {
    throw mapCoreError("getStoreSummary", err);
  }
});

export const readRouter = router({
  search: searchProcedure,
  getNeighbors: getNeighborsProcedure,
  getNodes: getNodesProcedure,
  getStoreSummary: getStoreSummaryProcedure,
});
