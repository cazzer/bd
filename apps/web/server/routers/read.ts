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
  DEFAULT_FIND_LIMIT,
  DEFAULT_FANOUT,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MIN_RELEVANCE,
  DEFAULT_NEIGHBOR_LIMIT,
  DEFAULT_NODE_BUDGET,
  DEFAULT_RECENT_NODES_LIMIT,
  DEFAULT_SEED_LIMIT,
  findNodes,
  getNeighbors,
  getNodes,
  getStoreSummary,
  getSubtree,
  getTimeline,
  listNodes,
  MAX_ALLOWED_DEPTH,
  MAX_FANOUT,
  MAX_FIND_LIMIT,
  MAX_FIND_OFFSET,
  MAX_FIND_TEXT_LENGTH,
  MAX_LIST_LIMIT,
  MAX_LIST_NAMES,
  MAX_LIST_PREDICATES,
  MAX_NEIGHBOR_LIMIT,
  MAX_NODE_BUDGET,
  MAX_ONE_OF_VALUES,
  MAX_PREDICATE_KEY_LENGTH,
  MAX_PREDICATE_STRING_LENGTH,
  MAX_RECENT_NODES_LIMIT,
  MAX_RESOLVE_IDS,
  MAX_SEED_LIMIT,
  MAX_TIMELINE_LIMIT,
  NodeNotFoundError,
  NOTE_NODE_TYPE,
  resolveDefaultViews,
  retrieve,
  type MetadataPredicate,
  type NeighborsCursor,
  type RetrieveOptions,
} from "@breakdown/core";
import { z } from "zod";
import { boundResponse } from "../budget.js";
import { toFoundNodeDto, toListedNodeDto, toLookedUpNodeDto, toNeighborDto, toRecentNodeDto, toRetrievedNodeDto } from "../dto.js";
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
    ctx.responseCharBudget,
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
    ctx.responseCharBudget,
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
    ctx.responseCharBudget,
  );
});

// --- listUnlinkedNotes ---------------------------------------------------
//
// bd-hmd.6, tasks.md 6.4: "surface an unlinked-notes list so [degree-zero
// notes] do not silently accumulate" (design.md's own risk: "Free-
// floating notes become orphans"). No `@breakdown/core` read returns
// "nodes of a given type, with their degree" in one call — degree is
// computed only by `retrieve()` (a search hit) and by `getNeighbors` (for
// the OTHER side of each neighbor), never for an arbitrary node in
// isolation — so this composes two existing reads rather than adding a
// core primitive for a single UI list (this ticket's boundary: don't
// modify packages/core unless a scenario genuinely can't be met
// otherwise; composition here meets it):
//
//   1. `getStoreSummary`'s `recentNodes`, at the largest bound core
//      allows, narrowed to `NOTE_NODE_TYPE` — every note is human-
//      authored (human-writes.ts's `createNote`/`annotateNode` are the
//      only writers of that node_type), so this is a candidate list, not
//      a guess.
//   2. `getNeighbors(id, { limit: 1 })` per candidate: an unfiltered
//      first page of size >= 1 returning zero rows on `getNeighbors` IS
//      "degree 0" — a real neighbor would always appear on an unbounded
//      first page — so this needs no cursor loop, just the one round
//      trip per note.
//
// This is N+1 round trips (one summary call, one getNeighbors call per
// note candidate), acceptable for a single-user local tool where the
// candidate count is small; see this ticket's report for why a
// per-request cache or a core-level index was judged not worth adding
// for that scale. `recentNodes` is itself bounded by `MAX_RECENT_NODES_LIMIT`
// (1000, by updatedAt descending) — a store with more than 1000 nodes
// total could in principle have an even-older, never-updated note fall
// outside this scan; `scanTruncated` below reports that possibility
// rather than hiding it.
//
// `noteCandidates` is a SNAPSHOT (from `getStoreSummary`, above); the
// per-candidate `getNeighbors` calls below happen after it, so a note
// deleted or merged away in between (another write racing this read —
// concretely observed as a test-suite flake: concurrently-run test files
// sharing one database, one deleting a human-authored note this scan had
// already snapshotted) makes `getNeighbors` throw `NodeNotFoundError`.
// That candidate is simply no longer a real answer to "what's unlinked"
// — skipped, not a reason to fail the whole listing for every OTHER
// candidate that's still perfectly fine to report.
export const listUnlinkedNotesInputSchema = z.object({}).optional();

const listUnlinkedNotesProcedure = publicProcedure.input(listUnlinkedNotesInputSchema).query(async ({ ctx }) => {
  let summary;
  try {
    summary = await getStoreSummary(ctx.db, { recentNodesLimit: MAX_RECENT_NODES_LIMIT });
  } catch (err) {
    throw mapCoreError("listUnlinkedNotes", err);
  }

  const noteCandidates = summary.recentNodes.filter((n) => n.nodeType === NOTE_NODE_TYPE);

  const unlinked = [];
  for (const note of noteCandidates) {
    let neighbors;
    try {
      neighbors = await getNeighbors(ctx.db, note.id, { limit: 1 });
    } catch (err) {
      if (err instanceof NodeNotFoundError) {
        continue; // raced away since the snapshot above — see this block's own header
      }
      throw mapCoreError("listUnlinkedNotes", err);
    }
    if (neighbors.neighbors.length === 0) {
      unlinked.push(toRecentNodeDto(note));
    }
  }

  return {
    notes: unlinked,
    scannedNotes: noteCandidates.length,
    scanTruncated: summary.recentNodes.length >= MAX_RECENT_NODES_LIMIT,
  };
});

// --- list ------------------------------------------------------------------
//
// node-views (design.md decision 7): structured listing for the feed view,
// mirroring apps/mcp/src/tools/read.ts's brain_list — the same Zod bounds
// (core's MAX_LIST_* / MAX_PREDICATE_* constants), the same `listNodes`
// call, the same budget pass. A view's `filter` is exactly this input
// minus `limit`/`cursor` (packages/core/src/views.ts), which is what lets
// FeedView.tsx spread a view's metadata straight into a request. Rows
// carry `metadata` and never `content` (local-web-api spec, "Listing a
// view's selection"); the per-row `cursor` core attaches is consumed here
// and stripped from the wire.

const scalarSchema = z.union([z.string().max(MAX_PREDICATE_STRING_LENGTH), z.number().finite(), z.boolean(), z.null()]);
const predicateKeySchema = z.string().min(1).max(MAX_PREDICATE_KEY_LENGTH);
const predicateSchema = z.union([
  z.object({ key: predicateKeySchema, op: z.literal("equals"), value: scalarSchema }),
  z.object({ key: predicateKeySchema, op: z.literal("oneOf"), values: z.array(scalarSchema).min(1).max(MAX_ONE_OF_VALUES) }),
  z.object({ key: predicateKeySchema, op: z.literal("contains"), value: scalarSchema }),
]);

export const listInputSchema = z.object({
  nodeTypes: z.array(z.string().min(1)).min(1).max(MAX_LIST_NAMES).optional(),
  sourceSystems: z.array(z.string().min(1)).min(1).max(MAX_LIST_NAMES).optional(),
  /** ISO-8601 instant; only nodes updated at or after this are listed. */
  updatedSince: z.string().datetime({ offset: true }).optional(),
  where: z.array(predicateSchema).max(MAX_LIST_PREDICATES).optional(),
  limit: z.number().int().positive().max(MAX_LIST_LIMIT).optional(),
  /** Opaque: a previous response's `nextCursor`, passed back unchanged. */
  cursor: z.object({ updatedAt: z.string().min(1).max(64), id: z.string().min(1).max(64) }).optional(),
});

const listProcedure = publicProcedure.input(listInputSchema).query(async ({ ctx, input }) => {
  let result;
  try {
    result = await listNodes(ctx.db, {
      nodeTypes: input.nodeTypes ?? null,
      sourceSystems: input.sourceSystems ?? null,
      updatedSince: input.updatedSince ?? null,
      where: (input.where as MetadataPredicate[] | undefined) ?? null,
      limit: input.limit,
      cursor: input.cursor ?? null,
    });
  } catch (err) {
    throw mapCoreError("list", err);
  }

  const dtoNodes = result.nodes.map(toListedNodeDto);

  return boundResponse(
    dtoNodes,
    (n) => n.id,
    (kept, meta) => {
      // The budget drops from the tail (the oldest), so the cursor must
      // come from the last row actually returned, not from core's page —
      // otherwise the next page would skip every row the budget dropped.
      const last = kept[kept.length - 1];
      const hasMore = result.hasMore || meta.droppedIds.length > 0;
      return {
        nodes: kept.map(({ cursor: _cursor, ...node }) => node),
        hasMore,
        nextCursor: hasMore && last ? last.cursor : null,
        truncated: meta.truncated,
        droppedNodeIds: meta.droppedIds,
        shrunkNodeIds: meta.shrunkIds,
      };
    },
    ctx.responseCharBudget,
  );
});

// --- find ------------------------------------------------------------------
//
// search-results-view (design.md decision 5): the results view's one read —
// optional text, node types, projects, reviews-only, offset paging — calling
// core's `findNodes` (packages/core/src/find.ts), which answers the page and
// the facet counts in one statement. Rows are summary fields only (core
// never selects content or full metadata), so review comments and card
// metadata never travel. The budget pass drops from the tail, so the next
// page starts at `offset + rows kept`, never `offset + limit`. Public and
// read-only, so it serves under BRAIN_READ_ONLY too.

export const findInputSchema = z.object({
  /** Trimmed; empty means no text. */
  text: z.string().trim().max(MAX_FIND_TEXT_LENGTH).optional(),
  nodeTypes: z.array(z.string().min(1)).min(1).max(MAX_LIST_NAMES).optional(),
  projects: z.array(z.string().min(1)).min(1).max(MAX_LIST_NAMES).optional(),
  reviewsOnly: z.boolean().optional(),
  limit: z.number().int().positive().max(MAX_FIND_LIMIT).optional(),
  offset: z.number().int().min(0).max(MAX_FIND_OFFSET).optional(),
});

const findProcedure = publicProcedure.input(findInputSchema).query(async ({ ctx, input }) => {
  const offset = input.offset ?? 0;
  let result;
  try {
    result = await findNodes(ctx.db, {
      text: input.text || null,
      nodeTypes: input.nodeTypes ?? null,
      projects: input.projects ?? null,
      reviewsOnly: input.reviewsOnly ?? false,
      limit: input.limit,
      offset,
    });
  } catch (err) {
    throw mapCoreError("find", err);
  }

  return boundResponse(
    result.nodes.map(toFoundNodeDto),
    (n) => n.id,
    (kept, meta) => {
      const hasMore = result.hasMore || meta.droppedIds.length > 0;
      return {
        nodes: kept,
        hasMore,
        nextOffset: hasMore ? offset + kept.length : null,
        total: result.total,
        facets: result.facets,
        defaultsUsed: { limit: input.limit ?? DEFAULT_FIND_LIMIT },
        truncated: meta.truncated,
        droppedNodeIds: meta.droppedIds,
        shrunkNodeIds: meta.shrunkIds,
      };
    },
    ctx.responseCharBudget,
  );
});

// --- resolveDefaultViews ---------------------------------------------------
//
// node-views (design.md decisions 7 and 8): one answer per id, in input
// order, in one statement (packages/core/src/views.ts). GraphView.tsx asks
// for the selected node only today; the batch shape is what lets the
// canvas ask for every drawn node later without an API change (design.md's
// open question). Not budgeted: the input is capped at MAX_RESOLVE_IDS and
// each answer is two ids and a title (core caps titles at 500 characters),
// so the largest possible response is a few hundred kilobytes — and
// dropping answers would break "one answer per id", which is the contract.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const resolveDefaultViewsInputSchema = z.object({
  ids: z
    .array(z.string().regex(UUID_RE, "must be a valid uuid"))
    .min(1, "must contain at least one id")
    .max(MAX_RESOLVE_IDS, `must contain at most ${MAX_RESOLVE_IDS} ids`),
});

const resolveDefaultViewsProcedure = publicProcedure.input(resolveDefaultViewsInputSchema).query(async ({ ctx, input }) => {
  try {
    const results = await resolveDefaultViews(ctx.db, input.ids);
    return { results };
  } catch (err) {
    throw mapCoreError("resolveDefaultViews", err);
  }
});

// --- tree ------------------------------------------------------------------
//
// code-view (design.md decision 1; local-web-api spec, "Reading a
// repository's tree"): one root id in, the root and its `child_of`
// descendants out — each with its parent id, type, title, external id,
// and `path`/`language` metadata, never content — shallowest first
// (packages/core/src/tree.ts). One request draws a tree; a deep link's
// ancestors are followed client-side through `parentId`.
//
// Not budgeted — no `boundResponse` — because the read is bounded by
// count, not by size: core caps the answer at MAX_SUBTREE_NODES rows of
// seven short fields (titles at most 500 characters, and in practice a
// file's base name), which stays within the 2 MB character budget the
// other procedures apply — measured, a 340-row tree is ~88 KB and 5,000
// rows about 1.3 MiB, `path` repeating the tail of `externalId` and so
// roughly doubling what each row costs; and the budget drops from the
// tail, which for a depth-ordered tree would be a second, silent
// truncation stacked on the honest `truncated` flag core already
// reports. Errors go through `mapCoreError` like every other procedure:
// a root that names no canonical node is NOT_FOUND, as it is for
// `getNeighbors` and `getNodeHistory`, and a malformed id is BAD_REQUEST
// (`InvalidLookupIdError`). CodeView.tsx branches on neither code — any
// failed tree read is shown as its message — so the distinction is for
// the API's own consistency, not the view's.

export const treeInputSchema = z.object({
  rootId: z.string().min(1, "must not be empty"),
});

const treeProcedure = publicProcedure.input(treeInputSchema).query(async ({ ctx, input }) => {
  try {
    const result = await getSubtree(ctx.db, input.rootId);
    return { rootId: result.rootId, nodes: result.nodes, truncated: result.truncated };
  } catch (err) {
    throw mapCoreError("tree", err);
  }
});

// --- timeline --------------------------------------------------------------
//
// timeline-view (design.md decision 3; local-web-api spec, "Reading an
// anchor's timeline"): one anchor id in, its timed neighbours out — newest
// first, one row per node with its metadata and the heaviest joining
// edge's type and direction, never content — and the count of untimed
// neighbours under the same narrowing (packages/core/src/timeline.ts).
// `nodeTypes`/`sourceSystems` take `list`'s Zod shapes because a timeline
// view spreads its view's filter in exactly as the feed does; `anchorId`
// takes `tree`'s, the id's form being core's to reject.
//
// Budgeted as `list` is: rows carry `metadata`, which nothing bounds below
// core's per-row metadata cap, so a page can outgrow the response budget.
// And as for `list`, the cursor comes from the last row actually returned,
// not from core's page — the budget drops from the tail (the oldest), so a
// cursor minted from core's last row would skip every row it dropped.
// Errors through `mapCoreError`: a malformed id, a bad limit or cursor, and
// a bad name list are BAD_REQUEST (`InvalidLookupIdError`,
// `InvalidLookupOptionError`, `InvalidListOptionError`); an anchor naming
// no canonical node is NOT_FOUND, as it is for `tree`.

export const timelineInputSchema = z.object({
  anchorId: z.string().min(1, "must not be empty"),
  nodeTypes: z.array(z.string().min(1)).min(1).max(MAX_LIST_NAMES).optional(),
  sourceSystems: z.array(z.string().min(1)).min(1).max(MAX_LIST_NAMES).optional(),
  limit: z.number().int().positive().max(MAX_TIMELINE_LIMIT).optional(),
  /** Opaque: a previous response's `nextCursor`, passed back unchanged. */
  cursor: z.object({ occurredAt: z.string().min(1).max(64), id: z.string().min(1).max(64) }).optional(),
});

const timelineProcedure = publicProcedure.input(timelineInputSchema).query(async ({ ctx, input }) => {
  let result;
  try {
    result = await getTimeline(ctx.db, input.anchorId, {
      nodeTypes: input.nodeTypes ?? null,
      sourceSystems: input.sourceSystems ?? null,
      limit: input.limit,
      cursor: input.cursor ?? null,
    });
  } catch (err) {
    throw mapCoreError("timeline", err);
  }

  return boundResponse(
    result.rows,
    (row) => row.id,
    (kept, meta) => {
      const last = kept[kept.length - 1];
      const hasMore = result.hasMore || meta.droppedIds.length > 0;
      return {
        anchorId: result.anchorId,
        rows: kept,
        hasMore,
        nextCursor: hasMore && last ? { occurredAt: last.occurredAt, id: last.id } : null,
        untimedCount: result.untimedCount,
        truncated: meta.truncated,
        droppedNodeIds: meta.droppedIds,
        shrunkNodeIds: meta.shrunkIds,
      };
    },
    ctx.responseCharBudget,
  );
});

export const readRouter = router({
  search: searchProcedure,
  getNeighbors: getNeighborsProcedure,
  getNodes: getNodesProcedure,
  getStoreSummary: getStoreSummaryProcedure,
  listUnlinkedNotes: listUnlinkedNotesProcedure,
  list: listProcedure,
  find: findProcedure,
  resolveDefaultViews: resolveDefaultViewsProcedure,
  tree: treeProcedure,
  timeline: timelineProcedure,
});
