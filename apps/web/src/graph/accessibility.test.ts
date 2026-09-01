// Tests for the graph canvas's text alternatives (bd-hmd.4 review,
// should-fix: the canvas replaced SearchResultsList's screen-reader-
// reachable rows with nothing).

import { describe, expect, it } from "vitest";
import { graphAriaSummary, nodeAccessibleDescription } from "./accessibility.js";
import type { GraphCanvasData, GraphNode } from "./encoding.js";

function makeGraphNode(overrides: Partial<GraphNode> & { id: string }): GraphNode {
  return {
    title: `Node ${overrides.id}`,
    nodeType: "doc",
    sourceSystem: "repo",
    degree: 2,
    radius: 8,
    color: "#2a78d6",
    isEditable: false,
    provenance: { kind: "path", edgePath: [] },
    ...overrides,
  };
}

describe("graphAriaSummary", () => {
  it("states no results for an empty graph, rather than '0 nodes and 0 edges'", () => {
    expect(graphAriaSummary({ nodes: [], links: [] })).toBe("Graph, no results.");
  });

  it("pluralises correctly for exactly one node and one edge", () => {
    const data: GraphCanvasData = {
      nodes: [makeGraphNode({ id: "a" })],
      links: [{ id: "e1", source: "a", target: "a", edgeType: "sibling", sourceSystem: "repo", weight: 1, color: "#000", width: 1 }],
    };
    expect(graphAriaSummary(data)).toBe("Graph of 1 node and 1 edge.");
  });

  it("pluralises correctly for several nodes and edges — the seeded corpus's own shape", () => {
    const data: GraphCanvasData = {
      nodes: Array.from({ length: 9 }, (_, i) => makeGraphNode({ id: `n${i}` })),
      links: Array.from({ length: 16 }, (_, i) => ({ id: `e${i}`, source: "n0", target: "n1", edgeType: "part-of-change", sourceSystem: "repo", weight: 0.6, color: "#000", width: 3 })),
    };
    expect(graphAriaSummary(data)).toBe("Graph of 9 nodes and 16 edges.");
  });
});

describe("nodeAccessibleDescription", () => {
  it("states title, type, source, and degree for a path (non-seed) node", () => {
    const node = makeGraphNode({ id: "a", title: "Retrieval design", nodeType: "doc", sourceSystem: "repo", degree: 5 });
    expect(nodeAccessibleDescription(node)).toBe("Retrieval design, type doc, source repo, degree 5");
  });

  it("falls back to '(untitled)' for a blank title, same as the canvas label does", () => {
    const node = makeGraphNode({ id: "a", title: "" });
    expect(nodeAccessibleDescription(node)).toContain("(untitled)");
  });

  it("appends the search-relevance fact for a seed node — the same transient state the canvas shows as a highlight ring", () => {
    const node = makeGraphNode({ id: "a", title: "Retrieval spec", provenance: { kind: "seed", relevance: 3.8, snippet: "..." } });
    expect(nodeAccessibleDescription(node)).toBe("Retrieval spec, type doc, source repo, degree 2, search match, relevance 3.80");
  });

  it("omits the relevance fact entirely for a path node — it has none, per graph-explorer/spec.md", () => {
    const node = makeGraphNode({ id: "a", provenance: { kind: "path", edgePath: ["sibling"] } });
    expect(nodeAccessibleDescription(node)).not.toContain("relevance");
  });

  // bd-hmd.5, graph-explorer/spec.md "Hub expansion is bounded": "the
  // explorer SHALL say so" when neighbours were withheld.
  it("states that more neighbours are available when hasMoreNeighbors is true", () => {
    const node = makeGraphNode({ id: "a", title: "Hub node" });
    expect(nodeAccessibleDescription(node, true)).toBe("Hub node, type doc, source repo, degree 2, more neighbours available");
  });

  it("says nothing about more neighbours by default (hasMoreNeighbors omitted) or when explicitly false", () => {
    const node = makeGraphNode({ id: "a" });
    expect(nodeAccessibleDescription(node)).not.toContain("more neighbours");
    expect(nodeAccessibleDescription(node, false)).not.toContain("more neighbours");
  });
});
