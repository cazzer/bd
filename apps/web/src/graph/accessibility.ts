// Text alternatives for the graph canvas (bd-hmd.4 review, should-fix:
// GraphCanvas.tsx is a bare <canvas>, which exposes nothing to the
// accessibility tree on its own — SearchResultsList.tsx, what this
// ticket replaced, rendered every result as a real screen-reader-
// reachable <li>). Pure text-generation functions, same reasoning as
// the rest of graph/*.ts: cheap to test directly, and GraphCanvas.tsx
// only needs to hand the result to `aria-label`/JSX text content.

import type { GraphCanvasData, GraphNode } from "./encoding.js";

/** Short accessible name for the canvas's role="img" container — a screen reader's first (and, without further exploration, only) description of the graph. */
export function graphAriaSummary(data: GraphCanvasData): string {
  if (data.nodes.length === 0) {
    return "Graph, no results.";
  }
  const nodeWord = data.nodes.length === 1 ? "node" : "nodes";
  const edgeWord = data.links.length === 1 ? "edge" : "edges";
  return `Graph of ${data.nodes.length} ${nodeWord} and ${data.links.length} ${edgeWord}.`;
}

/**
 * One node's text alternative — mirrors the fields SearchResultsList.tsx
 * used to render per row (title, type, source, degree), plus the same
 * transient relevance the canvas shows as a highlight ring for a
 * sighted user. Every field comes from GraphCanvasData already computed
 * for drawing; this restates it as a sentence, nothing more.
 */
export function nodeAccessibleDescription(node: GraphNode): string {
  const parts = [node.title || "(untitled)", `type ${node.nodeType}`, `source ${node.sourceSystem}`, `degree ${node.degree}`];
  if (node.provenance.kind === "seed") {
    parts.push(`search match, relevance ${node.provenance.relevance.toFixed(2)}`);
  }
  return parts.join(", ");
}
