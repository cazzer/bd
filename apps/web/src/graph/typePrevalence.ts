// Pure ranking for TypePanel (bd-14q, design.md "Type control: ranked by
// prevalence, defaults to top types, drives a canvas focus"). Two entry
// points, matching the two views design.md describes:
//   - topStoreTypes: store-wide types by count, for the no-selection
//     default view. getStoreSummary().nodeTypes is already sorted this
//     way server-side (retrieval.ts's buildStoreSummaryQuery), but this
//     re-sorts rather than trust that ordering — it must be correct and
//     testable standing alone, not merely "correct because the caller
//     already sorted."
//   - rankNeighborTypes: a selected node's on-screen neighbours' types,
//     ranked by how many DISTINCT neighbours carry each one — reads only
//     the graph already drawn (App.tsx's `graph.nodes`/`graph.links`),
//     never a new fetch, per design.md's own "why derive from the drawn
//     graph, not the store" rationale.
//
// Both share one tie-break — count descending, then node_type name
// ascending — so every type-ranked list in the app (this module's two
// functions, plus lib/typeMatch.ts's suggestion ranking) orders
// identically on a tie.

import type { GraphLink, GraphNode } from "./encoding.js";
import { endpointId } from "./nodeEdges.js";

export interface TypeCount {
  nodeType: string;
  count: number;
}

function sortByCountThenName(a: TypeCount, b: TypeCount): number {
  return b.count - a.count || a.nodeType.localeCompare(b.nodeType);
}

/**
 * How many nodes of each type are DRAWN right now (bd-857), ranked by the
 * same tie-break as everything else here.
 *
 * The third ranking, and the one the type control leads with. It used to
 * lead with `topStoreTypes` — store-wide counts — beside a canvas showing
 * a search result, so it read `gh-pr 584` while the canvas held no
 * `gh-pr` at all. A legend that does not describe the picture beside it
 * is worse than no legend: a reader takes it as a key.
 *
 * `topStoreTypes` stays, and stays useful — "552 more of these exist
 * that you are not looking at" is real information. It is just the
 * secondary figure now, not the headline.
 */
export function drawnTypeCounts(nodes: readonly GraphNode[]): TypeCount[] {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    counts.set(node.nodeType, (counts.get(node.nodeType) ?? 0) + 1);
  }
  return [...counts.entries()].map(([nodeType, count]) => ({ nodeType, count })).sort(sortByCountThenName);
}

/** Top `limit` store-wide types by count — the type control's default (no node selected) view. */
export function topStoreTypes(nodeTypes: readonly TypeCount[], limit: number): TypeCount[] {
  return [...nodeTypes].sort(sortByCountThenName).slice(0, limit);
}

/**
 * How many of `nodeId`'s on-screen neighbours carry each node type. A
 * "neighbour" is the other endpoint of every link in `links` touching
 * `nodeId` — normalised via `endpointId` the same way nodeEdges.ts does,
 * since force-graph may already have replaced a link's `source`/`target`
 * string id with the resolved node object by the time this runs.
 *
 * A neighbour counts once per type even when more than one edge connects
 * it to `nodeId` — this is a distinct-neighbour count, not an edge count,
 * so neighbour ids are deduplicated into a Set before any type is
 * tallied. A self-loop (source === target === nodeId) has no "other"
 * endpoint and contributes nothing. A neighbour whose type is absent
 * from palette.ts's known set still ranks here exactly like any other —
 * this module has no dependency on palette.ts at all; falling back to a
 * generic swatch colour for an unrecognised type is TypePanel's concern,
 * not this pure function's. A node with no neighbours (or one not
 * present in `nodes` at all) returns `[]`.
 */
export function rankNeighborTypes(nodeId: string, nodes: readonly GraphNode[], links: readonly GraphLink[]): TypeCount[] {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));

  const neighborIds = new Set<string>();
  for (const link of links) {
    const src = endpointId(link.source);
    const dst = endpointId(link.target);
    if (src === nodeId && dst !== nodeId) {
      neighborIds.add(dst);
    } else if (dst === nodeId && src !== nodeId) {
      neighborIds.add(src);
    }
  }

  const counts = new Map<string, number>();
  for (const neighborId of neighborIds) {
    const neighbor = nodesById.get(neighborId);
    if (!neighbor) continue; // a link naming a node not in this graph — defensively skipped, never a crash
    counts.set(neighbor.nodeType, (counts.get(neighbor.nodeType) ?? 0) + 1);
  }

  return [...counts.entries()].map(([nodeType, count]) => ({ nodeType, count })).sort(sortByCountThenName);
}

/**
 * Splits ranked types into the ones the palette gave a colour and the
 * ones it did not (bd-857).
 *
 * `assignTypeColors` hands out CATEGORICAL_PALETTE's eight slots by
 * store-wide rank and gives everything past that the same
 * `FALLBACK_COLOR`. Those types are indistinguishable ON THE CANVAS, so
 * the control names them as one group rather than listing them as
 * separate rows that happen to look alike.
 *
 * Membership is decided by the colour a type actually resolves to, not
 * by its position in this list — a fallback-coloured type can rank high
 * on the canvas while ranking low store-wide, and it is still
 * indistinguishable when drawn. Order within each half is preserved, so
 * the caller's ranking survives the split.
 */
export function splitPaletteOverflow(
  rows: readonly TypeCount[],
  colorOf: (nodeType: string) => string,
  fallbackColor: string,
): { coloured: TypeCount[]; overflow: TypeCount[] } {
  const coloured: TypeCount[] = [];
  const overflow: TypeCount[] = [];
  for (const row of rows) {
    (colorOf(row.nodeType) === fallbackColor ? overflow : coloured).push(row);
  }
  return { coloured, overflow };
}
