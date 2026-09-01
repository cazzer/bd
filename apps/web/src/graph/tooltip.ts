// Builds GraphCanvas.tsx's hover-tooltip content as a real DOM element —
// never a string (bd-hmd.4).
//
// react-force-graph-2d's `nodeLabel`/`linkLabel` accessors may return a
// string OR an `HTMLElement`. Its tooltip layer (the `float-tooltip`
// dependency) branches on that at render time: a returned STRING is
// assigned via d3-selection's `.html()` — i.e. `tooltipEl.innerHTML =
// content` — while a returned `HTMLElement` is appended by reference
// with no HTML parsing at all (`tooltipEl.append(() => content)`).
//
// A node's title/snippet and an edge's edge_type/source_system are
// untrusted store content — the same `ts_headline` snippet
// lib/snippet.ts's header documents as not HTML-escaped, and nothing in
// packages/core rejects `<`/`>` in a title either (bd-hmd.3 review).
// Returning any of it as a *string* here would reopen the exact
// stored-XSS that review fixed, through float-tooltip's `.html()` call
// instead of the `dangerouslySetInnerHTML` that was removed. So this
// module only ever returns HTMLElements, and every piece of node/edge
// text goes in through `.textContent` (or a `Text` node), never
// `.innerHTML` — the same rule lib/snippet.ts's header states, applied
// here to the DOM instead of to JSX.

import { parseSnippetSegments } from "../lib/snippet.js";
import type { GraphLink, GraphNode } from "./encoding.js";

function textRow(text: string): HTMLDivElement {
  const el = document.createElement("div");
  el.textContent = text;
  return el;
}

function appendSnippet(container: HTMLElement, snippet: string): void {
  for (const segment of parseSnippetSegments(snippet)) {
    if (segment.highlighted) {
      const mark = document.createElement("mark");
      mark.textContent = segment.text; // never .innerHTML — see module header
      container.appendChild(mark);
    } else {
      container.appendChild(document.createTextNode(segment.text));
    }
  }
}

/** Hover tooltip for a node: title, type/source/degree, and its seed snippet when it has one. */
export function buildNodeTooltip(node: GraphNode): HTMLElement {
  const root = document.createElement("div");
  root.appendChild(textRow(node.title || "(untitled)"));
  root.appendChild(textRow(`${node.nodeType} · ${node.sourceSystem} · degree ${node.degree}`));
  if (node.provenance.kind === "seed" && node.provenance.snippet) {
    const snippetRow = document.createElement("div");
    appendSnippet(snippetRow, node.provenance.snippet);
    root.appendChild(snippetRow);
  }
  return root;
}

/** Hover tooltip for an edge: its type/source_system and confidence weight. */
export function buildLinkTooltip(link: GraphLink): HTMLElement {
  const root = document.createElement("div");
  root.appendChild(textRow(`${link.edgeType} (${link.sourceSystem})`));
  root.appendChild(textRow(`weight ${link.weight.toFixed(2)}`));
  return root;
}
