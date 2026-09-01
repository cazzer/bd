// Per-frame label placement (bd-hmd.4 follow-up review): decides which
// nodes get an on-canvas label and where, so labels stay legible as the
// graph gets denser (tasks.md 4.3's "render labels legibly at the
// default zoom" scenario, re-verified against the 7-node cluster the
// review flagged, and expected to matter more once bd-hmd.5 adds
// expansion — density only goes up from here).
//
// Kept a pure, canvas-free function (no `CanvasRenderingContext2D`,
// no dependency on GraphCanvas.tsx or react-force-graph-2d) for the same
// reason encoding.ts's header gives: the decision of what to draw is
// worth asserting on directly with vitest; the drawing itself is not.
// GraphCanvas.tsx calls this once per animation frame (in
// `onRenderFramePre`, before per-node drawing) over the live node
// positions, then each node's own draw callback just looks up its
// precomputed placement.
//
// The algorithm: sort candidates so seed/hovered nodes ("alwaysShow")
// go first, then the rest by priority (GraphCanvas passes each node's
// degree); for each, in that order, try a fixed set of label positions
// around the node and take the first one that doesn't overlap any
// node-circle or label already placed this frame. A non-alwaysShow
// candidate that finds no free slot is dropped (visible: false) —
// its identity is still one hover away via GraphCanvas's tooltip
// (graph/tooltip.ts), never gone entirely. An alwaysShow candidate that
// finds no free slot is placed anyway, at its default offset: per the
// review, losing the label on the node the person just searched for (or
// is pointing at right now) is worse than an overlap.
//
// Coupled with palette.ts: that module's six-node-type categorical
// palette exceeds the CVD-safe "all pairs simultaneously visible" gate
// and leans on "colour is never the only channel — every node is also
// labelled" as its mitigation. That mitigation is now conditional, not
// universal: a node this function hides still has its type in
// GraphCanvas's hover tooltip, but hover-only identity is weaker than an
// always-on label (it requires the person to act, not just look). See
// palette.ts's own comment for the honest version of that claim.

export interface LabelCandidate {
  id: string;
  /** Node's own position, in the same graph-space units force-graph gives nodeCanvasObject. */
  x: number;
  y: number;
  /** Node's drawn radius (encoding.ts's degreeToRadius), also in graph-space units. */
  radius: number;
  text: string;
  /**
   * Seed nodes and the currently-hovered node. Always placed, even if
   * every candidate slot collides with something — see module header.
   */
  alwaysShow: boolean;
  /** Tie-break among competing non-alwaysShow candidates when slots run out — higher is placed first. GraphCanvas passes degree. */
  priority: number;
}

export interface LabelPlacement {
  id: string;
  visible: boolean;
  /** Offset from the node's (x, y) to the label's top-center anchor, in the same graph-space units. Meaningless when `visible` is false. */
  dx: number;
  dy: number;
}

export const DEFAULT_LABEL_GAP = 2;
export const DEFAULT_LABEL_LINE_HEIGHT_RATIO = 1.2;
/** Average glyph width as a fraction of font size, for a crude label-width estimate — see labelBox below for why this stays an estimate rather than a real text measurement. */
const AVG_CHAR_WIDTH_RATIO = 0.56;

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * Estimated bounding box for a top-center-anchored label — matches
 * GraphCanvas.tsx's `ctx.textAlign = "center"; ctx.textBaseline =
 * "top"` drawing convention exactly, so a placement this function
 * returns lands where it was actually planned to.
 *
 * Deliberately an estimate, not `ctx.measureText`: taking a
 * `CanvasRenderingContext2D` would make this untestable without a DOM
 * (this repo has no jsdom/happy-dom dependency — see
 * apps/web/src/graph/tooltip.ts's sibling decision to keep DOM-only code
 * out of anything vitest needs to run headlessly). An over- or
 * under-estimate only shifts how eagerly a label gets offset or hidden,
 * never correctness.
 */
function labelBox(x: number, y: number, text: string, fontSize: number, lineHeight: number): Box {
  const width = Math.max(text.length, 1) * fontSize * AVG_CHAR_WIDTH_RATIO;
  return { left: x - width / 2, right: x + width / 2, top: y, bottom: y + lineHeight };
}

function nodeBox(x: number, y: number, radius: number): Box {
  return { left: x - radius, right: x + radius, top: y - radius, bottom: y + radius };
}

function overlaps(a: Box, b: Box): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/** Extra clearance between two labels stacked on the same side of a node — see candidateOffsets. Exported so tests can compute the same expected offsets rather than duplicating the constant. */
export const STACK_GAP = 2;

/**
 * Candidate label anchor offsets around a node, tried in this order:
 * "below" (this ticket's original, always-used position — kept as the
 * preferred slot for an uncrowded node so an unrelated screenshot still
 * looks the same), "above", then one more row further below, then one
 * more row further above.
 *
 * All four stay directly above or below the node — no diagonals. A
 * diagonal third slot (below-right, say) was tried and measured to
 * overlap the cardinal below/above boxes for realistic label widths — a
 * short id like "n0" at this module's own radius/font-size already
 * collided across three of four attempted diagonals (caught by
 * labelPlacement.test.ts before this comment was written, not asserted
 * from first principles). Stacking straight up/down instead keeps the
 * same width-independent guarantee "below" and "above" already have:
 * each slot's box is separated from its same-side neighbour by
 * `lineHeight + STACK_GAP` and from the opposite side by more than a
 * full node diameter, regardless of how wide any of the labels are — no
 * text-length assumption required, unlike a diagonal whose horizontal
 * clearance from the node's own radius has to out-run the label's own
 * half-width. Four genuinely-safe slots beats more slots that quietly
 * depend on text staying short.
 */
function candidateOffsets(radius: number, lineHeight: number): ReadonlyArray<{ dx: number; dy: number }> {
  const belowNear = radius;
  const aboveNear = -(radius + lineHeight);
  const stackStep = lineHeight + STACK_GAP;
  return [
    { dx: 0, dy: belowNear }, // below (default)
    { dx: 0, dy: aboveNear }, // above
    { dx: 0, dy: belowNear + stackStep }, // one row further below
    { dx: 0, dy: aboveNear - stackStep }, // one row further above
  ];
}

/**
 * Places (or hides) a label for every candidate — see module header for
 * the full algorithm. `fontSize` must be the same graph-space value the
 * caller is about to draw with (GraphCanvas.tsx's zoom-adjusted
 * `LABEL_FONT_SIZE_PX / globalScale`), so the estimated label boxes are
 * sized consistently with the node positions they're checked against.
 *
 * Returns one placement per input candidate, in the same order as
 * `candidates` — order-preserving so a caller can zip results back
 * against its own node list without a second lookup.
 */
export function placeLabels(candidates: readonly LabelCandidate[], fontSize: number, options?: { gap?: number }): LabelPlacement[] {
  const gap = options?.gap ?? DEFAULT_LABEL_GAP;
  const lineHeight = fontSize * DEFAULT_LABEL_LINE_HEIGHT_RATIO;

  const ordered = [...candidates].sort((a, b) => {
    if (a.alwaysShow !== b.alwaysShow) return a.alwaysShow ? -1 : 1;
    if (b.priority !== a.priority) return b.priority - a.priority;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; // deterministic tie-break, never left to object insertion order
  });

  // Every node's own circle is an obstacle from the start, even before
  // any label is placed — a label must not sit on top of an unrelated
  // node.
  const placedBoxes: Box[] = candidates.map((c) => nodeBox(c.x, c.y, c.radius));
  const placements = new Map<string, LabelPlacement>();

  for (const candidate of ordered) {
    const offsets = candidateOffsets(candidate.radius + gap, lineHeight);
    let chosen: { dx: number; dy: number } | undefined;
    for (const offset of offsets) {
      const box = labelBox(candidate.x + offset.dx, candidate.y + offset.dy, candidate.text, fontSize, lineHeight);
      if (!placedBoxes.some((other) => overlaps(box, other))) {
        chosen = offset;
        break;
      }
    }
    const placedOffset = chosen ?? (candidate.alwaysShow ? offsets[0]! : undefined);
    if (placedOffset) {
      placements.set(candidate.id, { id: candidate.id, visible: true, dx: placedOffset.dx, dy: placedOffset.dy });
      placedBoxes.push(labelBox(candidate.x + placedOffset.dx, candidate.y + placedOffset.dy, candidate.text, fontSize, lineHeight));
    } else {
      placements.set(candidate.id, { id: candidate.id, visible: false, dx: 0, dy: 0 });
    }
  }

  return candidates.map((c) => placements.get(c.id)!);
}
