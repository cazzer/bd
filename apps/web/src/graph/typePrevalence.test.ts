// Tests for bd-14q's ranking helpers — graph-explorer/spec.md's "The type
// control reflects the selection" requirement. Both functions are pure
// (no React, no fetch), so the acceptance criteria are asserted directly
// against constructed graphs rather than through TypePanel — the same
// convention encoding.test.ts/expansion.test.ts already establish for
// this repo (DOM/canvas code carries no tests of its own).

import { describe, expect, it } from "vitest";
import type { GraphLink, GraphNode } from "./encoding.js";
import { rankNeighborTypes, topStoreTypes, type TypeCount } from "./typePrevalence.js";

function makeNode(id: string, nodeType: string): GraphNode {
  return {
    id,
    title: `Node ${id}`,
    nodeType,
    sourceSystem: "repo",
    degree: 1,
    radius: 4,
    color: "#000000",
    isEditable: false,
    provenance: { kind: "path", edgePath: [] },
  };
}

function makeLink(id: string, source: string | GraphNode, target: string | GraphNode): GraphLink {
  return {
    id,
    source: source as unknown as string,
    target: target as unknown as string,
    edgeType: "relates_to",
    sourceSystem: "repo",
    weight: 0.5,
    color: "#000000",
    width: 1,
  };
}

describe("rankNeighborTypes", () => {
  it("ranks a node's neighbour types by count, descending", () => {
    const nodes = [makeNode("a", "doc"), makeNode("b", "doc"), makeNode("c", "openspec-spec"), makeNode("d", "doc")];
    const links = [makeLink("e1", "a", "b"), makeLink("e2", "a", "c"), makeLink("e3", "a", "d")];
    expect(rankNeighborTypes("a", nodes, links)).toEqual([
      { nodeType: "doc", count: 2 },
      { nodeType: "openspec-spec", count: 1 },
    ]);
  });

  it("breaks a count tie by node_type name, ascending", () => {
    const nodes = [makeNode("a", "seed"), makeNode("b", "zebra"), makeNode("c", "alpha")];
    const links = [makeLink("e1", "a", "b"), makeLink("e2", "a", "c")];
    expect(rankNeighborTypes("a", nodes, links)).toEqual([
      { nodeType: "alpha", count: 1 },
      { nodeType: "zebra", count: 1 },
    ]);
  });

  it("returns [] for a node with no neighbours", () => {
    const nodes = [makeNode("a", "doc"), makeNode("b", "doc")];
    const links: GraphLink[] = [];
    expect(rankNeighborTypes("a", nodes, links)).toEqual([]);
  });

  it("still ranks a neighbour whose type is absent from the palette — colour fallback is TypePanel's concern, not this function's", () => {
    const nodes = [makeNode("a", "doc"), makeNode("b", "some-unrecognised-type")];
    const links = [makeLink("e1", "a", "b")];
    expect(rankNeighborTypes("a", nodes, links)).toEqual([{ nodeType: "some-unrecognised-type", count: 1 }]);
  });

  it("counts a neighbour once even when multiple edges connect it", () => {
    const nodes = [makeNode("a", "doc"), makeNode("b", "openspec-spec")];
    const links = [makeLink("e1", "a", "b"), makeLink("e2", "b", "a"), makeLink("e3", "a", "b")];
    expect(rankNeighborTypes("a", nodes, links)).toEqual([{ nodeType: "openspec-spec", count: 1 }]);
  });

  it("excludes a self-loop from its own neighbour count", () => {
    const nodes = [makeNode("a", "doc")];
    const links = [makeLink("e1", "a", "a")];
    expect(rankNeighborTypes("a", nodes, links)).toEqual([]);
  });

  it("resolves link endpoints already replaced by force-graph's simulation with node objects, same as nodeEdges.ts", () => {
    const a = makeNode("a", "doc");
    const b = makeNode("b", "openspec-spec");
    const link = makeLink("e1", a, b);
    expect(rankNeighborTypes("a", [a, b], [link])).toEqual([{ nodeType: "openspec-spec", count: 1 }]);
  });
});

describe("topStoreTypes", () => {
  it("returns the top N types by count", () => {
    const counts: TypeCount[] = [
      { nodeType: "doc", count: 10 },
      { nodeType: "openspec-spec", count: 5 },
      { nodeType: "openspec-proposal", count: 3 },
    ];
    expect(topStoreTypes(counts, 2)).toEqual([
      { nodeType: "doc", count: 10 },
      { nodeType: "openspec-spec", count: 5 },
    ]);
  });

  it("sorts unsorted input before slicing, breaking ties by name", () => {
    const counts: TypeCount[] = [
      { nodeType: "b", count: 1 },
      { nodeType: "a", count: 5 },
      { nodeType: "c", count: 1 },
    ];
    expect(topStoreTypes(counts, 5)).toEqual([
      { nodeType: "a", count: 5 },
      { nodeType: "b", count: 1 },
      { nodeType: "c", count: 1 },
    ]);
  });

  it("returns [] for no store types", () => {
    expect(topStoreTypes([], 8)).toEqual([]);
  });
});
