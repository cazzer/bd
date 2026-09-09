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
import { familyKeyForEdgeType, type EdgeFamilyKey } from "./palette.js";

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

/**
 * Ceiling on a node's radius (bd-4ye, design.md decision 3: "adds a
 * ceiling ... at roughly 3x NODE_RADIUS_MIN — the same 'about a factor
 * of three, not ten' language the existing spec requirement already
 * uses for a 10x-degree hub, now enforced as an actual cap rather than
 * left as an emergent property of sqrt scaling that a large enough
 * degree spread can still blow past"). Radius stays monotonic and
 * sqrt-scaled up to this ceiling; a degree large enough to blow past it
 * draws at exactly this value instead, same as any other node past the
 * cap — graph-explorer/spec.md's "A hub above the cap is drawn at the
 * cap radius" scenario. This never touches `degree` itself — a node's
 * real, uncapped degree stays visible in the detail panel regardless of
 * whether its drawn radius hit the ceiling (DetailPanel.tsx's meta row
 * reads `degree` directly, never `radius`).
 */
export const NODE_RADIUS_MAX = NODE_RADIUS_MIN * 3;

export function degreeToRadius(degree: number): number {
  return Math.min(NODE_RADIUS_MAX, Math.max(NODE_RADIUS_MIN, NODE_RADIUS_SCALE * Math.sqrt(Math.max(0, degree))));
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

/**
 * Weight → stroke width. Kept, but demoted (bd-o1e): measured against the
 * live store, `weight` takes essentially two values — a sample search
 * returned 32 edges at 1.0 and 25 at 0.8, which this maps to 5px and
 * 4.2px. That difference is not readable, so width is a SECONDARY cue
 * behind the relation's dash and arrowhead, not something a reader can
 * learn an edge from. Left as a linear map rather than stretched to
 * exaggerate the gap: the honest answer is that the store's weights
 * barely vary, and a scale that manufactured contrast would be drawing a
 * distinction the data does not contain. If agent-asserted edges ever
 * spread their confidence across the range, this becomes informative on
 * its own with no change here.
 */
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
  /**
   * NOT populated by this module, or by graph/expansion.ts's node
   * builders (bd-4ye) — unlike an edge's relation family
   * (`familyKeyForEdgeType`, a small fixed table, safe to bake in once), a node's TYPE colour now
   * depends on the store's current rank ordering (palette.ts's
   * `assignTypeColors`, design.md decision 2), which is session state
   * these pure functions have no access to and shouldn't need threaded
   * through every write path (search, expansion, annotation, standalone
   * note...) just to keep one field honest. Left optional rather than
   * removed so a fixture/caller may still set it; GraphCanvas.tsx is
   * where a node's fill/halo colour is actually resolved, reading
   * `node.nodeType` against the SAME `typeColors` map App.tsx computes
   * once — the identical "look at node.nodeType against a prop, every
   * frame" pattern that file already uses for `focusedNodeType`.
   */
  color?: string;
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
  /**
   * How this edge is DRAWN (bd-o1e, design.md decision 1) — resolved from
   * `edgeType` at encode time, unlike a node's type colour, which
   * GraphCanvas resolves live because it depends on the store's current
   * prevalence ranking (see `GraphNode.color`). A relation's family does
   * not depend on session state, so baking it in here is safe and keeps
   * the per-frame link accessors to one Map lookup.
   *
   * Replaced the old `color` field, which held `colorForSourceSystem`'s
   * answer — a channel that, in this store, drew every edge the same
   * fallback grey. Source system is still on the link (above) for the
   * tooltip and the legend's composition line; it just no longer decides
   * how the edge looks.
   */
  family: EdgeFamilyKey;
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
    family: familyKeyForEdgeType(edge.edgeType),
    width: weightToEdgeWidth(edge.weight),
  }));

  return { nodes, links };
}

// --- Stable identity across sequential updates (bd-hmd.4 review) ---------
//
// searchResultToGraphData alone constructs a brand-new object per node,
// every call — fine for a pure function considered in isolation, fatal
// once it feeds a running force simulation. Traced through the
// installed source: react-kapsule diffs the `graphData` prop by
// reference, so any new array reaches force-graph's `update()`, which
// unconditionally runs `.stop().alpha(1).nodes(...)`; d3-force-3d's
// initializeNodes then re-randomizes the position of any node whose `x`
// is NaN — true of every object this module constructs, since GraphNode
// declares no x/y (force-graph adds them by mutation once the
// simulation has run). Net effect: every node on screen jumps on every
// graph update, invisible in bd-hmd.4 (a query replaces the whole graph
// anyway, so there is nothing to visibly preserve) but fatal to
// bd-hmd.5, whose spec requires an already-placed node to stay "within
// a small tolerance of its previous position" across an expansion.
//
// The fix is identity, not physics: reuse the SAME node/link object for
// an id that exists in both `previous` and `incoming`, so whatever
// x/y/vx/vy/fx/fy force-graph already wrote onto it survives untouched
// (this function never reads or sets those fields — GraphNode/GraphLink
// don't even declare them — it only avoids DISCARDING the object that
// carries them). A field OTHER than position — provenance, most
// visibly, since that's what makes a query's relevance transient — is
// still fully overwritten to `incoming`'s value via `Object.assign`,
// which copies only `incoming`'s own enumerable keys and so never
// touches whatever extra fields (x/y/...) already live on `existing`.
// An id with no match in `previous` gets `incoming`'s freshly-built
// object as-is: a genuinely new node has no prior position to keep, and
// letting the simulation randomize its start is correct, not a bug.
//
// `incoming`'s own node/link SET is authoritative for which ids appear
// in the result — an id present only in `previous` is dropped. That is
// what makes a new search *replace* the view rather than accumulate
// onto it (graph-explorer/spec.md's "First query draws a bounded
// neighbourhood" — there is one neighbourhood on screen, the current
// query's). bd-hmd.5's expansion is meant to accumulate instead; it
// gets that by constructing its OWN `incoming` as the union of what's
// already on screen plus the newly-expanded neighbours, and calling
// this same function — this function's only job is "reuse identity
// where the id matches," not deciding replace vs. accumulate, so
// bd-hmd.5 needs no change here to get its own semantics.
// --- Local degree correction for a write we know the shape of (bd-hmd.6) --
//
// No `@breakdown/core` read returns "this node's own store-wide degree"
// in isolation — only `retrieve()` (a search hit) and `getNeighbors`
// (the OTHER side of each neighbor) compute it, and neither is a cheap
// call to make just to keep one number honest after a local edit. For
// most hand-authored writes this module leaves a placed node's `degree`
// stale rather than guess wrong: an edge asserted between two nodes
// already on screen might already be connected by a DIFFERENT edge (in
// which case degree, "distinct connected nodes," does not change at
// all), and getting that silently wrong is worse than a number that's
// merely out of date until the next search or expansion refreshes it.
//
// Annotation is the one case this module treats differently, because the
// note being attached is BRAND NEW — freshly created in the same call —
// so it is provably exactly one more than whatever the target's degree
// already was. That "already was" has to be captured as a plain number
// BEFORE `setGraph`'s updater runs, never read back out of `previous`
// inside it — see this function's own signature: it takes the new
// ABSOLUTE degree, not a delta, and App.tsx's annotate handler (the only
// caller) computes `target.degree + 1` in the ONE place that's safe to
// read `target.degree`, before calling `setGraph` at all.
//
// This is deliberately NOT a "bump by delta" helper mutating in place —
// an earlier version was, and broke under React StrictMode: `setGraph`
// updater functions are called TWICE in development (React's documented
// purity check), with `previous` the SAME object graph both times. A
// delta applied via direct mutation (`node.degree += 1`) is invisible to
// React's state mechanism — it is a plain side effect on a shared
// object — so the FIRST invocation's mutation was still there, already
// applied, when the SECOND invocation ran and read `node.degree` again:
// 1 -> 2 on the first call, then 2 -> 3 on the second, landing on 3
// instead of 2 (caught live during this ticket's task 6.7 end-to-end
// run — see the ticket report). Setting an ABSOLUTE value computed
// OUTSIDE the updater, from a plain number captured before either
// invocation runs, is idempotent: both invocations set the same target
// value, so calling this twice (or a hundred times) with the same
// arguments converges, it does not compound.
export function setNodeDegree(nodes: readonly GraphNode[], id: string, degree: number): boolean {
  const node = nodes.find((n) => n.id === id);
  if (!node) return false;
  node.degree = Math.max(0, degree);
  node.radius = degreeToRadius(node.degree);
  return true;
}

export function mergeGraphData(previous: GraphCanvasData, incoming: GraphCanvasData): GraphCanvasData {
  const previousNodesById = new Map(previous.nodes.map((node) => [node.id, node]));
  const nodes = incoming.nodes.map((node) => {
    const existing = previousNodesById.get(node.id);
    if (existing === undefined) {
      return node;
    }
    return Object.assign(existing, node);
  });

  const previousLinksById = new Map(previous.links.map((link) => [link.id, link]));
  const links = incoming.links.map((link) => {
    const existing = previousLinksById.get(link.id);
    if (existing === undefined) {
      return link;
    }
    return Object.assign(existing, link);
  });

  return { nodes, links };
}
