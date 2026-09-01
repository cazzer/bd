// Pure functions turning a `search` API result into the shape
// react-force-graph-2d's ForceGraph2D draws (bd-hmd.4, tasks.md
// 4.1-4.5). `ForceGraph2D` draws to a `<canvas>`, so DOM assertions
// can't reach what it actually renders — every encoding *decision* (a
// node's radius and colour, an edge's colour and width, whether a node
// carries transient query-relevance) therefore lives here as data,
// computed by functions with no dependency on React or the graph
// component, so it's what encoding.test.ts asserts on directly.
// GraphCanvas.tsx's job is only to hand these already-computed values to
// the canvas — see that file for the (untestable, and therefore
// deliberately thin) drawing code.

import type { trpc } from "../trpc.js";
import { colorForNodeType, colorForSourceSystem } from "./palette.js";

// --- API result types --------------------------------------------------
//
// Derived directly from the live client, not hand-typed (same reasoning
// SearchResultsList.tsx documented: a server-side shape change breaks
// these call sites at typecheck time with no schema-generation step).

export type SearchResult = Awaited<ReturnType<typeof trpc.search.query>>;
type FoundSearchResult = Extract<SearchResult, { mode: "exact" | "fuzzy" }>;
export type SearchResultNode = FoundSearchResult["nodes"][number];
export type SearchResultEdge = FoundSearchResult["edges"][number];

// --- Node size: degree -> radius ----------------------------------------
//
// graph-explorer/spec.md, "Node size encodes connectedness": size scales
// with the square root of degree — never degree itself — because
// perceived circle size tracks AREA (pi*r^2), not radius. A node with
// ten times another's degree therefore gets sqrt(10) ~= 3.16x the
// radius (so ~10x the area, matching its actual connectedness), not
// 10x the radius (which would make it ~100x the area — "swamp the
// graph", the scenario's own words).
//
// `degree` is `RetrievedNode.degree` (packages/core/src/retrieval.ts) —
// counted across the WHOLE STORE, never the current view — so feeding
// it straight into a fixed formula with no result-relative normalising
// is what makes a node's radius the same in every view (the spec's
// "Size is stable across views" scenario), the same way its colour
// (palette.ts) never depends on what else is in the result.

/** Pixels of radius per unit of sqrt(degree). */
export const NODE_RADIUS_SCALE = 4;

/**
 * Floor, not a base added to every value: sqrt(0) = 0, which would draw
 * a degree-zero node as an invisible, unclickable point. This only
 * engages when `NODE_RADIUS_SCALE * sqrt(degree)` would fall under it —
 * true only for degree 0 at this scale — so it does not distort the
 * size ratio between any two nodes that both have at least one edge.
 */
export const NODE_RADIUS_MIN = 3;

export function degreeToRadius(degree: number): number {
  return Math.max(NODE_RADIUS_MIN, NODE_RADIUS_SCALE * Math.sqrt(Math.max(0, degree)));
}

// --- Edge thickness: weight -> line width --------------------------------
//
// graph-explorer/spec.md, "Edge provenance is visible": "confidence
// weight is reflected in its thickness." `weight` is already a bounded
// confidence score in [0, 1] (packages/db/src/schema.ts's
// `edges_weight_range_check`), not a count with the area/perception
// problem degree has — so this maps linearly, not through sqrt.

export const EDGE_WIDTH_MIN = 1;
export const EDGE_WIDTH_MAX = 5;

export function weightToEdgeWidth(weight: number): number {
  const clamped = Math.min(1, Math.max(0, weight));
  return EDGE_WIDTH_MIN + (EDGE_WIDTH_MAX - EDGE_WIDTH_MIN) * clamped;
}

// --- Node provenance: transient query relevance, never geometry ---------
//
// graph-explorer/spec.md, "Query relevance is transient, never
// geometry": relevance belongs to a query, not a node. A node that
// matched this query directly is a "seed" (relevance + snippet, both
// present only for a seed per RetrievedNode's own doc comment); a node
// reached only by traversal from a seed is a "path" node and carries no
// relevance at all. Neither variant carries size or position — those
// come from `degree` (above) and the force simulation, never from this.

export interface SeedProvenance {
  kind: "seed";
  relevance: number;
  snippet: string | null;
}

export interface PathProvenance {
  kind: "path";
  edgePath: readonly string[];
}

export type NodeProvenance = SeedProvenance | PathProvenance;

function toProvenance(node: SearchResultNode): NodeProvenance {
  if (node.isSeed) {
    // relevance/snippet are typed nullable server-side ("present only
    // when isSeed") rather than proven non-null by the type system —
    // the `?? 0` / passthrough below is the boundary check for that gap,
    // not a claim it should ever actually be null when isSeed is true.
    return { kind: "seed", relevance: node.relevance ?? 0, snippet: node.snippet };
  }
  return { kind: "path", edgePath: node.edgePath };
}

// --- Graph data shape for ForceGraph2D ------------------------------------

export interface GraphNode {
  id: string;
  title: string;
  nodeType: string;
  sourceSystem: string;
  degree: number;
  radius: number;
  color: string;
  isEditable: boolean;
  provenance: NodeProvenance;
}

export interface GraphLink {
  id: string;
  source: string;
  target: string;
  edgeType: string;
  sourceSystem: string;
  weight: number;
  color: string;
  width: number;
}

export interface GraphCanvasData {
  nodes: GraphNode[];
  links: GraphLink[];
}

export const EMPTY_GRAPH: GraphCanvasData = { nodes: [], links: [] };

/**
 * Transforms one `search` result into the graph the canvas draws.
 * `result === null` (nothing searched yet) and `mode === "empty"`
 * (nothing matched either search mode) both produce an empty graph —
 * graph-explorer/spec.md's "Query matches nothing" scenario ("the
 * canvas stays as it was rather than clearing") is implemented by
 * App.tsx choosing not to call this at all when `mode === "empty"`,
 * rather than by this function; it stays pure and total over every
 * `SearchResult` shape regardless of how a caller uses the result.
 */
export function searchResultToGraphData(result: SearchResult | null): GraphCanvasData {
  if (result === null || result.mode === "empty") {
    return EMPTY_GRAPH;
  }

  const nodes: GraphNode[] = result.nodes.map((node) => ({
    id: node.id,
    title: node.title,
    nodeType: node.nodeType,
    sourceSystem: node.sourceSystem,
    degree: node.degree,
    radius: degreeToRadius(node.degree),
    color: colorForNodeType(node.nodeType),
    isEditable: node.isEditable,
    provenance: toProvenance(node),
  }));

  const links: GraphLink[] = result.edges.map((edge) => ({
    id: edge.edgeId,
    source: edge.srcNodeId,
    target: edge.dstNodeId,
    edgeType: edge.edgeType,
    sourceSystem: edge.sourceSystem,
    weight: edge.weight,
    color: colorForSourceSystem(edge.sourceSystem),
    width: weightToEdgeWidth(edge.weight),
  }));

  return { nodes, links };
}
