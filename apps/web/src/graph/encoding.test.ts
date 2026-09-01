// Tests for the pure encoding functions (bd-hmd.4). These map directly
// onto openspec/changes/add-visual-layer/specs/graph-explorer/spec.md's
// scenarios for "Node size encodes connectedness", "Query relevance is
// transient, never geometry", and "Edge provenance is visible" — see
// each describe block's comment for which scenario it is.

import { describe, expect, it } from "vitest";
import { colorForNodeType, colorForSourceSystem, FALLBACK_COLOR } from "./palette.js";
import {
  degreeToRadius,
  EDGE_WIDTH_MAX,
  EDGE_WIDTH_MIN,
  mergeGraphData,
  NODE_RADIUS_MIN,
  searchResultToGraphData,
  weightToEdgeWidth,
  type GraphCanvasData,
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
  it("a hub with ten times the degree draws at about three times (sqrt(10)) the radius, not ten", () => {
    const normal = degreeToRadius(3);
    const hub = degreeToRadius(30);

    // Actual numbers (NODE_RADIUS_SCALE = 4): radius(3) = 4*sqrt(3) =
    // 6.928..., radius(30) = 4*sqrt(30) = 21.908... — ratio 3.162,
    // matching sqrt(10) exactly (both are well clear of NODE_RADIUS_MIN,
    // so the floor does not distort the ratio).
    expect(normal).toBeCloseTo(6.9282, 3);
    expect(hub).toBeCloseTo(21.9089, 3);
    expect(hub / normal).toBeCloseTo(Math.sqrt(10), 5);
    expect(hub / normal).toBeCloseTo(3.1623, 3);
  });

  it("scales with sqrt(degree), not degree itself", () => {
    expect(degreeToRadius(4) / degreeToRadius(1)).toBeCloseTo(2, 5); // sqrt(4)/sqrt(1) = 2, not 4
  });

  it("floors a degree-zero node to a visible minimum instead of a zero (invisible) radius", () => {
    expect(degreeToRadius(0)).toBe(NODE_RADIUS_MIN);
  });

  it("never returns a smaller radius for a strictly larger degree", () => {
    const degrees = [0, 1, 2, 5, 10, 50, 500];
    for (let i = 1; i < degrees.length; i++) {
      expect(degreeToRadius(degrees[i]!)).toBeGreaterThanOrEqual(degreeToRadius(degrees[i - 1]!));
    }
  });
});

// --- node_type / source_system -> colour -----------------------------------

describe("colorForNodeType", () => {
  it("gives each of the six known node types a distinct colour", () => {
    const types = ["doc", "openspec-spec", "openspec-proposal", "openspec-design", "openspec-tasks", "openspec-readme"];
    const colors = types.map(colorForNodeType);
    expect(new Set(colors).size).toBe(types.length);
  });

  it("falls back to the stable fallback colour for an unrecognised type, without throwing", () => {
    expect(() => colorForNodeType("some-future-type")).not.toThrow();
    expect(colorForNodeType("some-future-type")).toBe(FALLBACK_COLOR);
  });

  it("gives two different unknown types the SAME fallback colour rather than colliding arbitrarily", () => {
    expect(colorForNodeType("unknown-a")).toBe(colorForNodeType("unknown-b"));
  });

  it("is a stable, deterministic lookup — repeated calls agree", () => {
    expect(colorForNodeType("doc")).toBe(colorForNodeType("doc"));
  });

  it("the fallback colour is not equal to any known node type's colour", () => {
    const known = ["doc", "openspec-spec", "openspec-proposal", "openspec-design", "openspec-tasks", "openspec-readme"].map(colorForNodeType);
    expect(known).not.toContain(FALLBACK_COLOR);
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

  it("a node's radius and colour do not depend on whether it is a seed — provenance never touches geometry", () => {
    const seedResult = makeResult([makeNode({ id: "x", isSeed: true, relevance: 0.9, degree: 8, nodeType: "doc" })], []);
    const pathResult = makeResult([makeNode({ id: "x", isSeed: false, degree: 8, nodeType: "doc" })], []);
    const seedNode = searchResultToGraphData(seedResult).nodes[0]!;
    const pathNode = searchResultToGraphData(pathResult).nodes[0]!;
    expect(seedNode.radius).toBe(pathNode.radius);
    expect(seedNode.color).toBe(pathNode.color);
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
