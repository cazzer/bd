// Tests for bd-hmd.5's expansion logic — these map directly onto
// openspec/changes/add-visual-layer/specs/graph-explorer/spec.md's
// "Expansion preserves the existing layout" and "Hub expansion is
// bounded" requirements. See each describe block's comment for which
// scenario it is.
//
// Per the ticket's own testing guidance: the acceptance criterion
// ("expanding a node must not relocate an already-placed node") is
// tested here as a PURE FUNCTION — given a previous graph with
// positions and an incoming set, assert every previously-present node
// keeps its object identity, its coordinates, AND (the part identity
// alone does not cover — see expansion.ts's module header) that it is
// now pinned via fx/fy, which is the actual mechanism that survives
// force-graph's unconditional alpha(1) reheat on the next graphData
// update. Canvas pixels are never asserted on here — see encoding.ts's
// own header for why that's structurally out of reach for a test.

import { describe, expect, it } from "vitest";
import { degreeToRadius, searchResultToGraphData, type GraphCanvasData, type GraphNode, type SearchResult, type SearchResultNode } from "./encoding.js";
import {
  cursorForExpansion,
  expandableNodeIds,
  mergeExpansion,
  pinPlacedNodes,
  releasePins,
  shouldFetchExpansion,
  withExpansionError,
  withExpansionLoading,
  withExpansionResult,
  type ExpandedNeighbor,
  type ExpansionEntries,
  type ExpansionEntry,
  type NeighborsCursor,
  type PositionedNode,
} from "./expansion.js";

// --- fixtures ---------------------------------------------------------

function makeNode(overrides: Partial<GraphNode> & { id: string }): PositionedNode {
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

/** Stands in for what force-graph has mutated onto a node after simulation ticks — same convention encoding.test.ts's withSimulatedPosition uses. */
function placed(node: PositionedNode, x: number, y: number): PositionedNode {
  return Object.assign(node, { x, y });
}

function makeNeighbor(overrides: Partial<ExpandedNeighbor> & { edgeId: string; nodeId: string }): ExpandedNeighbor {
  return {
    direction: "outgoing",
    edgeType: "part-of-change",
    weight: 0.6,
    edgeSourceSystem: "repo",
    nodeType: "doc",
    nodeSourceSystem: "repo",
    externalId: overrides.nodeId,
    title: `Node ${overrides.nodeId}`,
    isEditable: false,
    degree: 3,
    ...overrides,
  } as ExpandedNeighbor;
}

function graphOf(nodes: PositionedNode[], links: GraphCanvasData["links"] = []): GraphCanvasData {
  return { nodes, links };
}

// --- "Expanding a node leaves placed nodes where they are" ----------------

describe("mergeExpansion — placed nodes are held still", () => {
  it("keeps object identity, x/y, AND pins fx/fy for every already-placed node (the acceptance criterion, as a pure function)", () => {
    const parent = placed(makeNode({ id: "parent" }), 100, 200);
    const other = placed(makeNode({ id: "other" }), -40, 15);
    const previous = graphOf([parent, other]);

    const merged = mergeExpansion(previous, {
      parentId: "parent",
      parentPosition: { x: 100, y: 200 },
      neighbors: [makeNeighbor({ edgeId: "e1", nodeId: "fresh" })],
    });

    const mergedParent = merged.nodes.find((n) => n.id === "parent");
    const mergedOther = merged.nodes.find((n) => n.id === "other");

    // Same objects, not just equal fields.
    expect(mergedParent).toBe(parent);
    expect(mergedOther).toBe(other);

    // Coordinates untouched.
    expect((mergedParent as PositionedNode).x).toBe(100);
    expect((mergedParent as PositionedNode).y).toBe(200);
    expect((mergedOther as PositionedNode).x).toBe(-40);
    expect((mergedOther as PositionedNode).y).toBe(15);

    // Pinned — the mechanism that actually survives force-graph's
    // unconditional alpha(1) reheat on this graphData update, not just
    // identity (see expansion.ts's module header for the full trace of
    // why identity alone was proven insufficient).
    expect((mergedParent as PositionedNode).fx).toBe(100);
    expect((mergedParent as PositionedNode).fy).toBe(200);
    expect((mergedOther as PositionedNode).fx).toBe(-40);
    expect((mergedOther as PositionedNode).fy).toBe(15);
  });

  it("does not pin a placed node with no known position yet — nothing to fix it to", () => {
    const unplaced = makeNode({ id: "unplaced" }); // no x/y — never ticked
    const previous = graphOf([unplaced]);

    mergeExpansion(previous, { parentId: "unplaced", parentPosition: undefined, neighbors: [] });

    expect(unplaced.fx).toBeUndefined();
    expect(unplaced.fy).toBeUndefined();
  });
});

// --- "New nodes enter near their parent" -----------------------------------

describe("mergeExpansion — new nodes seed at the parent's position", () => {
  it("seeds a brand-new neighbour's x/y at exactly the parent's given position", () => {
    const parent = placed(makeNode({ id: "parent" }), 50, -30);
    const previous = graphOf([parent]);

    const merged = mergeExpansion(previous, {
      parentId: "parent",
      parentPosition: { x: 50, y: -30 },
      neighbors: [makeNeighbor({ edgeId: "e1", nodeId: "fresh", title: "Fresh node" })],
    });

    const fresh = merged.nodes.find((n) => n.id === "fresh") as PositionedNode;
    expect(fresh).toBeDefined();
    expect(fresh.x).toBe(50);
    expect(fresh.y).toBe(-30);
    // Not pinned — it has to be free to settle, unlike the placed nodes above.
    expect(fresh.fx).toBeUndefined();
    expect(fresh.fy).toBeUndefined();
  });

  it("leaves a new node's position unset (not the origin, not a fabricated point) when the parent's own position is unknown", () => {
    const parent = makeNode({ id: "parent" }); // no x/y
    const previous = graphOf([parent]);

    const merged = mergeExpansion(previous, {
      parentId: "parent",
      parentPosition: undefined,
      neighbors: [makeNeighbor({ edgeId: "e1", nodeId: "fresh" })],
    });

    const fresh = merged.nodes.find((n) => n.id === "fresh") as PositionedNode;
    expect(fresh.x).toBeUndefined();
    expect(fresh.y).toBeUndefined();
  });

  it("gives a new node its real degree/radius from the Neighbor DTO (bd-hmd.5 review — a degree-0 fallback would draw it smaller than the same node found by search) and path provenance — an expanded node has no relevance (graph-explorer/spec.md: \"An expanded node carries no relevance\")", () => {
    const parent = placed(makeNode({ id: "parent" }), 0, 0);
    const merged = mergeExpansion(graphOf([parent]), {
      parentId: "parent",
      parentPosition: { x: 0, y: 0 },
      neighbors: [makeNeighbor({ edgeId: "e1", nodeId: "fresh", edgeType: "sibling", degree: 8 })],
    });
    const fresh = merged.nodes.find((n) => n.id === "fresh")!;
    expect(fresh.degree).toBe(8);
    expect(fresh.radius).toBe(degreeToRadius(8));
    expect(fresh.provenance).toEqual({ kind: "path", edgePath: ["sibling"] });
  });

  it("draws the SAME node at the SAME radius whether it is reached by search (searchResultToGraphData) or by expansion (mergeExpansion), given the same degree — graph-explorer/spec.md's \"Size is stable across views\", closed end-to-end on the client side (bd-hmd.5 review: the gap this closes is exactly the one lookup.test.ts's \"agrees with retrieve()'s degree\" test closes server-side)", () => {
    const DEGREE = 14;

    const searchResult = searchResultToGraphData({
      mode: "exact",
      seedCount: 0,
      nodeCount: 1,
      truncated: false,
      defaultsUsed: {} as SearchResult extends { defaultsUsed: infer D } ? D : never,
      droppedNodeIds: [],
      shrunkNodeIds: [],
      nodes: [
        {
          id: "shared-node",
          nodeType: "doc",
          sourceSystem: "repo",
          externalId: "shared-node",
          title: "Shared node",
          updatedAt: "2026-01-01T00:00:00.000Z",
          score: 1,
          depth: 1,
          isSeed: false,
          relevance: null,
          matchedNodeId: null,
          snippet: null,
          seedId: "seed",
          edgePath: ["sibling"],
          viaEdgeId: null,
          degree: DEGREE,
          isEditable: false,
        } as SearchResultNode,
      ],
      edges: [],
    } as SearchResult);
    const viaSearch = searchResult.nodes[0]!;

    const parent = placed(makeNode({ id: "parent" }), 0, 0);
    const merged = mergeExpansion(graphOf([parent]), {
      parentId: "parent",
      parentPosition: { x: 0, y: 0 },
      neighbors: [makeNeighbor({ edgeId: "e1", nodeId: "shared-node", degree: DEGREE })],
    });
    const viaExpansion = merged.nodes.find((n) => n.id === "shared-node")!;

    expect(viaExpansion.radius).toBe(viaSearch.radius);
    expect(viaExpansion.radius).toBe(degreeToRadius(DEGREE));
  });

  it("carries isEditable through from the Neighbor DTO", () => {
    const parent = placed(makeNode({ id: "parent" }), 0, 0);
    const merged = mergeExpansion(graphOf([parent]), {
      parentId: "parent",
      parentPosition: { x: 0, y: 0 },
      neighbors: [makeNeighbor({ edgeId: "e1", nodeId: "fresh", isEditable: true })],
    });
    expect(merged.nodes.find((n) => n.id === "fresh")!.isEditable).toBe(true);
  });

  it("draws the edge in the correct direction relative to the parent for both outgoing and incoming neighbors", () => {
    const parent = placed(makeNode({ id: "parent" }), 0, 0);
    const merged = mergeExpansion(graphOf([parent]), {
      parentId: "parent",
      parentPosition: { x: 0, y: 0 },
      neighbors: [
        makeNeighbor({ edgeId: "out", nodeId: "a", direction: "outgoing" }),
        makeNeighbor({ edgeId: "in", nodeId: "b", direction: "incoming" }),
      ],
    });
    const outLink = merged.links.find((l) => l.id === "out")!;
    const inLink = merged.links.find((l) => l.id === "in")!;
    expect(outLink.source).toBe("parent");
    expect(outLink.target).toBe("a");
    expect(inLink.source).toBe("b");
    expect(inLink.target).toBe("parent");
  });
});

// --- "Expanding a node already on screen" -----------------------------------

describe("mergeExpansion — expanding onto an already-drawn node", () => {
  it("does not duplicate an already-drawn neighbor, but does draw the new connecting edge", () => {
    const parent = placed(makeNode({ id: "parent" }), 0, 0);
    const alreadyDrawn = placed(makeNode({ id: "already-drawn", title: "Already here" }), 30, 40);
    const previous = graphOf([parent, alreadyDrawn]);

    const merged = mergeExpansion(previous, {
      parentId: "parent",
      parentPosition: { x: 0, y: 0 },
      neighbors: [makeNeighbor({ edgeId: "new-edge", nodeId: "already-drawn" })],
    });

    // Still exactly one entry for that id — the SAME object, unmoved.
    const matches = merged.nodes.filter((n) => n.id === "already-drawn");
    expect(matches).toHaveLength(1);
    expect(matches[0]).toBe(alreadyDrawn);
    expect((matches[0] as PositionedNode).x).toBe(30);
    expect((matches[0] as PositionedNode).y).toBe(40);

    // The connecting edge IS drawn.
    expect(merged.links.some((l) => l.id === "new-edge")).toBe(true);
  });

  it("does not duplicate the edge either, when the same edge id is re-fetched (e.g. an overlapping page)", () => {
    const parent = placed(makeNode({ id: "parent" }), 0, 0);
    const other = placed(makeNode({ id: "other" }), 5, 5);
    const existingLink = { id: "e1", source: "parent", target: "other", edgeType: "sibling", sourceSystem: "repo", weight: 0.3, color: "#000", width: 1 };
    const previous = graphOf([parent, other], [existingLink]);

    const merged = mergeExpansion(previous, {
      parentId: "parent",
      parentPosition: { x: 0, y: 0 },
      neighbors: [makeNeighbor({ edgeId: "e1", nodeId: "other" })],
    });

    expect(merged.links.filter((l) => l.id === "e1")).toHaveLength(1);
    expect(merged.links.find((l) => l.id === "e1")).toBe(existingLink);
  });

  it("dedups two rows in the SAME page that name the same new node via two different edges — one node, two edges", () => {
    const parent = placed(makeNode({ id: "parent" }), 0, 0);
    const merged = mergeExpansion(graphOf([parent]), {
      parentId: "parent",
      parentPosition: { x: 0, y: 0 },
      neighbors: [
        makeNeighbor({ edgeId: "e1", nodeId: "twice", edgeType: "part-of-change" }),
        makeNeighbor({ edgeId: "e2", nodeId: "twice", edgeType: "sibling" }),
      ],
    });
    expect(merged.nodes.filter((n) => n.id === "twice")).toHaveLength(1);
    expect(merged.links).toHaveLength(2);
  });
});

// --- pin / release, directly ------------------------------------------------

describe("pinPlacedNodes / releasePins", () => {
  it("pins every node with a known position to fx=x, fy=y", () => {
    const a = placed(makeNode({ id: "a" }), 1, 2);
    const b = placed(makeNode({ id: "b" }), -5, 9);
    pinPlacedNodes([a, b]);
    expect(a.fx).toBe(1);
    expect(a.fy).toBe(2);
    expect(b.fx).toBe(-5);
    expect(b.fy).toBe(9);
  });

  it("releasePins mutates in place and deletes fx/fy, without touching x/y", () => {
    const a = placed(makeNode({ id: "a" }), 1, 2);
    pinPlacedNodes([a]);
    expect(a.fx).toBe(1);

    releasePins([a]);
    expect(a.fx).toBeUndefined();
    expect(a.fy).toBeUndefined();
    expect(a.x).toBe(1); // position itself is untouched by release
    expect(a.y).toBe(2);
  });
});

// --- per-node pagination state: bd-hmd.1's cursor/canonicalId review, ------
// reapplied to this UI: "a cursor minted for one node, applied to
// another, silently drops neighbours." These assert the state Map keeps
// two different nodes' cursors fully independent, so a fetch for one id
// can never observe or reuse another id's cursor — the concrete, testable
// half of "switching the selected node mid-fetch cannot send the wrong
// cursor" (the other half — true request concurrency — is a synchronous
// ref in App.tsx, not reachable from a pure-function test; see that
// file's own comment).

const cursorA: NeighborsCursor = { canonicalId: "node-a", weight: 0.5, nodeId: "far-a", edgeId: "edge-a" };
const cursorB: NeighborsCursor = { canonicalId: "node-b", weight: 0.9, nodeId: "far-b", edgeId: "edge-b" };

function entriesOf(pairs: [string, ExpansionEntry][]): ExpansionEntries {
  return new Map(pairs);
}

describe("per-node expansion pagination state", () => {
  it("keeps two different nodes' cursors independent — fetching node B never reads node A's cursor", () => {
    const entries = entriesOf([
      ["node-a", { status: "loading", hasMore: true, cursor: cursorA }],
      ["node-b", { status: "idle", hasMore: true, cursor: cursorB }],
    ]);
    expect(cursorForExpansion(entries, "node-b")).toBe(cursorB);
    expect(cursorForExpansion(entries, "node-b")).not.toBe(cursorA);
  });

  it("a node with no entry yet is fetchable, with no cursor (first page)", () => {
    const entries = entriesOf([]);
    expect(shouldFetchExpansion(entries, "never-seen")).toBe(true);
    expect(cursorForExpansion(entries, "never-seen")).toBeNull();
  });

  it("a node currently loading is not fetchable again — the concurrency guard's state half", () => {
    const entries = entriesOf([["node-a", { status: "loading", hasMore: true, cursor: null }]]);
    expect(shouldFetchExpansion(entries, "node-a")).toBe(false);
  });

  it("a fully-expanded node (hasMore false) is not fetchable — clicking again is a no-op", () => {
    const entries = entriesOf([["node-a", { status: "idle", hasMore: false, cursor: null }]]);
    expect(shouldFetchExpansion(entries, "node-a")).toBe(false);
  });

  it("a node whose last attempt errored is still fetchable — a retry, not permanently stuck", () => {
    const entries = entriesOf([["node-a", { status: "error", hasMore: true, cursor: cursorA, errorMessage: "boom" }]]);
    expect(shouldFetchExpansion(entries, "node-a")).toBe(true);
    expect(cursorForExpansion(entries, "node-a")).toBe(cursorA); // retry resumes from the same page, not page 1
  });

  it("withExpansionLoading/Result/Error only ever touch the ONE id's entry, leaving every other node's entry untouched (same object)", () => {
    const untouchedEntry: ExpansionEntry = { status: "idle", hasMore: true, cursor: cursorB };
    const before = entriesOf([
      ["node-a", { status: "idle", hasMore: true, cursor: null }],
      ["node-b", untouchedEntry],
    ]);

    const loading = withExpansionLoading(before, "node-a");
    expect(loading.get("node-b")).toBe(untouchedEntry);

    const resulted = withExpansionResult(loading, "node-a", { hasMore: false, nextCursor: null });
    expect(resulted.get("node-b")).toBe(untouchedEntry);
    expect(resulted.get("node-a")).toEqual({ status: "idle", hasMore: false, cursor: null });

    const errored = withExpansionError(resulted, "node-a", "network blip");
    expect(errored.get("node-b")).toBe(untouchedEntry);
    expect(errored.get("node-a")).toEqual({ status: "error", hasMore: false, cursor: null, errorMessage: "network blip" });
  });

  it("expandableNodeIds reports exactly the ids with hasMore true", () => {
    const entries = entriesOf([
      ["node-a", { status: "idle", hasMore: true, cursor: null }],
      ["node-b", { status: "idle", hasMore: false, cursor: null }],
      ["node-c", { status: "loading", hasMore: true, cursor: cursorA }],
    ]);
    expect(expandableNodeIds(entries)).toEqual(new Set(["node-a", "node-c"]));
  });
});
