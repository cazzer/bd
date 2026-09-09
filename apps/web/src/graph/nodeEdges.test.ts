// Tests for graph/nodeEdges.ts (bd-hmd.6, task 6.5's edge list in
// DetailPanel.tsx). Covers both the domain logic (which edges touch a
// node, which direction, which can be retracted) and the endpoint-
// normalization hazard the module's own header documents: force-graph
// mutates a live link's `source`/`target` from a plain id string into
// the resolved `GraphNode` object once the simulation processes it.

import { describe, expect, it } from "vitest";
import type { GraphLink } from "./encoding.js";
import { edgesTouchingNode, endpointId } from "./nodeEdges.js";

function link(overrides: Partial<GraphLink> & { id: string; source: GraphLink["source"]; target: GraphLink["target"] }): GraphLink {
  return { edgeType: "relates-to", sourceSystem: "human", weight: 1, family: "unassigned", width: 1, ...overrides };
}

describe("endpointId", () => {
  it("passes a plain id string through unchanged", () => {
    expect(endpointId("node-1")).toBe("node-1");
  });

  it("reads .id off a resolved node object — what force-graph mutates a link's source/target into once the simulation runs", () => {
    expect(endpointId({ id: "node-1", extraField: true } as unknown as { id: string })).toBe("node-1");
  });
});

describe("edgesTouchingNode", () => {
  it("finds an outgoing edge (this node is the source)", () => {
    const l = link({ id: "e1", source: "self", target: "other" });
    const views = edgesTouchingNode([l], "self");
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ link: l, otherNodeId: "other", direction: "outgoing" });
  });

  it("finds an incoming edge (this node is the target)", () => {
    const l = link({ id: "e1", source: "other", target: "self" });
    const views = edgesTouchingNode([l], "self");
    expect(views[0]).toMatchObject({ otherNodeId: "other", direction: "incoming" });
  });

  it("ignores an edge that doesn't touch this node at all", () => {
    const l = link({ id: "e1", source: "x", target: "y" });
    expect(edgesTouchingNode([l], "self")).toHaveLength(0);
  });

  it("normalizes source/target even when force-graph has already resolved them to node objects", () => {
    const l = link({ id: "e1", source: { id: "self" } as unknown as string, target: { id: "other" } as unknown as string });
    const views = edgesTouchingNode([l], "self");
    expect(views[0]).toMatchObject({ otherNodeId: "other", direction: "outgoing" });
  });

  it("marks a human-sourced edge retractable and a repo/agent-sourced one not — retraction only ever removes the human assertion", () => {
    const human = link({ id: "e1", source: "self", target: "other", sourceSystem: "human" });
    const repo = link({ id: "e2", source: "self", target: "other2", sourceSystem: "repo" });
    const agent = link({ id: "e3", source: "self", target: "other3", sourceSystem: "agent" });
    const views = edgesTouchingNode([human, repo, agent], "self");
    expect(views.find((v) => v.link.id === "e1")!.canRetract).toBe(true);
    expect(views.find((v) => v.link.id === "e2")!.canRetract).toBe(false);
    expect(views.find((v) => v.link.id === "e3")!.canRetract).toBe(false);
  });

  it("returns multiple edges touching the same node, in encounter order", () => {
    const a = link({ id: "e1", source: "self", target: "x" });
    const b = link({ id: "e2", source: "y", target: "self" });
    expect(edgesTouchingNode([a, b], "self").map((v) => v.link.id)).toEqual(["e1", "e2"]);
  });
});
