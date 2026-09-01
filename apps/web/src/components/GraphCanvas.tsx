// The force-directed graph canvas (bd-hmd.4, tasks.md 4.1-4.5).
//
// `ForceGraph2D` (react-force-graph-2d — see this ticket's report for
// why that package rather than the `react-force-graph` barrel: same
// component, same maintainer, same underlying `force-graph` engine, but
// without an unconditional static import of the unused 3D/VR/AR stack)
// draws to a `<canvas>`. Everything that decides WHAT gets drawn —
// radius, colour, width, highlight state — is computed ahead of time by
// the pure functions in graph/encoding.ts and graph/palette.ts and
// tested there; this file only hands those already-computed values to
// the canvas APIs. Nothing here is unit-tested (DOM/canvas assertions
// can't reach it) by design — see encoding.test.ts's header.
//
// No node click handler: expansion-on-click is bd-hmd.5, not this
// ticket (see the ticket's "Hard constraints"). Hover tooltips are
// read-only info, not an editing affordance.

import { useEffect, useRef, useState } from "react";
import ForceGraph2D from "react-force-graph-2d";
import type { GraphCanvasData, GraphLink, GraphNode } from "../graph/encoding.js";
import { placeLabels, type LabelCandidate, type LabelPlacement } from "../graph/labelPlacement.js";
import { buildLinkTooltip, buildNodeTooltip } from "../graph/tooltip.js";

/**
 * Ring drawn around a query's seed nodes — the transient relevance
 * highlight (graph-explorer/spec.md: "Query relevance is transient,
 * never geometry"). Deliberately:
 *   - a colour OUTSIDE palette.ts's categorical set, so it never reads
 *     as "this node's type/source happens to be X";
 *   - DASHED, not solid — a second, non-colour channel, so relevance is
 *     never colour-alone;
 *   - drawn at `radius + gap`, entirely outside the node's own filled
 *     circle — it adds a ring, it does not resize the circle.
 */
const SEED_HIGHLIGHT_COLOR = "#111827";
const SEED_HIGHLIGHT_RING_GAP = 3;
const SEED_HIGHLIGHT_LINE_WIDTH = 2;
const SEED_HIGHLIGHT_DASH: [number, number] = [4, 2];

const LABEL_COLOR = "#1e293b"; // slate-800 — matches the rest of the app's text colour
/**
 * On-screen (not canvas-unit) label size in pixels. force-graph scales
 * the canvas context by the current zoom (`globalScale`) before calling
 * this, so dividing by `globalScale` cancels that scaling and keeps the
 * label a constant size on screen at any zoom — the standard
 * force-graph idiom for "legible at the default zoom" that stays
 * legible away from it too.
 */
const LABEL_FONT_SIZE_PX = 12;

type DrawableNode = GraphNode & { x?: number; y?: number };

/**
 * Which nodes get an on-canvas label this frame, and where — computed
 * once per frame (GraphCanvas's `onRenderFramePre`, before any node is
 * drawn) by graph/labelPlacement.ts's pure `placeLabels`, then read back
 * per node by `drawNode` below. Doing the placement pass once for the
 * WHOLE node set (rather than each node deciding its own offset in
 * isolation inside `nodeCanvasObject`) is what lets a crowded node avoid
 * a neighbour's label instead of just its own default slot — see
 * labelPlacement.ts's header for the full rationale (bd-hmd.4 follow-up
 * review: labels were overlapping in the corpus's densest cluster).
 */
function computeLabelPlacements(nodes: readonly DrawableNode[], globalScale: number, hoveredNodeId: string | null): Map<string, LabelPlacement> {
  const fontSize = LABEL_FONT_SIZE_PX / globalScale;
  const candidates: LabelCandidate[] = nodes.map((node) => ({
    id: node.id,
    x: node.x ?? 0,
    y: node.y ?? 0,
    radius: node.radius,
    text: node.title || "(untitled)",
    // A seed's or the hovered node's label must never disappear —
    // losing the label on the thing just searched for (or pointed at)
    // would be worse than an overlap. See labelPlacement.ts's header
    // and palette.ts's comment on why this also keeps that module's
    // six-node-type colour-plus-label mitigation honest for these
    // nodes specifically.
    alwaysShow: node.provenance.kind === "seed" || node.id === hoveredNodeId,
    priority: node.degree,
  }));
  const placements = placeLabels(candidates, fontSize);
  return new Map(placements.map((p) => [p.id, p]));
}

function drawNode(node: DrawableNode, ctx: CanvasRenderingContext2D, globalScale: number, placements: Map<string, LabelPlacement>): void {
  const x = node.x ?? 0;
  const y = node.y ?? 0;

  if (node.provenance.kind === "seed") {
    ctx.save();
    ctx.setLineDash(SEED_HIGHLIGHT_DASH);
    ctx.beginPath();
    ctx.arc(x, y, node.radius + SEED_HIGHLIGHT_RING_GAP, 0, 2 * Math.PI);
    ctx.strokeStyle = SEED_HIGHLIGHT_COLOR;
    ctx.lineWidth = SEED_HIGHLIGHT_LINE_WIDTH;
    ctx.stroke();
    ctx.restore();
  }

  ctx.beginPath();
  ctx.arc(x, y, node.radius, 0, 2 * Math.PI);
  ctx.fillStyle = node.color;
  ctx.fill();

  const placement = placements.get(node.id);
  if (!placement || !placement.visible) {
    return; // dropped for this frame — still one hover away via nodeLabel's tooltip, never gone
  }

  const label = node.title || "(untitled)";
  const fontSize = LABEL_FONT_SIZE_PX / globalScale;
  ctx.font = `${fontSize}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillStyle = LABEL_COLOR;
  ctx.fillText(label, x + placement.dx, y + placement.dy);
}

/** Hit-test region for a node — must match `drawNode`'s circle so hover/click land where the node is actually drawn, per react-force-graph-2d's own convention for custom nodeCanvasObject. */
function paintNodePointerArea(node: DrawableNode, color: string, ctx: CanvasRenderingContext2D): void {
  const x = node.x ?? 0;
  const y = node.y ?? 0;
  ctx.beginPath();
  ctx.arc(x, y, node.radius, 0, 2 * Math.PI);
  ctx.fillStyle = color;
  ctx.fill();
}

/**
 * `nodeLabel`'s declared type (`string | React.ReactHTMLElement`) is
 * narrower than what its underlying `float-tooltip` dependency actually
 * accepts at runtime: `state.content instanceof HTMLElement` is its own
 * branch, checked before the string case, and appends the element by
 * reference with no HTML parsing — see graph/tooltip.ts's header for
 * why that (not a string, and not JSX — verified against
 * float-tooltip's source: its "is this a React/Preact element" check
 * uses Preact's `isValidElement`, which tests for a Preact-internal
 * marker a real React element never carries, so a JSX value silently
 * fails to render here) is the only safe *and* working choice. The cast
 * bridges that typing gap; it does not change what's returned.
 */
function nodeTooltip(node: GraphNode): string {
  return buildNodeTooltip(node) as unknown as string;
}

function linkTooltip(link: GraphLink): string {
  return buildLinkTooltip(link) as unknown as string;
}

export function GraphCanvas({ data }: { data: GraphCanvasData }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  // Both refs, not React state: they feed the per-frame canvas draw, not
  // the component tree, so updating them must never trigger a React
  // re-render (that would fight force-graph's own animation loop for no
  // benefit — nothing here is rendered by React).
  const labelPlacementsRef = useRef<Map<string, LabelPlacement>>(new Map());
  const hoveredNodeIdRef = useRef<string | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setSize({ width, height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={containerRef} className="h-full w-full overflow-hidden bg-white">
      {size.width > 0 && size.height > 0 && (
        <ForceGraph2D<GraphNode, GraphLink>
          graphData={data}
          width={size.width}
          height={size.height}
          nodeId="id"
          linkSource="source"
          linkTarget="target"
          backgroundColor="#ffffff"
          // Recomputed once per frame, before any node is drawn —
          // force-graph mutates x/y directly onto the same node objects
          // in `data.nodes`, so reading them here reflects this frame's
          // actual layout. See computeLabelPlacements' own doc comment.
          onRenderFramePre={(ctx, globalScale) => {
            labelPlacementsRef.current = computeLabelPlacements(data.nodes as DrawableNode[], globalScale, hoveredNodeIdRef.current);
          }}
          onNodeHover={(node) => {
            hoveredNodeIdRef.current = (node as DrawableNode | null)?.id ?? null;
          }}
          nodeCanvasObject={(node, ctx, globalScale) => drawNode(node, ctx, globalScale, labelPlacementsRef.current)}
          nodePointerAreaPaint={paintNodePointerArea}
          nodeLabel={nodeTooltip}
          linkColor={(link) => link.color}
          linkWidth={(link) => link.width}
          linkLabel={linkTooltip}
          cooldownTicks={200}
        />
      )}
    </div>
  );
}
