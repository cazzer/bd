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
import { familyKeyForEdgeType } from "./palette.js";
import { degreeToRadius, searchResultToGraphData, weightToEdgeWidth, type GraphCanvasData, type GraphLink, type GraphNode, type SearchResult, type SearchResultNode } from "./encoding.js";
import {
  ANNOTATES_EDGE_TYPE,
  buildAnnotationNeighbor,
  collapseExpansion,
  holdersForSearch,
  resetToSeeds,
  withExpansionHolders,
  buildAssertedLink,
  buildStandaloneNoteNode,
  cursorForExpansion,
  expandableNodeIds,
  graphNodeFromUnlinkedNote,
  HUMAN_SOURCE_SYSTEM,
  mergeAssertedEdge,
  mergeExpansion,
  mergeNodePatch,
  mergeRetractedEdge,
  mergeReweightedEdge,
  mergeStandaloneNode,
  NOTE_NODE_TYPE,
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
    const existingLink: GraphLink = { id: "e1", source: "parent", target: "other", edgeType: "sibling", sourceSystem: "repo", weight: 0.3, family: "unassigned", width: 1 };
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

// --- bd-hmd.6: annotation, standalone notes, and hand edges reuse the ------
// same pin-then-merge mechanism as mergeExpansion above (see expansion.ts's
// "Shared pin-then-merge primitive" section). Every describe block below
// asserts BOTH the domain-specific outcome (a note appears with an
// `annotates` edge, a link's weight changes, etc.) AND that every
// already-placed node was pinned — the same acceptance criterion the
// mergeExpansion tests above assert, since force-graph reheats on ANY
// graphData reference change, not only a node addition.

describe("buildAnnotationNeighbor + mergeExpansion — annotation reuses mergeExpansion verbatim (task 6.3)", () => {
  it("draws the note as a new node and the annotates edge, direction incoming (note -> target)", () => {
    const target = placed(makeNode({ id: "target" }), 10, 20);
    const bystander = placed(makeNode({ id: "bystander" }), -5, -5);
    const previous = graphOf([target, bystander]);

    const neighbor = buildAnnotationNeighbor({ noteId: "note-1", noteExternalId: "note-note-1", annotationEdgeId: "edge-1" }, "My annotation");
    const merged = mergeExpansion(previous, { parentId: "target", parentPosition: { x: 10, y: 20 }, neighbors: [neighbor] });

    const note = merged.nodes.find((n) => n.id === "note-1")!;
    expect(note.nodeType).toBe(NOTE_NODE_TYPE);
    expect(note.sourceSystem).toBe(HUMAN_SOURCE_SYSTEM);
    expect(note.title).toBe("My annotation");
    expect(note.isEditable).toBe(true);
    expect(note.provenance).toEqual({ kind: "path", edgePath: [ANNOTATES_EDGE_TYPE] });

    const edge = merged.links.find((l) => l.id === "edge-1")!;
    expect(edge.source).toBe("note-1"); // note -> target
    expect(edge.target).toBe("target");
    expect(edge.edgeType).toBe(ANNOTATES_EDGE_TYPE);
    expect(edge.sourceSystem).toBe(HUMAN_SOURCE_SYSTEM);

    // The unrelated bystander node is untouched and pinned, same acceptance
    // criterion as mergeExpansion's own "placed nodes are held still" block.
    expect(merged.nodes.find((n) => n.id === "bystander")).toBe(bystander);
    expect(bystander.fx).toBe(-5);
    expect(bystander.fy).toBe(-5);
  });

  it("falls back to a placeholder title when none was given, and never blank", () => {
    const neighbor = buildAnnotationNeighbor({ noteId: "n", noteExternalId: "note-n", annotationEdgeId: "e" }, undefined);
    expect(neighbor.title).toBe("(untitled note)");
    const blank = buildAnnotationNeighbor({ noteId: "n", noteExternalId: "note-n", annotationEdgeId: "e" }, "   ");
    expect(blank.title).toBe("(untitled note)");
  });

  it("gives the new note degree 1 — exact, not a placeholder, since the note is provably brand new", () => {
    const neighbor = buildAnnotationNeighbor({ noteId: "n", noteExternalId: "note-n", annotationEdgeId: "e" }, "t");
    expect(neighbor.degree).toBe(1);
  });
});

describe("buildStandaloneNoteNode / mergeStandaloneNode — standalone note creation (task 6.4)", () => {
  it("builds a degree-0, editable note node", () => {
    const node = buildStandaloneNoteNode({ id: "note-1" }, "A note");
    expect(node).toMatchObject({ id: "note-1", title: "A note", nodeType: NOTE_NODE_TYPE, sourceSystem: HUMAN_SOURCE_SYSTEM, degree: 0, isEditable: true });
    expect(node.radius).toBe(degreeToRadius(0));
    expect(node.provenance).toEqual({ kind: "path", edgePath: [] });
  });

  it("mergeStandaloneNode adds it without disturbing (and while pinning) already-placed nodes", () => {
    const placedNode = placed(makeNode({ id: "existing" }), 7, 8);
    const previous = graphOf([placedNode]);
    const note = buildStandaloneNoteNode({ id: "note-1" }, "A note");

    const merged = mergeStandaloneNode(previous, note);

    expect(merged.nodes.some((n) => n.id === "note-1")).toBe(true);
    expect(merged.nodes.find((n) => n.id === "existing")).toBe(placedNode);
    expect(placedNode.fx).toBe(7);
    expect(placedNode.fy).toBe(8);
  });

  it("is a no-op for a node id already drawn (e.g. re-showing an unlinked note already on screen)", () => {
    const already = placed(makeNode({ id: "note-1", title: "Original" }), 1, 1);
    const previous = graphOf([already]);

    const merged = mergeStandaloneNode(previous, buildStandaloneNoteNode({ id: "note-1" }, "Different title"));

    expect(merged.nodes.filter((n) => n.id === "note-1")).toHaveLength(1);
    expect(merged.nodes.find((n) => n.id === "note-1")).toBe(already); // same object, not replaced
  });
});

describe("graphNodeFromUnlinkedNote", () => {
  it("builds a degree-0 node carrying the server's own isEditable/nodeType/sourceSystem", () => {
    const node = graphNodeFromUnlinkedNote({ id: "n1", title: "Found note", nodeType: NOTE_NODE_TYPE, sourceSystem: HUMAN_SOURCE_SYSTEM, isEditable: true });
    expect(node.degree).toBe(0);
    expect(node.isEditable).toBe(true);
    // No colour assertion here (bd-4ye) — node-type colour is no longer
    // baked in by this builder; it's a render-time lookup in
    // GraphCanvas.tsx against App.tsx's store-wide rank map. nodeType
    // itself is still threaded through correctly, which is what a
    // colour lookup would key off of anyway.
    expect(node.nodeType).toBe(NOTE_NODE_TYPE);
  });
});

describe("buildAssertedLink / mergeAssertedEdge — hand-drawn edges (task 6.5)", () => {
  it("is drawn by its RELATION like any loaded edge, and still carries `human` as its provenance (bd-o1e)", () => {
    const link = buildAssertedLink({ id: "edge-1" }, { srcId: "a", dstId: "b", edgeType: "relates-to", weight: 0.8 });
    // Provenance is still on the link — it is what the tooltip and the
    // legend's composition line report; it just no longer decides how the
    // edge is drawn.
    expect(link.sourceSystem).toBe(HUMAN_SOURCE_SYSTEM);
    expect(link.width).toBe(weightToEdgeWidth(0.8));
    // `relates-to` is not in the family table, so it takes the reserved
    // fallback rather than being dropped or throwing.
    expect(link.family).toBe(familyKeyForEdgeType("relates-to"));
    expect(link.family).toBe("unassigned");
  });

  it("a hand-drawn edge of a KNOWN relation draws as that relation, not as something hand-drawn", () => {
    const link = buildAssertedLink({ id: "edge-2" }, { srcId: "a", dstId: "b", edgeType: "blocks" });
    expect(link.family).toBe("dependency");
    expect(link.sourceSystem).toBe(HUMAN_SOURCE_SYSTEM);
  });

  it("defaults weight to 1.0 when omitted, matching packages/core/src/edges.ts's own default", () => {
    const link = buildAssertedLink({ id: "edge-1" }, { srcId: "a", dstId: "b", edgeType: "relates-to" });
    expect(link.weight).toBe(1.0);
    expect(link.width).toBe(weightToEdgeWidth(1.0));
  });

  it("mergeAssertedEdge adds the link and pins already-placed nodes, without adding a new node", () => {
    const a = placed(makeNode({ id: "a" }), 1, 1);
    const b = placed(makeNode({ id: "b" }), 2, 2);
    const previous = graphOf([a, b]);

    const merged = mergeAssertedEdge(previous, buildAssertedLink({ id: "edge-1" }, { srcId: "a", dstId: "b", edgeType: "relates-to" }));

    expect(merged.nodes).toHaveLength(2);
    expect(merged.links.some((l) => l.id === "edge-1")).toBe(true);
    expect(a.fx).toBe(1);
    expect(b.fx).toBe(2);
  });
});

describe("mergeRetractedEdge — hand edge retraction (task 6.5)", () => {
  it("removes exactly the named link and nothing else, pinning placed nodes", () => {
    const a = placed(makeNode({ id: "a" }), 1, 1);
    const b = placed(makeNode({ id: "b" }), 2, 2);
    const keep: GraphLink = { id: "keep", source: "a", target: "b", edgeType: "sibling", sourceSystem: "repo", weight: 0.4, family: "unassigned", width: 1 };
    const gone: GraphLink = { id: "gone", source: "a", target: "b", edgeType: "relates-to", sourceSystem: "human", weight: 1, family: "unassigned", width: 5 };
    const previous = graphOf([a, b], [keep, gone]);

    const merged = mergeRetractedEdge(previous, "gone");

    expect(merged.links.map((l) => l.id)).toEqual(["keep"]);
    expect(a.fx).toBe(1);
    expect(b.fx).toBe(2);
  });

  it("is a harmless no-op when the named link isn't present", () => {
    const previous = graphOf([placed(makeNode({ id: "a" }), 0, 0)], []);
    const merged = mergeRetractedEdge(previous, "does-not-exist");
    expect(merged.links).toHaveLength(0);
  });
});

describe("mergeReweightedEdge — hand edge reweighting (task 6.5)", () => {
  it("changes weight and recomputes width for exactly the named link, mutating the SAME link object", () => {
    const a = placed(makeNode({ id: "a" }), 1, 1);
    const b = placed(makeNode({ id: "b" }), 2, 2);
    const link: GraphLink = { id: "e1", source: "a", target: "b", edgeType: "relates-to", sourceSystem: "human", weight: 0.2, family: "unassigned", width: weightToEdgeWidth(0.2) };
    const previous = graphOf([a, b], [link]);

    const merged = mergeReweightedEdge(previous, "e1", 0.9);

    const updated = merged.links.find((l) => l.id === "e1")!;
    expect(updated).toBe(link); // same object, mutated via mergeGraphData's Object.assign
    expect(updated.weight).toBe(0.9);
    expect(updated.width).toBe(weightToEdgeWidth(0.9));
    expect(a.fx).toBe(1);
    expect(b.fx).toBe(2);
  });
});

describe("mergeNodePatch — a saved content edit's new title reaches the canvas", () => {
  it("patches only the named node's fields, pinning every other placed node", () => {
    const target = placed(makeNode({ id: "target", title: "Old title" }), 3, 4);
    const other = placed(makeNode({ id: "other" }), 9, 9);
    const previous = graphOf([target, other]);

    const merged = mergeNodePatch(previous, "target", { title: "New title" });

    expect(merged.nodes.find((n) => n.id === "target")).toBe(target);
    expect(target.title).toBe("New title");
    expect(other.fx).toBe(9);
    expect(other.fy).toBe(9);
  });

  it("is a no-op when the named node isn't drawn", () => {
    const previous = graphOf([placed(makeNode({ id: "a" }), 0, 0)]);
    const merged = mergeNodePatch(previous, "not-here", { title: "x" });
    expect(merged.nodes).toHaveLength(1);
  });
});

// bd-jar: collapsing an expansion. graph-explorer/spec.md's "Expansion is
// reversible". The property that makes this non-trivial is that a node can
// be on screen for more than one reason, so collapsing one of them must
// not take it away.
describe("collapseExpansion / resetToSeeds — holders (bd-jar)", () => {
  function graphWith(ids: readonly string[], links: readonly GraphLink[] = []): GraphCanvasData {
    return graphOf(
      ids.map((id, i) => placed(makeNode({ id }), i * 10, i * 10)),
      [...links],
    );
  }
  const edge = (id: string, source: string, target: string): GraphLink => ({
    id,
    source,
    target,
    edgeType: "child_of",
    sourceSystem: "git",
    weight: 1,
    family: "containment",
    width: 5,
  });

  it("removes the nodes an expansion added and nothing else", () => {
    const graph = graphWith(["seed", "a", "b"], [edge("e1", "a", "seed"), edge("e2", "b", "seed")]);
    let holders = holdersForSearch([graph.nodes[0]!]);
    holders = withExpansionHolders(holders, "seed", ["a", "b"]);

    const { graph: after, removedIds } = collapseExpansion(graph, holders, "seed");
    expect(after.nodes.map((n) => n.id)).toEqual(["seed"]);
    expect(removedIds.sort()).toEqual(["a", "b"]);
    expect(after.links).toEqual([]); // an edge goes with its endpoints
  });

  // The whole reason holders exist rather than a simple "added by" tag.
  it("keeps a node that a second expansion also holds", () => {
    const graph = graphWith(["p1", "p2", "shared"]);
    let holders = holdersForSearch([graph.nodes[0]!, graph.nodes[1]!]);
    holders = withExpansionHolders(holders, "p1", ["shared"]);
    holders = withExpansionHolders(holders, "p2", ["shared"]);

    const first = collapseExpansion(graph, holders, "p1");
    expect(first.graph.nodes.map((n) => n.id)).toContain("shared");
    expect(first.removedIds).toEqual([]);

    // Collapsing the second one too finally releases it.
    const second = collapseExpansion(first.graph, first.holders, "p2");
    expect(second.removedIds).toEqual(["shared"]);
  });

  it("keeps a node that the query also holds, even after its expansion is collapsed", () => {
    const graph = graphWith(["seed", "alsoSeed"]);
    let holders = holdersForSearch(graph.nodes);
    holders = withExpansionHolders(holders, "seed", ["alsoSeed"]);
    const { graph: after, removedIds } = collapseExpansion(graph, holders, "seed");
    expect(removedIds).toEqual([]);
    expect(after.nodes.map((n) => n.id).sort()).toEqual(["alsoSeed", "seed"]);
  });

  it("never removes the collapsed node itself", () => {
    const graph = graphWith(["p", "child"]);
    let holders = holdersForSearch([graph.nodes[0]!]);
    holders = withExpansionHolders(holders, "p", ["child"]);
    const { graph: after } = collapseExpansion(graph, holders, "p");
    expect(after.nodes.map((n) => n.id)).toEqual(["p"]);
  });

  // graph-explorer/spec.md: "everything remaining stays where it was".
  it("leaves survivors at their exact positions, as the same objects", () => {
    const graph = graphWith(["seed", "gone"]);
    const seedBefore = graph.nodes[0] as PositionedNode;
    const { x, y } = seedBefore;
    let holders = holdersForSearch([graph.nodes[0]!]);
    holders = withExpansionHolders(holders, "seed", ["gone"]);

    const { graph: after } = collapseExpansion(graph, holders, "seed");
    const seedAfter = after.nodes[0] as PositionedNode;
    expect(seedAfter).toBe(seedBefore); // identity, not a copy — force-graph holds these by reference
    expect(seedAfter.x).toBe(x);
    expect(seedAfter.y).toBe(y);
    expect(seedAfter.fx).toBe(x); // pinned, so the reheat cannot move it
    expect(seedAfter.fy).toBe(y);
  });

  it("resetToSeeds drops every expansion at once and keeps the query's own nodes", () => {
    const graph = graphWith(["s1", "s2", "e1", "e2"]);
    let holders = holdersForSearch([graph.nodes[0]!, graph.nodes[1]!]);
    holders = withExpansionHolders(holders, "s1", ["e1"]);
    holders = withExpansionHolders(holders, "e1", ["e2"]);

    const { graph: after, removedIds } = resetToSeeds(graph, holders);
    expect(after.nodes.map((n) => n.id).sort()).toEqual(["s1", "s2"]);
    expect(removedIds.sort()).toEqual(["e1", "e2"]);
  });

  it("resetToSeeds is a no-op when nothing has been expanded", () => {
    const graph = graphWith(["s1", "s2"]);
    const holders = holdersForSearch(graph.nodes);
    const { graph: after, removedIds } = resetToSeeds(graph, holders);
    expect(removedIds).toEqual([]);
    expect(after.nodes).toHaveLength(2);
  });

  // Losing a node the person can SEE is worse than keeping one that
  // collapse cannot reach, so an untracked node is kept by both paths.
  it("keeps a node with no holder entry rather than silently deleting it", () => {
    const graph = graphWith(["tracked", "untracked"]);
    const holders = holdersForSearch([graph.nodes[0]!]);
    expect(collapseExpansion(graph, holders, "tracked").graph.nodes.map((n) => n.id)).toContain("untracked");
    expect(resetToSeeds(graph, holders).graph.nodes.map((n) => n.id)).toContain("untracked");
  });

  it("does not mutate the holder map it was given", () => {
    const graph = graphWith(["p", "child"]);
    let holders = holdersForSearch([graph.nodes[0]!]);
    holders = withExpansionHolders(holders, "p", ["child"]);
    const snapshot = new Map([...holders].map(([k, v]) => [k, [...v].sort().join(",")]));
    collapseExpansion(graph, holders, "p");
    expect(new Map([...holders].map(([k, v]) => [k, [...v].sort().join(",")]))).toEqual(snapshot);
  });
});
