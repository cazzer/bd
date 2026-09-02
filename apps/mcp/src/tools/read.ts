// The five read tools: brain_search, brain_get, brain_neighbors,
// brain_map, brain_history. Thin handlers — argument parsing is already
// done by the time these run (server.ts validates against `schema`
// first); each handler calls one `@breakdown/core` function and shapes
// its result, applying the shared response-size bound (../budget.ts) to
// whatever list it returns.

import {
  DEFAULT_DECAY,
  DEFAULT_FANOUT,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MIN_RELEVANCE,
  DEFAULT_NODE_BUDGET,
  DEFAULT_RECENT_NODES_LIMIT,
  DEFAULT_SEED_LIMIT,
  getNeighbors,
  getNodeHistory,
  getNodes,
  getStoreSummary,
  MAX_ALLOWED_DEPTH,
  MAX_HISTORY_LIMIT,
  retrieve,
  type RetrieveOptions,
} from "@breakdown/core";
import { z } from "zod";
import { boundResponse } from "../budget.js";
import type { ToolContext, ToolDef } from "../types.js";

/** Same batch ceiling as brain_write/brain_link — see tools/write.ts for the rationale. */
const MAX_BATCH_ITEMS = 1000;

// --- brain_search ------------------------------------------------------

const searchSchema = z.object({
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

export const searchTool: ToolDef<typeof searchSchema> = {
  name: "brain_search",
  description:
    "Search the brain by query text and return a scored subgraph: matching seed nodes plus nearby nodes reached by following edges. Query text supports websearch syntax — \"quoted phrases\", -exclusions, and `or`. The response always states the bounds it used (seedLimit, minRelevance, maxDepth, fanout, nodeBudget, decay), since they are not otherwise visible to the caller. Call brain_map first if you are unfamiliar with what is in the store.",
  schema: searchSchema,
  isWrite: false,
  async handler(ctx: ToolContext, args) {
    const defaultsUsed = {
      seedLimit: args.seedLimit ?? DEFAULT_SEED_LIMIT,
      minRelevance: args.minRelevance ?? DEFAULT_MIN_RELEVANCE,
      maxDepth: args.maxDepth ?? DEFAULT_MAX_DEPTH,
      fanout: args.fanout ?? DEFAULT_FANOUT,
      nodeBudget: args.nodeBudget ?? DEFAULT_NODE_BUDGET,
      decay: args.decay ?? DEFAULT_DECAY,
    };

    const options: RetrieveOptions = {
      seedLimit: args.seedLimit,
      minRelevance: args.minRelevance,
      maxDepth: args.maxDepth,
      fanout: args.fanout,
      nodeBudget: args.nodeBudget,
      decay: args.decay,
      nodeTypes: args.nodeTypes ?? null,
      sourceSystems: args.sourceSystems ?? null,
      edgeTypes: args.edgeTypes ?? null,
      updatedSince: args.updatedSince ? new Date(args.updatedSince) : null,
    };

    const result = await retrieve(ctx.db, args.query, options);

    if (result.mode === "empty") {
      return { mode: "empty", triedModes: result.triedModes, defaultsUsed, truncated: false, droppedNodeIds: [], shrunkNodeIds: [], nodes: [], edges: [] };
    }

    // retrieve() already bounded to defaultsUsed.nodeBudget (its own
    // truncated flag reflects that). boundResponse is a second,
    // response-size pass on top: even nodeBudget-many nodes can exceed
    // the response budget if their content is large, so it can truncate
    // further — but never silently, and always with the dropped/shrunk
    // ids so the rest stays reachable via brain_get. It also verifies
    // against the *exact* bytes of the assembled envelope (including
    // `edges`, which boundList's own list-local pass never sees), not an
    // estimate of the node list's share of the budget.
    return boundResponse(
      result.nodes,
      (n) => n.id,
      (kept, meta) => {
        const keptIds = new Set(kept.map((n) => n.id));
        const edges = result.edges.filter((e) => keptIds.has(e.srcNodeId) && keptIds.has(e.dstNodeId));

        const truncated = result.truncated || meta.truncated;
        const notes: string[] = [];
        if (result.truncated) {
          notes.push(`The server-side node budget (${defaultsUsed.nodeBudget}) was reached before all reachable nodes were included; call again with a larger nodeBudget to see more, or narrow the query.`);
        }
        if (meta.droppedIds.length > 0) {
          notes.push(`The response-size budget was reached; ${meta.droppedIds.length} lower-scoring node(s) were dropped from this response. Fetch them individually with brain_get using the ids in droppedNodeIds.`);
        }
        if (meta.shrunkIds.length > 0) {
          notes.push(`${meta.shrunkIds.length} node(s) were kept but had oversized fields (e.g. content/metadata) truncated in place; brain_get on the same id will return the same truncated value if it alone exceeds the response budget.`);
        }

        return {
          mode: result.mode,
          seedCount: result.seedCount,
          nodeCount: kept.length,
          defaultsUsed,
          truncated,
          ...(notes.length > 0 ? { truncationNote: notes.join(" ") } : {}),
          droppedNodeIds: meta.droppedIds,
          shrunkNodeIds: meta.shrunkIds,
          nodes: kept,
          edges,
        };
      },
      ctx.responseCharBudget,
    );
  },
};

// --- brain_get -----------------------------------------------------------

const getSchema = z.object({
  ids: z
    .array(z.string().min(1))
    .min(1, "must contain at least one id")
    .max(MAX_BATCH_ITEMS, `must contain at most ${MAX_BATCH_ITEMS} ids`),
});

export const getTool: ToolDef<typeof getSchema> = {
  name: "brain_get",
  description:
    "Fetch one or more nodes by id (up to 1000 per call), with full title/content/metadata. An id naming a node that was merged away resolves to its survivor's content. Ids that match nothing are reported in notFoundIds, never silently omitted.",
  schema: getSchema,
  isWrite: false,
  async handler(ctx: ToolContext, args) {
    const result = await getNodes(ctx.db, args.ids);

    return boundResponse(
      result.nodes,
      (n) => n.id,
      (kept, meta) => ({
        nodes: kept,
        notFoundIds: result.notFoundIds,
        truncated: meta.truncated,
        ...(meta.truncated
          ? {
              truncationNote:
                (meta.droppedIds.length > 0
                  ? `The response-size budget was reached; ${meta.droppedIds.length} node(s) were dropped from this response. Re-fetch them with brain_get in a smaller batch, using the ids in droppedNodeIds. `
                  : "") + (meta.shrunkIds.length > 0 ? `${meta.shrunkIds.length} node(s) were kept but had oversized fields (content/metadata) truncated in place — there is no larger view available for a single item that big via this tool.` : ""),
            }
          : {}),
        droppedNodeIds: meta.droppedIds,
        shrunkNodeIds: meta.shrunkIds,
      }),
      ctx.responseCharBudget,
    );
  },
};

// --- brain_neighbors -------------------------------------------------------

const neighborsSchema = z.object({
  id: z.string().min(1, "must not be empty"),
});

export const neighborsTool: ToolDef<typeof neighborsSchema> = {
  name: "brain_neighbors",
  description:
    "List a node's immediate neighbors: for each connecting edge, its type, direction (outgoing/incoming from the queried node), weight, and source system, plus the neighboring node's identity. An id naming a merged-away node resolves to its survivor before listing.",
  schema: neighborsSchema,
  isWrite: false,
  async handler(ctx: ToolContext, args) {
    const result = await getNeighbors(ctx.db, args.id);

    return boundResponse(
      result.neighbors,
      (n) => n.nodeId,
      (kept, meta) => ({
        requestedId: result.requestedId,
        canonicalId: result.canonicalId,
        resolvedFromMerge: result.canonicalId !== result.requestedId,
        neighbors: kept,
        truncated: meta.truncated,
        ...(meta.truncated
          ? {
              truncationNote: `The response-size budget was reached; ${meta.droppedIds.length} lower-weight neighbor(s) were dropped. Fetch their content with brain_get using the ids in droppedNodeIds.`,
            }
          : {}),
        droppedNodeIds: meta.droppedIds,
        shrunkNodeIds: meta.shrunkIds,
      }),
      ctx.responseCharBudget,
    );
  },
};

// --- brain_map -------------------------------------------------------------

const mapSchema = z.object({
  recentNodesLimit: z.number().int().positive().optional(),
});

export const mapTool: ToolDef<typeof mapSchema> = {
  name: "brain_map",
  description:
    "Summarize the brain: node types, source systems, and edge types in use with counts, plus the most recently updated nodes. Call this to orient before searching an unfamiliar store — it reveals the actual vocabulary in use, which full-text search alone will not.",
  schema: mapSchema,
  isWrite: false,
  async handler(ctx: ToolContext, args) {
    const defaultsUsed = { recentNodesLimit: args.recentNodesLimit ?? DEFAULT_RECENT_NODES_LIMIT };
    const summary = await getStoreSummary(ctx.db, { recentNodesLimit: args.recentNodesLimit });

    return boundResponse(
      summary.recentNodes,
      (n) => n.id,
      (kept, meta) => ({
        totalNodes: summary.totalNodes,
        totalEdges: summary.totalEdges,
        nodeTypes: summary.nodeTypes,
        sourceSystems: summary.sourceSystems,
        edgeTypes: summary.edgeTypes,
        recentNodes: kept,
        defaultsUsed,
        truncated: meta.truncated,
        ...(meta.truncated
          ? { truncationNote: `The response-size budget was reached; ${meta.droppedIds.length} recently-updated node(s) were dropped. Fetch them with brain_get using the ids in droppedNodeIds, or call brain_map again with a smaller recentNodesLimit.` }
          : {}),
        droppedNodeIds: meta.droppedIds,
        shrunkNodeIds: meta.shrunkIds,
      }),
      ctx.responseCharBudget,
    );
  },
};

// --- brain_history ---------------------------------------------------------

const historySchema = z.object({
  id: z.string().min(1, "must not be empty"),
  limit: z.number().int().positive().max(MAX_HISTORY_LIMIT).optional(),
  /** A revisionNo; only revisions strictly older than it are returned. Take it from a previous response's nextBefore. */
  before: z.number().int().positive().optional(),
  includeContent: z.boolean().optional(),
});

export const historyTool: ToolDef<typeof historySchema> = {
  name: "brain_history",
  description:
    "Return a node's revision history, newest first. Each revision carries its revisionNo, recordedAt, the ingest run that made it (id, sourceSystem, actor), changedFields (which of nodeType/title/content/metadata/mergedInto differ from the previous revision; the first revision lists every present field), and metadataChanges ({ key: { before, after } } for each top-level metadata key that changed). content is omitted unless includeContent is true; contentHash still shows whether it changed. History is per node as stored: a merged-away node's id returns its own revisions, including the one that merged it, not its survivor's. To page older revisions, call again with before set to the nextBefore from the previous response.",
  schema: historySchema,
  isWrite: false,
  async handler(ctx: ToolContext, args) {
    const result = await getNodeHistory(ctx.db, args.id, {
      limit: args.limit,
      before: args.before ?? null,
      includeContent: args.includeContent ?? false,
    });

    // boundResponse drops from the tail, which for a newest-first list is
    // the OLDEST revisions — so hasMore/nextBefore are recomputed from
    // what is actually kept, not taken from core's result; otherwise the
    // cursor would skip every revision the budget dropped.
    return boundResponse(
      result.revisions,
      (r) => String(r.revisionNo),
      (kept, meta) => {
        const oldest = kept[kept.length - 1];
        const hasMore = result.hasMore || meta.droppedIds.length > 0;
        const nextBefore = hasMore && oldest ? oldest.revisionNo : null;

        const notes: string[] = [];
        if (hasMore) {
          notes.push(`Older revisions exist beyond this response; call brain_history again with before=${nextBefore} to continue.`);
        }
        if (meta.droppedIds.length > 0) {
          notes.push(
            `${meta.droppedIds.length} revision(s) were dropped to fit the response-size budget — the before cursor above already accounts for them; use a smaller limit or includeContent=false if content is what overflows.`,
          );
        }
        if (meta.shrunkIds.length > 0) {
          notes.push(`${meta.shrunkIds.length} revision(s) had oversized fields truncated in place.`);
        }

        return {
          id: result.nodeId,
          revisions: kept,
          hasMore,
          nextBefore,
          truncated: hasMore || meta.truncated,
          ...(notes.length > 0 ? { truncationNote: notes.join(" ") } : {}),
          droppedRevisionNos: meta.droppedIds.map(Number),
          shrunkRevisionNos: meta.shrunkIds.map(Number),
        };
      },
      ctx.responseCharBudget,
    );
  },
};

export const readTools: ToolDef[] = [searchTool, getTool, neighborsTool, mapTool, historyTool];
