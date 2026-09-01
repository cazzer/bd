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
import { colorForNodeType, colorForSourceSystem } from "./palette.js";
import type { trpc } from "../trpc.js";

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
      // `Neighbor` (packages/core/src/lookup.ts) carries no store-wide
      // degree — only `retrieve()`'s `RetrievedNode` does, by design
      // (design.md: "Degree is computed per query, for the returned
      // nodes only"). A node reached by expansion therefore starts at
      // `degreeToRadius`'s own floor for degree 0 — the SAME visible-
      // minimum a genuinely degree-zero node gets, not a fabricated
      // number — rather than either lying about size or reaching into
      // `@breakdown/core` for a value this DTO doesn't carry (out of
      // scope: this ticket does not modify packages/core or the server
      // procedures). If the same node later comes back from a *search*,
      // `mergeGraphData`'s `Object.assign` corrects degree/radius onto
      // the SAME object, in place, without disturbing its by-then-
      // settled position.
      degree: 0,
      radius: degreeToRadius(0),
      color: colorForNodeType(neighbor.nodeType),
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
      color: colorForSourceSystem(neighbor.edgeSourceSystem),
      width: weightToEdgeWidth(neighbor.weight),
    });
  }

  return mergeGraphData(previous, {
    nodes: [...previous.nodes, ...newNodes],
    links: [...previous.links, ...newLinks],
  });
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
