// Progressive expansion (bd-hmd.5, tasks.md 5.1-5.5): turning a
// `getNeighbors` response into an accumulated merge onto the running
// graph, plus the pin/release mutations that keep that merge from
// disturbing every node already on screen.
//
// --- Why identity (mergeGraphData) is necessary but not sufficient ------
//
// encoding.ts's `mergeGraphData` (bd-hmd.4 review) already solves "reuse
// object identity so a node's x/y/vx/vy/fx/fy survive a graphData
// update" — see that function's own header for the full trace. This
// ticket's own investigation (see the ticket report) found that identity
// alone still does not hold placed nodes still: `force-graph`'s
// `update()` (traced through the installed source, force-graph.mjs)
// runs `state.forceLayout.stop().alpha(1).nodes(state.graphData.nodes)`
// on ANY `graphData` prop reference change — unconditionally, regardless
// of whether the node objects inside are the ones it already knows
// about. `alpha(1)` re-heats the WHOLE simulation, and every node whose
// position is governed by the simulation (i.e. every node without a
// fixed position) drifts as it re-settles, even though its x/y/vx/vy
// were never reset.
//
// d3-force's per-tick node update is unconditional on ONE thing only:
// a node with `fx`/`fy` set is copied `x = fx, y = fy` (and `vx = vy =
// 0`) EVERY tick, regardless of `alpha` or any computed force. That is
// the one lever this module adds on top of identity: `mergeExpansion`
// pins every already-placed node's `fx`/`fy` to its current `x`/`y`
// BEFORE building the merged graph, so the reheat `update()` is about to
// force has nothing left to move except the brand-new arrivals (which
// enter with only `x`/`y` seeded — no `fx`/`fy` — so they DO settle).
//
// --- Release: a mutation, not another graphData swap ---------------------
//
// `releasePins` is deliberately NOT wired through `setGraph`/React state.
// If it were, returning a new object/array reference would itself be a
// `graphData` prop change, and `update()` would run its unconditional
// `.alpha(1)` reheat a SECOND time — undoing the whole point of pinning.
// Instead it mutates the same node objects force-graph is already
// holding a reference to (`delete node.fx; delete node.fy`), exactly the
// pattern force-graph's OWN node-drag handler uses to release a node at
// drag-end (traced in force-graph.mjs: `obj.fx = undefined` with no
// `graphData` update at all). GraphCanvas.tsx calls it from
// `onEngineStop` — see that file for why that callback is the right
// settle-detection signal (cooldownTicks-bounded, so release is neither
// "too early" — before the new nodes have actually settled — nor
// "never" — the pins are always cleared once the simulation stops
// ticking, whether that's 200 ticks or the very next frame).

import type { GraphCanvasData, GraphLink, GraphNode } from "./encoding.js";
import { degreeToRadius, mergeGraphData, weightToEdgeWidth } from "./encoding.js";
import { endpointId } from "./nodeEdges.js";
import { familyKeyForEdgeType } from "./palette.js";
import type { trpc } from "../trpc.js";

// --- Client-side mirrors of packages/core/src/human-writes.ts's write
// constants (bd-hmd.6). NOT imported from `@breakdown/core`: dto.ts's
// header traces why a static import from that package's barrel — even of
// a dependency-free string constant — pulls the Node-only `pg` driver
// into the Vite client bundle (human-writes.ts sits behind the same
// barrel as everything else `@breakdown/core` exports, and the barrel's
// re-exports are unconditional). palette.ts established this exact
// convention for the same reason; its `SOURCE_SYSTEM_COLORS` table was
// the original example and bd-o1e deleted it, but the convention it set
// (duplicate the literal rather than import through the barrel) is
// unchanged — one more place, not a new pattern.
export const HUMAN_SOURCE_SYSTEM = "human";
export const NOTE_NODE_TYPE = "note";
export const ANNOTATES_EDGE_TYPE = "annotates";

// --- API result types, derived from the live client (same reasoning as
// encoding.ts's SearchResult: a server-side shape change breaks these
// call sites at typecheck time, no hand-typed duplicate to drift). -------

export type NeighborsResult = Awaited<ReturnType<typeof trpc.getNeighbors.query>>;
export type ExpandedNeighbor = NeighborsResult["neighbors"][number];
export type NeighborsCursor = NonNullable<NeighborsResult["nextCursor"]>;

/** A GraphNode as force-graph actually holds it: x/y/fx/fy are added by mutation once the simulation has run — GraphNode itself declares none of them (see encoding.ts). */
export type PositionedNode = GraphNode & { x?: number; y?: number; fx?: number; fy?: number };

// --- Pin / release ---------------------------------------------------------

/**
 * Fixes every node that already has a real position (`x`/`y` both
 * numbers — i.e. has been through at least one simulation tick) to that
 * position, via `fx`/`fy`. A node with no position yet (shouldn't happen
 * for anything already clickable, but guarded rather than assumed) is
 * left alone — pinning `fx = undefined` would do nothing useful and
 * `NaN` would be actively wrong.
 *
 * Mutates in place; the return value is the same array, for convenient
 * chaining at the one call site that needs both "pin" and "here is the
 * pinned set" (`mergeExpansion`, below).
 */
export function pinPlacedNodes(nodes: readonly PositionedNode[]): readonly PositionedNode[] {
  for (const node of nodes) {
    if (typeof node.x === "number" && typeof node.y === "number") {
      node.fx = node.x;
      node.fy = node.y;
    }
  }
  return nodes;
}

/** Clears every node's fixed position. See the module header for why this must be a plain mutation, never a `graphData` swap. */
export function releasePins(nodes: readonly PositionedNode[]): void {
  for (const node of nodes) {
    delete node.fx;
    delete node.fy;
  }
}

// --- Merging a getNeighbors response onto the running graph --------------

export interface ExpansionParams {
  /** `GetNeighborsResult.canonicalId` — the node whose neighbours these are, resolved through any merge chain. NOT necessarily the id the click handler had in hand (see NeighborsCursor's own canonicalId binding, and this module's report on why the caller threads the response's own canonicalId through rather than assuming the clicked id was already canonical). */
  parentId: string;
  /** The parent's current on-screen position, so brand-new neighbours seed adjacent to it rather than at the origin (graph-explorer/spec.md, "New nodes enter near their parent"). `undefined` only when the parent itself has no charted position yet — falls back to no explicit seed, i.e. force-graph's own default placement for a node with no x/y. */
  parentPosition: { x: number; y: number } | undefined;
  neighbors: readonly ExpandedNeighbor[];
}

/**
 * Accumulates an expansion's neighbours onto `previous` and returns the
 * merged graph, pinning every already-placed node's position first (see
 * module header for why pin-then-merge has to happen as one step, not
 * two the caller could get out of order or out of sync).
 *
 * `previous`'s own nodes/links are threaded into `mergeGraphData`'s
 * `incoming` argument alongside the new ones — that function's `incoming`
 * is authoritative for which ids survive (encoding.ts: "an id present
 * only in `previous` is dropped"), which is exactly right for a fresh
 * SEARCH replacing the view but wrong for an expansion, which is meant to
 * ACCUMULATE. Including `previous.nodes`/`previous.links` verbatim in
 * `incoming` is what turns "replace" into "accumulate" — see
 * encoding.ts's own header, which names this exact technique.
 *
 * Two dedup passes happen before that union, both driven by ids already
 * present in `previous` (graph-explorer/spec.md, "Expanding a node
 * already on screen"):
 *   - a neighbour whose `nodeId` is already drawn contributes NO new node
 *     entry (drawing one would duplicate it — a second array entry
 *     resolving to the same reused object) but DOES still contribute its
 *     edge, so the connection is drawn even though the node was not;
 *   - a neighbour whose `edgeId` is already drawn (a re-fetched page, or
 *     two expansions that happen to share an edge) contributes no
 *     duplicate link entry either.
 */
export function mergeExpansion(previous: GraphCanvasData, params: ExpansionParams): GraphCanvasData {
  pinPlacedNodes(previous.nodes as readonly PositionedNode[]);

  const drawnNodeIds = new Set(previous.nodes.map((n) => n.id));
  const drawnLinkIds = new Set(previous.links.map((l) => l.id));

  const newNodes: GraphNode[] = [];
  for (const neighbor of params.neighbors) {
    if (drawnNodeIds.has(neighbor.nodeId)) {
      continue; // already drawn (possibly by an earlier page of this very expansion) — no duplicate
    }
    drawnNodeIds.add(neighbor.nodeId); // a page can legitimately name the same node twice via two different edges

    const node: PositionedNode = {
      id: neighbor.nodeId,
      title: neighbor.title,
      nodeType: neighbor.nodeType,
      sourceSystem: neighbor.nodeSourceSystem,
      // `Neighbor.degree` (packages/core/src/lookup.ts, bd-hmd.5 review)
      // is the SAME store-wide aggregate `retrieve()`'s `RetrievedNode`
      // computes — see `buildGetNeighborsQuery`'s "degree" CTE comment
      // for the derivation. This has to be the real number, not a
      // fallback: graph-explorer/spec.md's "Size is stable across views"
      // requires a node to draw at the same size whether it arrived by
      // search or by expansion, and a degree-0 placeholder here would
      // draw exactly the nodes progressive exploration exists to surface
      // at the wrong size. If the same node later comes back from a
      // *search*, `mergeGraphData`'s `Object.assign` still overwrites
      // degree/radius onto the SAME object in place (both paths agree on
      // the number, per lookup.test.ts's "agrees with retrieve()'s
      // degree" test, so this is idempotent, not just harmless).
      degree: neighbor.degree,
      radius: degreeToRadius(neighbor.degree),
      // No `color` here — see encoding.ts's GraphNode.color comment:
      // node-type colour is a render-time lookup against App.tsx's
      // store-wide rank map (bd-4ye), done in GraphCanvas, not baked in
      // by this builder.
      isEditable: neighbor.isEditable,
      // Never "seed" — graph-explorer/spec.md's "An expanded node
      // carries no relevance" scenario, verbatim. `edgePath` records
      // just this one hop's edge type; there is no seed to trace a
      // longer path back to.
      provenance: { kind: "path", edgePath: [neighbor.edgeType] },
    };
    if (params.parentPosition) {
      node.x = params.parentPosition.x;
      node.y = params.parentPosition.y;
    }
    newNodes.push(node);
  }

  const newLinks: GraphLink[] = [];
  for (const neighbor of params.neighbors) {
    if (drawnLinkIds.has(neighbor.edgeId)) {
      continue;
    }
    drawnLinkIds.add(neighbor.edgeId);

    // `direction` is relative to the PARENT (packages/core/src/lookup.ts's
    // Neighbor: "outgoing" means the parent is the edge's source). Get
    // this backwards and every expanded edge would point the wrong way.
    const [source, target] = neighbor.direction === "outgoing" ? [params.parentId, neighbor.nodeId] : [neighbor.nodeId, params.parentId];
    newLinks.push({
      id: neighbor.edgeId,
      source,
      target,
      edgeType: neighbor.edgeType,
      sourceSystem: neighbor.edgeSourceSystem,
      weight: neighbor.weight,
      family: familyKeyForEdgeType(neighbor.edgeType),
      width: weightToEdgeWidth(neighbor.weight),
    });
  }

  return pinThenMerge(previous, newNodes, newLinks);
}

// --- Shared pin-then-merge primitive, and the bd-hmd.6 write paths that
// reuse it -------------------------------------------------------------
//
// mergeExpansion's own shape (a parent plus its neighbors) can't
// represent every write this ticket adds: a standalone note has no
// parent at all, and a hand-drawn edge between two nodes ALREADY on
// screen adds a link but no node. Rather than duplicate the pin/merge
// mechanism mergeExpansion's header describes, the append step is
// factored out here (`pinThenMerge`) and every write path below —
// mergeExpansion included, see its tail above — goes through the same
// two calls: `pinPlacedNodes` (freeze everything already on screen) then
// `mergeGraphData` (identity-preserving union). GraphCanvas's existing
// `onEngineStop` -> `releasePins` call needs no change for any of these:
// it already operates on whatever `data.nodes` currently is, regardless
// of which of these functions produced it.

/** `previous` plus `newNodes`/`newLinks`, appended — the pin-then-merge mechanism mergeExpansion's own header documents, shared by every write path in this module. `newNodes`/`newLinks` may be empty (a links-only or nodes-only addition still needs existing nodes pinned: force-graph's `update()` reheats the whole simulation on ANY `graphData` reference change, per the module header, not only when `nodes` itself changed). */
function pinThenMerge(previous: GraphCanvasData, newNodes: readonly GraphNode[], newLinks: readonly GraphLink[]): GraphCanvasData {
  pinPlacedNodes(previous.nodes as readonly PositionedNode[]);
  return mergeGraphData(previous, {
    nodes: [...previous.nodes, ...newNodes],
    links: [...previous.links, ...newLinks],
  });
}

/**
 * Builds the single synthetic neighbor `mergeExpansion` needs to draw an
 * annotation's note and its `annotates` edge (bd-hmd.6, task 6.3) — the
 * literal reuse this ticket asks for, not a lookalike: `annotateNode`'s
 * result plus the title the person typed is enough to construct exactly
 * the shape `getNeighbors` would have returned had the note already
 * existed. `direction: "incoming"` because the edge is `note
 * ---annotates---> target` (packages/core/src/human-writes.ts's
 * `annotateNode`), and `Neighbor.direction` is relative to the PARENT —
 * here, the annotated (target) node — so the target RECEIVES the edge.
 * `degree: 1` is exact, not a placeholder: the note is brand new, so its
 * only edge is this one.
 */
export function buildAnnotationNeighbor(result: { noteId: string; noteExternalId: string; annotationEdgeId: string }, title: string | undefined): ExpandedNeighbor {
  return {
    edgeId: result.annotationEdgeId,
    direction: "incoming",
    edgeType: ANNOTATES_EDGE_TYPE,
    weight: 1,
    edgeSourceSystem: HUMAN_SOURCE_SYSTEM,
    nodeId: result.noteId,
    nodeType: NOTE_NODE_TYPE,
    nodeSourceSystem: HUMAN_SOURCE_SYSTEM,
    externalId: result.noteExternalId,
    title: title && title.trim().length > 0 ? title : "(untitled note)",
    degree: 1,
    isEditable: true,
  };
}

/**
 * A freshly created standalone note (bd-hmd.6, task 6.4), as a
 * `GraphNode` ready to merge onto the canvas — degree 0, since a note
 * `createNote` just made has no edges by construction (annotation, which
 * DOES add an edge, goes through `buildAnnotationNeighbor` + `mergeExpansion`
 * above instead).
 */
export function buildStandaloneNoteNode(result: { id: string }, title: string | undefined): GraphNode {
  return {
    id: result.id,
    title: title && title.trim().length > 0 ? title : "(untitled note)",
    nodeType: NOTE_NODE_TYPE,
    sourceSystem: HUMAN_SOURCE_SYSTEM,
    degree: 0,
    radius: degreeToRadius(0),
    // No `color` here — see buildAnnotationNeighbor-adjacent comment
    // above/GraphNode.color's own comment in encoding.ts.
    isEditable: true,
    provenance: { kind: "path", edgePath: [] },
  };
}

/** The shape `listUnlinkedNotes` (server/routers/read.ts) returns per note — enough to draw it, and degree is always 0 by construction of that list (see this file's `graphNodeFromUnlinkedNote`). */
export interface UnlinkedNote {
  id: string;
  title: string;
  nodeType: string;
  sourceSystem: string;
  isEditable: boolean;
}

/** An already-existing, previously-unlinked note (bd-hmd.6, task 6.4's "surface an unlinked-notes list") drawn onto the canvas by request — degree 0, same reasoning as `buildStandaloneNoteNode`, except the note isn't new here, `listUnlinkedNotes` already found it. */
export function graphNodeFromUnlinkedNote(note: UnlinkedNote): GraphNode {
  return {
    id: note.id,
    title: note.title || "(untitled note)",
    nodeType: note.nodeType,
    sourceSystem: note.sourceSystem,
    degree: 0,
    radius: degreeToRadius(0),
    // No `color` here — same reasoning as buildStandaloneNoteNode above.
    isEditable: note.isEditable,
    provenance: { kind: "path", edgePath: [] },
  };
}

/** Adds a node with no edges (bd-hmd.6: a freshly created standalone note, or a previously-unlinked one drawn by request) via the same pin-then-merge mechanism as every other write path here. A no-op merge (still pins, still returns a fresh wrapper object) when `node.id` is already drawn, so calling this blindly for a node that might already be on screen is safe. */
export function mergeStandaloneNode(previous: GraphCanvasData, node: GraphNode): GraphCanvasData {
  const alreadyDrawn = previous.nodes.some((n) => n.id === node.id);
  return pinThenMerge(previous, alreadyDrawn ? [] : [node], []);
}

/**
 * A hand-drawn edge (bd-hmd.6, task 6.5's "assert ... between two
 * nodes"), as a `GraphLink` ready to merge — family/width come from the
 * same `familyKeyForEdgeType`/`weightToEdgeWidth` every other edge uses,
 * so a hand-authored edge is drawn by its RELATION exactly as a loaded
 * one is (bd-o1e, design.md decision 1). It reads as hand-authored by
 * carrying `human` as its source system, which the tooltip and the
 * legend's composition line report — the styling itself no longer
 * depends on where an edge came from.
 */
export function buildAssertedLink(result: { id: string }, input: { srcId: string; dstId: string; edgeType: string; weight?: number }): GraphLink {
  const weight = input.weight ?? 1.0; // matches packages/core/src/edges.ts's own default when omitted
  return {
    id: result.id,
    source: input.srcId,
    target: input.dstId,
    edgeType: input.edgeType,
    sourceSystem: HUMAN_SOURCE_SYSTEM,
    weight,
    family: familyKeyForEdgeType(input.edgeType),
    width: weightToEdgeWidth(weight),
  };
}

/** Adds a hand-drawn edge between two nodes already on screen. No new node, so degree is deliberately left untouched here — see encoding.ts's `setNodeDegree` header for why an edge between two PRE-EXISTING nodes can't safely be assumed to change either endpoint's degree (they may already be connected by a different edge). */
export function mergeAssertedEdge(previous: GraphCanvasData, link: GraphLink): GraphCanvasData {
  return pinThenMerge(previous, [], [link]);
}

/** Removes one link by id (bd-hmd.6, task 6.5's "retract") — pins placed nodes first for the same reason every function in this section does (see `pinThenMerge`'s own comment: even a links-only change reheats the whole simulation), then relies on `mergeGraphData`'s own rule that an id present only in `previous` is dropped — omitting the retracted link from `incoming.links` IS the removal. */
export function mergeRetractedEdge(previous: GraphCanvasData, linkId: string): GraphCanvasData {
  pinPlacedNodes(previous.nodes as readonly PositionedNode[]);
  return mergeGraphData(previous, { nodes: previous.nodes, links: previous.links.filter((l) => l.id !== linkId) });
}

/** Changes one link's weight (and its derived width — its relation family does not depend on weight) in place (bd-hmd.6, task 6.5's "reweight") — pins placed nodes first, same reasoning as `mergeRetractedEdge`, then relies on `mergeGraphData`'s `Object.assign(existing, incoming)` for a matching id to mutate the SAME link object force-graph already holds, rather than replacing it. */
export function mergeReweightedEdge(previous: GraphCanvasData, linkId: string, weight: number): GraphCanvasData {
  pinPlacedNodes(previous.nodes as readonly PositionedNode[]);
  const links = previous.links.map((l) => (l.id === linkId ? { ...l, weight, width: weightToEdgeWidth(weight) } : l));
  return mergeGraphData(previous, { nodes: previous.nodes, links });
}

/**
 * Patches one placed node's own fields in place (bd-hmd.6: a saved
 * content edit may have changed the node's title, which the canvas
 * displays). Pins placed nodes first for the same reason every function
 * in this section does — even a title-only change is a fresh `graph`
 * object from React's point of view, which is enough to make force-graph
 * reheat the whole simulation on the next `graphData` update unless
 * everything already placed is pinned first.
 */
export function mergeNodePatch(previous: GraphCanvasData, nodeId: string, patch: Partial<GraphNode>): GraphCanvasData {
  pinPlacedNodes(previous.nodes as readonly PositionedNode[]);
  const node = previous.nodes.find((n) => n.id === nodeId);
  if (node) Object.assign(node, patch);
  return { nodes: previous.nodes, links: previous.links };
}

// --- Per-node pagination state ---------------------------------------------
//
// graph-explorer/spec.md's expansion scenarios plus bd-hmd.1's review
// finding ("a cursor minted for one node, applied to another, silently
// drops neighbours") together require: (1) each node's next-page cursor
// is remembered independently, and (2) there is no shared "current
// selection" slot a fetch for one node could read while a different
// node is mid-fetch. A `Map` keyed by node id gives both for free — node
// B's entry is a different object from node A's, always, so there is no
// slot for a stale read to land in even under maximally adversarial
// interleaving (App.tsx additionally guards true request concurrency
// with a ref; see its own comment for why a React-state read alone
// isn't enough for that half of it).

export interface ExpansionEntry {
  status: "idle" | "loading" | "error";
  /** True until proven otherwise — an unattempted node is assumed possibly-expandable, same as one whose last attempt errored before learning the real answer. */
  hasMore: boolean;
  /** Null means "first page" — same convention as `GetNeighborsOptions.cursor` (packages/core). */
  cursor: NeighborsCursor | null;
  errorMessage?: string;
}

export type ExpansionEntries = ReadonlyMap<string, ExpansionEntry>;

/** Whether clicking node `id` right now should fire a request: not while a request for THIS node is already in flight (per its last-known status), and not once this node's neighbours are fully drawn. */
export function shouldFetchExpansion(entries: ExpansionEntries, id: string): boolean {
  const entry = entries.get(id);
  if (!entry) return true;
  if (entry.status === "loading") return false;
  return entry.hasMore;
}

/** The cursor to send for node `id`'s NEXT page — always read from `id`'s own entry, never a shared "selected node" slot. */
export function cursorForExpansion(entries: ExpansionEntries, id: string): NeighborsCursor | null {
  return entries.get(id)?.cursor ?? null;
}

export function withExpansionLoading(entries: ExpansionEntries, id: string): Map<string, ExpansionEntry> {
  const prior = entries.get(id);
  const next = new Map(entries);
  next.set(id, { status: "loading", hasMore: prior?.hasMore ?? true, cursor: prior?.cursor ?? null });
  return next;
}

export function withExpansionResult(entries: ExpansionEntries, id: string, result: { hasMore: boolean; nextCursor: NeighborsCursor | null }): Map<string, ExpansionEntry> {
  const next = new Map(entries);
  next.set(id, { status: "idle", hasMore: result.hasMore, cursor: result.nextCursor });
  return next;
}

export function withExpansionError(entries: ExpansionEntries, id: string, message: string): Map<string, ExpansionEntry> {
  const prior = entries.get(id);
  const next = new Map(entries);
  next.set(id, { status: "error", hasMore: prior?.hasMore ?? true, cursor: prior?.cursor ?? null, errorMessage: message });
  return next;
}

/** Node ids currently known to have withheld neighbours — graph-explorer/spec.md's "Hub expansion is bounded": "the explorer SHALL say so and SHALL offer a way to draw more." Drives both GraphCanvas's on-canvas indicator and the sr-only list's text (see accessibility.ts). */
export function expandableNodeIds(entries: ExpansionEntries): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const [id, entry] of entries) {
    if (entry.hasMore) ids.add(id);
  }
  return ids;
}

// --- Collapsing an expansion (bd-jar, design.md decision 6) ---------------
//
// Until this, the canvas only ever grew: every function above merges, none
// removes, so two clicks on a hub turned a legible 40-node result into a
// blob and the only way back was to run the search again — losing every
// other expansion with it.
//
// What makes removal non-trivial is that a node can be on screen for more
// than one reason. A file reached by expanding a directory may also be a
// search seed, or a neighbour of a second directory expanded later.
// Collapsing one of those must not take it away.
//
// So presence is tracked as a set of HOLDERS per node: the sentinel
// `QUERY_HOLDER` for anything the current search returned, plus the id of
// every node whose expansion introduced it. Collapsing X removes X from
// every holder set and drops only the nodes left holding nothing.
//
// Why holders and not an undo stack of graph snapshots: a stack grows
// with exploration, and replaying a snapshot restores the POSITIONS
// recorded in it, which is exactly the spatial-memory violation this
// module's pin-then-merge choreography exists to prevent. Holders are
// O(nodes) regardless of how long someone explores, and removal keeps the
// surviving node OBJECTS — identity, `x`/`y` and all — so nothing that
// stays on screen moves.
//
// Kept as a map beside the graph rather than a field on `GraphNode`
// deliberately: `mergeGraphData` merges nodes with `Object.assign(existing,
// incoming)`, which would REPLACE a holder set rather than union it, and
// every merge path above would then have to remember to union by hand.
// A structure no write path can silently corrupt beats one that relies on
// every future caller remembering.

/**
 * Marks a node as on screen for a reason that is not an expansion: a
 * search result, a note the person just created, an annotation, or a
 * deep-linked node drawn on its own. Not a node id — no node can be
 * named "query", since ids are uuids.
 *
 * The distinction that matters is ROOT versus derived. A root-held node
 * survives collapsing anything; a node held only by other nodes survives
 * exactly as long as one of those does.
 */
export const QUERY_HOLDER = "query";

export type HolderMap = ReadonlyMap<string, ReadonlySet<string>>;

/** Every node in a fresh search result, held by the query alone. Replaces the previous map wholesale: a new search is a new view, and the old holders described nodes that are no longer drawn. */
export function holdersForSearch(nodes: readonly GraphNode[]): HolderMap {
  return new Map(nodes.map((node) => [node.id, new Set([QUERY_HOLDER])]));
}

/** Records that `parentId`'s expansion is now a reason each of `nodeIds` is on screen. A node already held by something else gains a holder rather than replacing it. */
export function withExpansionHolders(holders: HolderMap, parentId: string, nodeIds: readonly string[]): HolderMap {
  const next = new Map<string, Set<string>>();
  for (const [id, set] of holders) next.set(id, new Set(set));
  for (const id of nodeIds) {
    const set = next.get(id) ?? new Set<string>();
    set.add(parentId);
    next.set(id, set);
  }
  // The parent itself is held by whatever put it on screen; expanding it
  // does not make it hold itself, or collapsing it would remove it.
  return next;
}

/** Adds a single node under one holder — for the standalone-note and annotation paths, which add a node without being an expansion. */
export function withHolder(holders: HolderMap, nodeId: string, holder: string): HolderMap {
  return withExpansionHolders(holders, holder, [nodeId]);
}

function pruneTo(previous: GraphCanvasData, keptIds: ReadonlySet<string>): GraphCanvasData {
  // Pin first: the survivors keep their exact positions, so removing part
  // of the graph never re-lays-out the part that stays (graph-explorer/
  // spec.md, "everything remaining stays where it was").
  pinPlacedNodes(previous.nodes as readonly PositionedNode[]);
  return {
    // The SAME node objects, filtered — not copies. force-graph holds
    // these by reference and has written x/y onto them.
    nodes: previous.nodes.filter((node) => keptIds.has(node.id)),
    links: previous.links.filter((link) => keptIds.has(endpointId(link.source)) && keptIds.has(endpointId(link.target))),
  };
}

export interface CollapseResult {
  graph: GraphCanvasData;
  holders: HolderMap;
  /** Ids actually removed — the caller drops their expansion entries so a re-expansion refetches. */
  removedIds: string[];
}

/**
 * Undoes one node's expansion. `parentId` itself always stays: it is on
 * screen for whatever reason put it there, which expanding it did not
 * change.
 */
/**
 * Which nodes are still held, transitively.
 *
 * A node survives if it is held by QUERY_HOLDER, or by another node that
 * itself survives. Computed as a reachability fixpoint rather than one
 * pass over the holder sets, because holding is a CHAIN: expand S to
 * reach F, then expand F to reach C, and C's holder set names F, not S.
 * A single pass removing `parentId` from every set empties F's set and
 * drops it, but leaves C holding {F} — a set nothing can ever empty
 * again, since F is gone and cannot be collapsed a second time. C then
 * floats unreachable and unremovable for the life of the query, with its
 * only edge pruned away underneath it.
 *
 * That was the first version of this function, and its own test suite
 * built the s1 -> e1 -> e2 chain that exposes it but only ever ran it
 * through `resetToSeeds`.
 *
 * A node with no holder entry at all is treated as root-held: losing a
 * node the person can see is worse than keeping one collapse cannot
 * reach.
 */
function reachableIds(nodes: readonly GraphNode[], holders: HolderMap): Set<string> {
  const present = new Set(nodes.map((n) => n.id));
  const reachable = new Set<string>();
  const frontier: string[] = [];

  for (const node of nodes) {
    const set = holders.get(node.id);
    if (set === undefined || set.has(QUERY_HOLDER)) {
      reachable.add(node.id);
      frontier.push(node.id);
    }
  }

  // Anything held by a node already known to survive, survives too —
  // repeated until nothing new is found. Bounded by the node count, since
  // an id enters `reachable` at most once.
  while (frontier.length > 0) {
    const holder = frontier.pop()!;
    for (const node of nodes) {
      if (reachable.has(node.id)) continue;
      if (!present.has(node.id)) continue;
      if (holders.get(node.id)?.has(holder)) {
        reachable.add(node.id);
        frontier.push(node.id);
      }
    }
  }
  return reachable;
}

export function collapseExpansion(previous: GraphCanvasData, holders: HolderMap, parentId: string): CollapseResult {
  // Drop this expansion's claim, then ask what is still reachable.
  const without = new Map<string, Set<string>>();
  for (const [id, set] of holders) {
    const trimmed = new Set(set);
    trimmed.delete(parentId);
    without.set(id, trimmed);
  }
  // The collapsed node itself always stays: it is on screen for whatever
  // put it there, which expanding it did not change.
  const kept = reachableIds(previous.nodes, without);
  kept.add(parentId);

  const removedIds = previous.nodes.filter((n) => !kept.has(n.id)).map((n) => n.id);
  const next = new Map<string, Set<string>>();
  for (const [id, set] of without) {
    if (kept.has(id)) next.set(id, set);
  }
  return { graph: pruneTo(previous, kept), holders: next, removedIds };
}

/** Discards every expansion, leaving the current search result. Does not re-run the query — the nodes are already here. */
export function resetToSeeds(previous: GraphCanvasData, holders: HolderMap): CollapseResult {
  const next = new Map<string, Set<string>>();
  const removedIds: string[] = [];
  for (const node of previous.nodes) {
    const set = holders.get(node.id);
    // No entry, or root-held: kept. Everything else is here only because
    // of an expansion, which is exactly what reset discards.
    if (set === undefined || set.has(QUERY_HOLDER)) {
      next.set(node.id, new Set([QUERY_HOLDER]));
      continue;
    }
    removedIds.push(node.id);
  }
  const keptIds = new Set(previous.nodes.filter((n) => !removedIds.includes(n.id)).map((n) => n.id));
  return { graph: pruneTo(previous, keptIds), holders: next, removedIds };
}
