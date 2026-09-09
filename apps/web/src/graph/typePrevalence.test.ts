// Tests for bd-14q's ranking helpers — graph-explorer/spec.md's "The type
// control reflects the selection" requirement. Both functions are pure
// (no React, no fetch), so the acceptance criteria are asserted directly
// against constructed graphs rather than through TypePanel — the same
// convention encoding.test.ts/expansion.test.ts already establish for
// this repo (DOM/canvas code carries no tests of its own).

import { describe, expect, it } from "vitest";
import type { GraphLink, GraphNode } from "./encoding.js";
import { drawnTypeCounts, rankNeighborTypes, splitPaletteOverflow, topStoreTypes, type TypeCount } from "./typePrevalence.js";
import { assignTypeColors, colorForNodeType, FALLBACK_COLOR } from "./palette.js";

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
    family: "unassigned",
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

// bd-857: the ranking the type control leads with — what is DRAWN, not
// what the store holds.
describe("drawnTypeCounts", () => {
  it("counts the nodes on the canvas, not the store", () => {
    const nodes = [makeNode("a", "file"), makeNode("b", "file"), makeNode("c", "commit")];
    expect(drawnTypeCounts(nodes)).toEqual([
      { nodeType: "file", count: 2 },
      { nodeType: "commit", count: 1 },
    ]);
  });

  it("shares the count-desc-then-name-asc tie-break every other ranking here uses", () => {
    const nodes = [makeNode("a", "zebra"), makeNode("b", "alpha")];
    expect(drawnTypeCounts(nodes).map((t) => t.nodeType)).toEqual(["alpha", "zebra"]);
  });

  it("is empty for an empty canvas — the state the explorer opens in", () => {
    expect(drawnTypeCounts([])).toEqual([]);
  });

  // The exact shape of the bug: the store holds fourteen types, the
  // canvas holds four, and the control must not present the other ten as
  // though they were drawn.
  it("names no type that is absent from the canvas", () => {
    const drawn = drawnTypeCounts([makeNode("a", "file"), makeNode("b", "commit")]);
    expect(drawn.map((t) => t.nodeType)).toEqual(["commit", "file"]);
    expect(drawn.some((t) => t.nodeType === "gh-pr")).toBe(false);
  });
});

// bd-857: the palette-overflow grouping. graph-explorer/spec.md's "Types
// beyond the palette are grouped, not disguised".
describe("splitPaletteOverflow", () => {
  const count = (nodeType: string, count: number): TypeCount => ({ nodeType, count });

  it("splits at exactly the palette boundary — eight colours, everything after shares the fallback", () => {
    const ranked = Array.from({ length: 11 }, (_, i) => count(`t${String(i).padStart(2, "0")}`, 100 - i));
    const colors = assignTypeColors(ranked.map((r) => r.nodeType));
    const { coloured, overflow } = splitPaletteOverflow(ranked, (t) => colorForNodeType(t, colors), FALLBACK_COLOR);
    expect(coloured).toHaveLength(8);
    expect(overflow).toHaveLength(3);
    expect(overflow.map((r) => r.nodeType)).toEqual(["t08", "t09", "t10"]);
  });

  it("groups by the colour a type resolves to, not by its position in the list", () => {
    // The canvas ranking is not the store ranking: a fallback-coloured
    // type can sit at the top of what is drawn and still be
    // indistinguishable when drawn, which is the thing being reported.
    const colors = assignTypeColors(["a", "b", "c", "d", "e", "f", "g", "h", "rare"]);
    const drawnRanking = [count("rare", 50), count("a", 2)];
    const { coloured, overflow } = splitPaletteOverflow(drawnRanking, (t) => colorForNodeType(t, colors), FALLBACK_COLOR);
    expect(overflow.map((r) => r.nodeType)).toEqual(["rare"]);
    expect(coloured.map((r) => r.nodeType)).toEqual(["a"]);
  });

  it("preserves the caller's order within each half", () => {
    const colors = assignTypeColors(["a", "b", "c", "d", "e", "f", "g", "h", "x", "y"]);
    const { coloured, overflow } = splitPaletteOverflow([count("b", 9), count("y", 8), count("a", 7), count("x", 6)], (t) => colorForNodeType(t, colors), FALLBACK_COLOR);
    expect(coloured.map((r) => r.nodeType)).toEqual(["b", "a"]);
    expect(overflow.map((r) => r.nodeType)).toEqual(["y", "x"]);
  });

  it("puts nothing in the overflow group when every drawn type has its own colour", () => {
    const colors = assignTypeColors(["a", "b"]);
    const { coloured, overflow } = splitPaletteOverflow([count("a", 3), count("b", 1)], (t) => colorForNodeType(t, colors), FALLBACK_COLOR);
    expect(overflow).toEqual([]);
    expect(coloured).toHaveLength(2);
  });
});
