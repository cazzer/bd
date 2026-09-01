// Which of the currently-drawn edges touch one node, and how to present
// them from that node's point of view (bd-hmd.6, task 6.5's edge list in
// DetailPanel.tsx). Pure, so it's testable without mounting the panel —
// this repo's established convention (encoding.ts, expansion.ts,
// accessibility.ts) for anything DOM/canvas code only needs to call.
//
// `GraphLink.source`/`.target` are typed `string` (encoding.ts) — the id
// this app always WRITES when it builds a link — but `force-graph`
// mutates a link object's `source`/`target` fields to the resolved NODE
// OBJECT once its underlying d3-force simulation processes it (standard
// d3-force behaviour: `linkSource`/`linkTarget` name the keys to resolve
// FROM ids, and resolution replaces the value in place). Every existing
// call site only ever WRITES fresh string ids into new link objects
// (mergeGraphData's `Object.assign(existing, incoming)` resets them on
// every merge) and never reads them back — this module is the first code
// that does, so it must not assume the type is honest at read time.
// `endpointId` below normalizes either shape to a plain id string.

import type { GraphLink } from "./encoding.js";

/** `link.source`/`.target` may be a plain id (never yet touched by the simulation) or the resolved `GraphNode` object (force-graph's own mutation) — see module header. Either way, its id is what callers need. Exported so any other code reading a live `GraphLink`'s endpoints (DetailPanel.tsx's edge-write handlers, currently) normalizes the same way instead of re-deriving this check. */
export function endpointId(value: string | { id: string }): string {
  return typeof value === "string" ? value : value.id;
}

export interface NodeEdgeView {
  link: GraphLink;
  /** The id of the node at the OTHER end of this edge, from `nodeId`'s point of view. */
  otherNodeId: string;
  direction: "outgoing" | "incoming";
  /**
   * Only a `human`-sourced edge can be retracted from here — retracting
   * removes only the calling source system's own assertion
   * (packages/core/src/human-writes.ts's `retractEdge`), so offering the
   * control on a `repo`/`agent` edge would look actionable but silently
   * do nothing (`{ retracted: false }`, no visible change).
   */
  canRetract: boolean;
}

/** Every edge touching `nodeId` in `links`, in encounter order. A self-loop (source === target === nodeId) appears once, as outgoing — matching `edgeType` direction rather than being listed twice. */
export function edgesTouchingNode(links: readonly GraphLink[], nodeId: string): NodeEdgeView[] {
  const views: NodeEdgeView[] = [];
  for (const link of links) {
    const src = endpointId(link.source);
    const dst = endpointId(link.target);
    if (src === nodeId) {
      views.push({ link, otherNodeId: dst, direction: "outgoing", canRetract: link.sourceSystem === "human" });
    } else if (dst === nodeId) {
      views.push({ link, otherNodeId: src, direction: "incoming", canRetract: link.sourceSystem === "human" });
    }
  }
  return views;
}
