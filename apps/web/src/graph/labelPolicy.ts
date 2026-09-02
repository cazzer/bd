// Label ELIGIBILITY policy (bd-cfc, openspec/changes/explorer-legibility/
// design.md decision 1: "Labels follow relevance"). Decides WHETHER a
// node's label is drawn at all this frame — a question kept deliberately
// separate from graph/labelPlacement.ts's job, which decides WHERE a
// label goes among the ones that survive this filter (labelPlacement.ts
// itself is unchanged by this change — its own collision-avoidance pass
// still runs, just over a smaller candidate set: see GraphCanvas.tsx's
// computeLabelPlacements, which calls shouldLabel per node BEFORE
// building a LabelCandidate at all).
//
// Pure and canvas-free, same reasoning as every other graph/*.ts module
// (encoding.ts's header): a relevance/threshold decision is worth
// asserting on directly with vitest; the drawing itself is not.

export interface LabelEligibilityInput {
  /** This node is a seed of the current query (GraphNode.provenance.kind === "seed"). */
  isSeed: boolean;
  /** This node is the currently selected node (App.tsx's selectedNodeId). */
  isSelected: boolean;
  /** This node is a direct (one-hop) neighbour of the selected node, on screen right now. */
  isNeighborOfSelected: boolean;
  /** This node is currently hovered. */
  isHovered: boolean;
  /** force-graph's own zoom level, the third argument nodeCanvasObject/onRenderFramePre already receive. */
  globalScale: number;
}

/**
 * Zoom level past which an otherwise-ambient node's label is drawn too —
 * design.md decision 1: "threshold ≈ 1.6". "Past", not "at or past": a
 * view sitting exactly on the threshold has not yet zoomed IN past it.
 */
export const DEFAULT_ZOOM_THRESHOLD = 1.6;

/**
 * Whether a node's label should be drawn this frame — graph-explorer/
 * spec.md's "Labels follow relevance": a seed, the selection, a
 * neighbour of the selection, or a hovered node is always eligible,
 * regardless of zoom; every other (ambient) node is eligible only once
 * the view is zoomed in past `threshold`.
 */
export function shouldLabel(input: LabelEligibilityInput, threshold: number = DEFAULT_ZOOM_THRESHOLD): boolean {
  if (input.isSeed || input.isSelected || input.isNeighborOfSelected || input.isHovered) {
    return true;
  }
  return input.globalScale > threshold;
}

/** Max label length before truncation-with-ellipsis — graph-explorer/spec.md: "truncated to 40 characters with an ellipsis". */
export const DEFAULT_LABEL_MAX_LENGTH = 40;

/**
 * Truncates `title` to at most `max` CODE POINTS, appending a single
 * "…". Trailing whitespace immediately before the cut is trimmed first,
 * so a truncation never reads "word␠…".
 *
 * `Array.from(title)` (which iterates by Unicode code point, not UTF-16
 * code unit), not `title.slice`/`title.length`: a surrogate-pair
 * character (most emoji, many CJK-extension characters) is two UTF-16
 * code units but ONE code point — plain `.slice(0, max)` can land mid-
 * pair and split it, producing a lone surrogate (an invalid, often
 * mis-rendered, sequence). Code-point iteration guarantees the cut only
 * ever falls on a whole-character boundary.
 *
 * The `title.length <= max` fast path below is a correctness-preserving
 * short-circuit, not just an optimisation: UTF-16 length is always >=
 * code point count for any string, so passing that check means the
 * string cannot possibly exceed `max` code points either — the
 * expensive `Array.from` allocation only runs when truncation might
 * actually be needed (GraphCanvas.tsx calls this once per labelled node
 * per frame; most titles are well under 40 characters, so this keeps
 * the common case a single `.length` comparison, not a per-frame array
 * allocation for every visible label).
 */
export function truncateLabel(title: string, max: number = DEFAULT_LABEL_MAX_LENGTH): string {
  if (title.length <= max) {
    return title;
  }
  const codePoints = Array.from(title);
  if (codePoints.length <= max) {
    return title;
  }
  return `${codePoints.slice(0, max).join("").trimEnd()}…`;
}
