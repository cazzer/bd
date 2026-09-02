// Tests for the pure encoding functions (bd-hmd.4). These map directly
// onto openspec/changes/add-visual-layer/specs/graph-explorer/spec.md's
// scenarios for "Node size encodes connectedness", "Query relevance is
// transient, never geometry", and "Edge provenance is visible" — see
// each describe block's comment for which scenario it is.

import { describe, expect, it } from "vitest";
import { assignTypeColors, CATEGORICAL_PALETTE, colorForNodeType, colorForSourceSystem, FALLBACK_COLOR } from "./palette.js";
import {
  degreeToRadius,
  EDGE_WIDTH_MAX,
  EDGE_WIDTH_MIN,
  mergeGraphData,
  NODE_RADIUS_MAX,
  NODE_RADIUS_MIN,
  NODE_RADIUS_SCALE,
  searchResultToGraphData,
  setNodeDegree,
  weightToEdgeWidth,
  type GraphCanvasData,
  type GraphNode,
  type SearchResult,
  type SearchResultEdge,
  type SearchResultNode,
} from "./encoding.js";

// --- fixtures -------------------------------------------------------------

function makeNode(overrides: Partial<SearchResultNode> & { id: string }): SearchResultNode {
  return {
    nodeType: "doc",
    sourceSystem: "repo",
    externalId: overrides.id,
    title: `Node ${overrides.id}`,
    updatedAt: "2026-01-01T00:00:00.000Z",
    score: 1,
    depth: 0,
    isSeed: false,
    relevance: null,
    matchedNodeId: null,
    snippet: null,
    seedId: overrides.id,
    edgePath: [],
    viaEdgeId: null,
    degree: 1,
    isEditable: false,
    ...overrides,
  } as SearchResultNode;
}

function makeEdge(overrides: Partial<SearchResultEdge> & { edgeId: string; srcNodeId: string; dstNodeId: string }): SearchResultEdge {
  return {
    rawSrcId: overrides.srcNodeId,
    rawDstId: overrides.dstNodeId,
    edgeType: "part-of-change",
    weight: 0.6,
    sourceSystem: "repo",
    ...overrides,
  } as SearchResultEdge;
}

function makeResult(nodes: SearchResultNode[], edges: SearchResultEdge[]): SearchResult {
  return {
    mode: "exact",
    seedCount: nodes.filter((n) => n.isSeed).length,
    nodeCount: nodes.length,
    truncated: false,
    defaultsUsed: {} as SearchResult extends { defaultsUsed: infer D } ? D : never,
    droppedNodeIds: [],
    shrunkNodeIds: [],
    nodes,
    edges,
  } as SearchResult;
}

// --- degree -> radius: "Node size encodes connectedness" ------------------

describe("degreeToRadius", () => {
  it("a hub with four times the degree draws at about twice (sqrt(4)) the radius, not four — both comfortably under NODE_RADIUS_MAX (see the cap-specific tests below for degrees large enough to actually hit it; the original 3-vs-30/10x demonstration no longer fits under the cap bd-4ye added, since NODE_RADIUS_MAX = NODE_RADIUS_MIN * 3 = 9 is well below radius(30))", () => {
    const normal = degreeToRadius(1);
    const hub = degreeToRadius(4);

    // NODE_RADIUS_SCALE = 4: radius(1) = 4*sqrt(1) = 4, radius(4) =
    // 4*sqrt(4) = 8 — ratio 2, matching sqrt(4) exactly (both stay
    // under NODE_RADIUS_MAX, so the cap does not distort the ratio).
    expect(normal).toBeCloseTo(4, 5);
    expect(hub).toBeCloseTo(8, 5);
    expect(hub / normal).toBeCloseTo(2, 5);
    expect(hub / normal).toBeCloseTo(Math.sqrt(4), 5);
  });

  it("scales with sqrt(degree), not degree itself", () => {
    expect(degreeToRadius(4) / degreeToRadius(1)).toBeCloseTo(2, 5); // sqrt(4)/sqrt(1) = 2, not 4
  });

  it("floors a degree-zero node to a visible minimum instead of a zero (invisible) radius", () => {
    expect(degreeToRadius(0)).toBe(NODE_RADIUS_MIN);
  });

  it("NODE_RADIUS_MAX is roughly 3x NODE_RADIUS_MIN, per design.md decision 3", () => {
    expect(NODE_RADIUS_MAX).toBe(NODE_RADIUS_MIN * 3);
  });

  it("a degree just under the one where sqrt scaling reaches the cap still draws at its own sqrt-scaled radius — the cap does not engage early", () => {
    const degreeJustUnderCap = (NODE_RADIUS_MAX / NODE_RADIUS_SCALE) ** 2 - 0.5;
    const radius = degreeToRadius(degreeJustUnderCap);
    expect(radius).toBeLessThan(NODE_RADIUS_MAX);
    expect(radius).toBeCloseTo(NODE_RADIUS_SCALE * Math.sqrt(degreeJustUnderCap), 5);
  });

  it("draws at exactly NODE_RADIUS_MAX for the degree where sqrt scaling exactly reaches the cap", () => {
    const degreeAtCap = (NODE_RADIUS_MAX / NODE_RADIUS_SCALE) ** 2;
    expect(degreeToRadius(degreeAtCap)).toBeCloseTo(NODE_RADIUS_MAX, 5);
  });

  it("a hub far past the cap draws at the SAME radius as one just past it — graph-explorer/spec.md's 'A hub above the cap is drawn at the maximum radius'", () => {
    const justPastCap = (NODE_RADIUS_MAX / NODE_RADIUS_SCALE) ** 2 + 1;
    expect(degreeToRadius(justPastCap)).toBe(NODE_RADIUS_MAX);
    expect(degreeToRadius(1000)).toBe(NODE_RADIUS_MAX);
    expect(degreeToRadius(justPastCap)).toBe(degreeToRadius(1000));
  });

  it("never returns a smaller radius for a strictly larger degree, including across the cap boundary", () => {
    const degrees = [0, 1, 2, 5, 10, 50, 500];
    for (let i = 1; i < degrees.length; i++) {
      expect(degreeToRadius(degrees[i]!)).toBeGreaterThanOrEqual(degreeToRadius(degrees[i - 1]!));
    }
  });
});

// --- node_type / source_system -> colour -----------------------------------

// bd-4ye, design.md decision 2: node_type colour moved from a fixed
// lookup table to rank-based assignment. assignTypeColors takes an
// already-ranked list of type names (App.tsx derives this from
// getStoreSummary().nodeTypes via typePrevalence.ts's topStoreTypes);
// colorForNodeType is now a lookup into whatever map assignTypeColors
// produced, not a static table — see palette.ts's own header.
describe("assignTypeColors", () => {
  it("returns an empty map for an empty store", () => {
    expect(assignTypeColors([]).size).toBe(0);
  });

  it("gives each of the first N ranks (fewer types than palette slots) a distinct colour, in rank order", () => {
    const map = assignTypeColors(["doc", "openspec-spec", "openspec-proposal"]);
    expect(map.get("doc")).toBe(CATEGORICAL_PALETTE[0]);
    expect(map.get("openspec-spec")).toBe(CATEGORICAL_PALETTE[1]);
    expect(map.get("openspec-proposal")).toBe(CATEGORICAL_PALETTE[2]);
    expect(new Set(map.values()).size).toBe(3);
  });

  it("falls back to FALLBACK_COLOR for a type ranked past the palette's length", () => {
    const rankedTypes = Array.from({ length: CATEGORICAL_PALETTE.length + 2 }, (_, i) => `type-${i}`);
    const map = assignTypeColors(rankedTypes);
    for (let i = 0; i < CATEGORICAL_PALETTE.length; i++) {
      expect(map.get(`type-${i}`)).toBe(CATEGORICAL_PALETTE[i]);
    }
    expect(map.get(`type-${CATEGORICAL_PALETTE.length}`)).toBe(FALLBACK_COLOR);
    expect(map.get(`type-${CATEGORICAL_PALETTE.length + 1}`)).toBe(FALLBACK_COLOR);
  });

  it("is a stable, deterministic assignment — the same ranked input always produces the same map", () => {
    const ranked = ["gh-issue", "repo", "doc"];
    expect(assignTypeColors(ranked)).toEqual(assignTypeColors(ranked));
  });
});

describe("colorForNodeType", () => {
  const colors = assignTypeColors(["doc", "gh-issue", "repo"]);

  it("looks up a ranked type's assigned colour", () => {
    expect(colorForNodeType("doc", colors)).toBe(CATEGORICAL_PALETTE[0]);
    expect(colorForNodeType("gh-issue", colors)).toBe(CATEGORICAL_PALETTE[1]);
    expect(colorForNodeType("repo", colors)).toBe(CATEGORICAL_PALETTE[2]);
  });

  it("falls back to the stable fallback colour for a type absent from the map, without throwing", () => {
    expect(() => colorForNodeType("some-future-type", colors)).not.toThrow();
    expect(colorForNodeType("some-future-type", colors)).toBe(FALLBACK_COLOR);
  });

  it("gives two different unmapped types the SAME fallback colour rather than colliding arbitrarily", () => {
    expect(colorForNodeType("unknown-a", colors)).toBe(colorForNodeType("unknown-b", colors));
  });

  it("is a stable, deterministic lookup — repeated calls agree", () => {
    expect(colorForNodeType("doc", colors)).toBe(colorForNodeType("doc", colors));
  });

  it("the fallback colour is not equal to any ranked type's colour", () => {
    const ranked = ["doc", "gh-issue", "repo"].map((t) => colorForNodeType(t, colors));
    expect(ranked).not.toContain(FALLBACK_COLOR);
  });
});

describe("colorForSourceSystem", () => {
  it("gives repo, human, and agent distinct colours", () => {
    const colors = ["repo", "human", "agent"].map(colorForSourceSystem);
    expect(new Set(colors).size).toBe(3);
  });

  it("falls back to the stable fallback colour for an unrecognised source system", () => {
    expect(colorForSourceSystem("some-future-loader")).toBe(FALLBACK_COLOR);
  });
});

// --- weight -> edge width: "Edge provenance is visible" --------------------

describe("weightToEdgeWidth", () => {
  it("maps the weight range [0, 1] onto [EDGE_WIDTH_MIN, EDGE_WIDTH_MAX] linearly", () => {
    expect(weightToEdgeWidth(0)).toBe(EDGE_WIDTH_MIN);
    expect(weightToEdgeWidth(1)).toBe(EDGE_WIDTH_MAX);
    expect(weightToEdgeWidth(0.5)).toBeCloseTo((EDGE_WIDTH_MIN + EDGE_WIDTH_MAX) / 2, 5);
  });

  it("clamps out-of-range weight rather than producing a negative or oversized width", () => {
    expect(weightToEdgeWidth(-1)).toBe(EDGE_WIDTH_MIN);
    expect(weightToEdgeWidth(2)).toBe(EDGE_WIDTH_MAX);
  });

  it("the seeded corpus's two real edge weights (corpus.ts PART_OF_CHANGE_WEIGHT=0.6, SIBLING_WEIGHT=0.3) both map inside the width range and are distinguishable", () => {
    const partOfChange = weightToEdgeWidth(0.6);
    const sibling = weightToEdgeWidth(0.3);
    expect(partOfChange).toBeGreaterThan(sibling);
    expect(partOfChange).toBeLessThanOrEqual(EDGE_WIDTH_MAX);
    expect(sibling).toBeGreaterThanOrEqual(EDGE_WIDTH_MIN);
  });
});

// --- searchResultToGraphData: assembly + "Query relevance is transient" ----

describe("searchResultToGraphData", () => {
  it("returns an empty graph for no search yet (null)", () => {
    expect(searchResultToGraphData(null)).toEqual({ nodes: [], links: [] });
  });

  it("returns an empty graph for an empty search result", () => {
    const empty: SearchResult = {
      mode: "empty",
      triedModes: ["exact", "fuzzy"],
      defaultsUsed: {},
      nodes: [],
      edges: [],
    } as unknown as SearchResult;
    expect(searchResultToGraphData(empty)).toEqual({ nodes: [], links: [] });
  });

  it("marks a matched node as seed provenance, carrying its relevance and snippet", () => {
    const result = makeResult([makeNode({ id: "a", isSeed: true, relevance: 0.42, snippet: "the [[match]] here", degree: 3 })], []);
    const graph = searchResultToGraphData(result);
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0]!.provenance).toEqual({ kind: "seed", relevance: 0.42, snippet: "the [[match]] here" });
  });

  it("marks a node reached only by traversal (not a seed) as path provenance, carrying no relevance", () => {
    const result = makeResult([makeNode({ id: "b", isSeed: false, edgePath: ["part-of-change"], degree: 2 })], []);
    const graph = searchResultToGraphData(result);
    expect(graph.nodes[0]!.provenance).toEqual({ kind: "path", edgePath: ["part-of-change"] });
  });

  it("a node's radius does not depend on whether it is a seed — provenance never touches geometry (colour isn't computed here at all, bd-4ye — see GraphNode.color's own comment: node-type colour is a render-time lookup against the store-wide rank map, resolved in GraphCanvas, never baked in by this function)", () => {
    const seedResult = makeResult([makeNode({ id: "x", isSeed: true, relevance: 0.9, degree: 8, nodeType: "doc" })], []);
    const pathResult = makeResult([makeNode({ id: "x", isSeed: false, degree: 8, nodeType: "doc" })], []);
    const seedNode = searchResultToGraphData(seedResult).nodes[0]!;
    const pathNode = searchResultToGraphData(pathResult).nodes[0]!;
    expect(seedNode.radius).toBe(pathNode.radius);
  });

  it("a new query clears the old highlight: the same node id is a seed in one result and a path node in the next", () => {
    const firstQuery = makeResult([makeNode({ id: "shared", isSeed: true, relevance: 0.8, degree: 4 })], []);
    const secondQuery = makeResult([makeNode({ id: "shared", isSeed: false, edgePath: ["sibling"], degree: 4 })], []);

    expect(searchResultToGraphData(firstQuery).nodes[0]!.provenance.kind).toBe("seed");
    expect(searchResultToGraphData(secondQuery).nodes[0]!.provenance.kind).toBe("path");
  });

  it("appearing in two different queries' results draws the same node at the same size (degree, and therefore radius, is store-wide)", () => {
    const inFirstQuery = makeResult([makeNode({ id: "stable", degree: 6 })], []);
    const inSecondQuery = makeResult([makeNode({ id: "stable", degree: 6, title: "different title, same node" })], []);
    expect(searchResultToGraphData(inFirstQuery).nodes[0]!.radius).toBe(searchResultToGraphData(inSecondQuery).nodes[0]!.radius);
  });

  it("maps edges to colour by source_system and width by weight", () => {
    const nodes = [makeNode({ id: "a" }), makeNode({ id: "b" })];
    const edges = [makeEdge({ edgeId: "e1", srcNodeId: "a", dstNodeId: "b", sourceSystem: "repo", weight: 0.6 })];
    const graph = searchResultToGraphData(makeResult(nodes, edges));
    expect(graph.links).toEqual([
      {
        id: "e1",
        source: "a",
        target: "b",
        edgeType: "part-of-change",
        sourceSystem: "repo",
        weight: 0.6,
        color: colorForSourceSystem("repo"),
        width: weightToEdgeWidth(0.6),
      },
    ]);
  });

  it("the seeded corpus's edges (15 part-of-change + 1 sibling, all source_system=repo) render with one uniform colour — the bd-8no finding made visible", () => {
    const nodes = Array.from({ length: 2 }, (_, i) => makeNode({ id: `n${i}` }));
    const edges = [
      ...Array.from({ length: 15 }, (_, i) => makeEdge({ edgeId: `poc-${i}`, srcNodeId: "n0", dstNodeId: "n1", edgeType: "part-of-change", sourceSystem: "repo", weight: 0.6 })),
      makeEdge({ edgeId: "sib-0", srcNodeId: "n0", dstNodeId: "n1", edgeType: "sibling", sourceSystem: "repo", weight: 0.3 }),
    ];
    const graph = searchResultToGraphData(makeResult(nodes, edges));

    const colors = new Set(graph.links.map((l) => l.color));
    expect(colors.size).toBe(1); // one source_system -> one colour, uniformly
    expect([...colors][0]).toBe(colorForSourceSystem("repo"));

    // Thickness still tracks each edge's own weight — uniformity is about
    // provenance (colour), not an assertion that every edge looks
    // pixel-identical.
    const widths = new Set(graph.links.map((l) => l.width));
    expect(widths.size).toBe(2); // 0.6 and 0.3 map to two distinct widths
  });
});

// --- mergeGraphData: stable node identity across sequential updates -------
//
// bd-hmd.4 review (must-fix): searchResultToGraphData alone constructs a
// brand-new object per node on every call. react-kapsule/force-graph
// diff graphData by reference; a fresh object with no x/y triggers
// d3-force-3d's initializeNodes to re-randomize position — every node
// jumps on every search, confirmed live with "retrieval" then
// "breakdown" (they share two node ids). The existing "clears the old
// highlight"/"same size across views" tests above call the pure
// function twice and compare RETURN VALUES — real coverage of
// determinism, but structurally blind to this: they never check that a
// node occurring in both calls is the SAME OBJECT. These do.

/** Stands in for what force-graph mutates onto a node object after a simulation tick — GraphNode itself declares no x/y (see encoding.ts's GraphNode). */
function withSimulatedPosition<T extends object>(obj: T, x: number, y: number): T & { x: number; y: number } {
  return Object.assign(obj, { x, y });
}

describe("mergeGraphData", () => {
  it("reuses the SAME object reference for a node id present in both the previous and incoming graph, preserving simulation-assigned x/y", () => {
    const previous = searchResultToGraphData(makeResult([makeNode({ id: "shared", degree: 3 })], []));
    const sharedRef = withSimulatedPosition(previous.nodes[0]!, 123.45, 67.89);

    const incoming = searchResultToGraphData(makeResult([makeNode({ id: "shared", degree: 3 })], []));
    const merged = mergeGraphData(previous, incoming);

    expect(merged.nodes[0]).toBe(sharedRef); // identity, not just equal fields
    expect((merged.nodes[0] as unknown as { x: number }).x).toBe(123.45);
    expect((merged.nodes[0] as unknown as { y: number }).y).toBe(67.89);
  });

  it("does NOT reuse an object for a genuinely new id — it has no prior position to preserve", () => {
    const previous = searchResultToGraphData(makeResult([makeNode({ id: "a" })], []));
    const incoming = searchResultToGraphData(makeResult([makeNode({ id: "b" })], []));
    const merged = mergeGraphData(previous, incoming);

    expect(merged.nodes).toHaveLength(1);
    expect(merged.nodes[0]!.id).toBe("b");
    expect(merged.nodes).not.toContain(previous.nodes[0]);
  });

  it("updates a reused node's own fields to the incoming query's values while keeping its identity (and therefore position)", () => {
    const previous = searchResultToGraphData(makeResult([makeNode({ id: "shared", isSeed: true, relevance: 0.9, degree: 4 })], []));
    const sharedRef = withSimulatedPosition(previous.nodes[0]!, 10, 20);

    const incoming = searchResultToGraphData(makeResult([makeNode({ id: "shared", isSeed: false, edgePath: ["sibling"], degree: 4 })], []));
    const merged = mergeGraphData(previous, incoming);

    expect(merged.nodes[0]).toBe(sharedRef); // same object...
    expect(merged.nodes[0]!.provenance.kind).toBe("path"); // ...its OWN field updated to the new query's value
    expect((merged.nodes[0] as unknown as { x: number }).x).toBe(10); // ...and its position untouched
  });

  it("a node present in the previous graph but absent from the incoming result is dropped — a new search replaces the view, it does not accumulate", () => {
    const previous = searchResultToGraphData(makeResult([makeNode({ id: "stale" })], []));
    const incoming = searchResultToGraphData(makeResult([makeNode({ id: "fresh" })], []));
    const merged = mergeGraphData(previous, incoming);

    expect(merged.nodes.map((n) => n.id)).toEqual(["fresh"]);
  });

  it("reuses link objects by id the same way it reuses nodes", () => {
    const nodes = [makeNode({ id: "a" }), makeNode({ id: "b" })];
    const previous = searchResultToGraphData(makeResult(nodes, [makeEdge({ edgeId: "e1", srcNodeId: "a", dstNodeId: "b" })]));
    const linkRef = previous.links[0]!;

    const incoming = searchResultToGraphData(makeResult(nodes, [makeEdge({ edgeId: "e1", srcNodeId: "a", dstNodeId: "b" })]));
    const merged = mergeGraphData(previous, incoming);

    expect(merged.links[0]).toBe(linkRef);
  });

  it("an empty previous graph (first search of a session) just returns the incoming graph's nodes, none of them reused", () => {
    const incoming = searchResultToGraphData(makeResult([makeNode({ id: "a" }), makeNode({ id: "b" })], []));
    const merged = mergeGraphData(EMPTY_GRAPH_FOR_TEST(), incoming);
    expect(merged.nodes.map((n) => n.id)).toEqual(["a", "b"]);
  });
});

/** Local alias so this file doesn't need to import EMPTY_GRAPH just for one test — an ordinary empty literal is exactly as valid a "previous" as the exported constant. */
function EMPTY_GRAPH_FOR_TEST(): GraphCanvasData {
  return { nodes: [], links: [] };
}

// --- setNodeDegree (bd-hmd.6): the one case a local degree correction is
// exact, not a guess — see the function's own header for why every OTHER
// bd-hmd.6 write path (a hand edge between two pre-existing nodes)
// deliberately does NOT do this, and for why this takes an ABSOLUTE
// degree rather than a delta (a live bug this ticket's own task 6.7
// end-to-end run caught: React StrictMode calls a `setGraph` updater
// function TWICE, and a delta applied via in-place mutation compounds
// across those two calls since both see the same, already-mutated,
// shared node object — landing on +2 instead of +1).

describe("setNodeDegree", () => {
  function graphNode(overrides: Partial<GraphNode> & { id: string }): GraphNode {
    return { title: "n", nodeType: "note", sourceSystem: "human", degree: 0, radius: degreeToRadius(0), isEditable: true, provenance: { kind: "path", edgePath: [] }, ...overrides };
  }

  it("sets degree and recomputes radius for the matching node, returning true", () => {
    const nodes = [graphNode({ id: "target", degree: 2 })];
    const changed = setNodeDegree(nodes, "target", 3);
    expect(changed).toBe(true);
    expect(nodes[0]!.degree).toBe(3);
    expect(nodes[0]!.radius).toBe(degreeToRadius(3));
  });

  it("never drives degree negative", () => {
    const nodes = [graphNode({ id: "target", degree: 0 })];
    setNodeDegree(nodes, "target", -1);
    expect(nodes[0]!.degree).toBe(0);
  });

  it("returns false and touches nothing when the id isn't present", () => {
    const nodes = [graphNode({ id: "other", degree: 5 })];
    const changed = setNodeDegree(nodes, "missing", 6);
    expect(changed).toBe(false);
    expect(nodes[0]!.degree).toBe(5);
  });

  it("leaves every other node's degree untouched", () => {
    const nodes = [graphNode({ id: "a", degree: 1 }), graphNode({ id: "b", degree: 9 })];
    setNodeDegree(nodes, "a", 2);
    expect(nodes[1]!.degree).toBe(9);
  });

  it("is idempotent under a repeated call with the same absolute value — the exact property a React StrictMode double-invoked setGraph updater relies on", () => {
    const nodes = [graphNode({ id: "target", degree: 1 })];
    setNodeDegree(nodes, "target", 2);
    setNodeDegree(nodes, "target", 2); // simulates StrictMode's second invocation computing the SAME absolute value from a value captured before either call
    expect(nodes[0]!.degree).toBe(2); // NOT 3 — see this describe block's own header for the bug a relative version had
  });
});
