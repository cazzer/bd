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
// Node click handler expands that node's neighbours (bd-hmd.5): fetching
// and merging the result is App.tsx's job (it owns the graph state and
// the tRPC client); this file's only new responsibility is dispatching
// the click and, on settle, releasing the position pins bd-hmd.5's merge
// applies — see graph/expansion.ts's header for the full pin/release
// trace. Hover tooltips remain read-only info, not an editing affordance.

import { useEffect, useRef, useState } from "react";
import ForceGraph2D from "react-force-graph-2d";
import { graphAriaSummary, nodeAccessibleDescription } from "../graph/accessibility.js";
import type { GraphCanvasData, GraphLink, GraphNode } from "../graph/encoding.js";
import { releasePins, type PositionedNode } from "../graph/expansion.js";
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

/**
 * "+" badge marking a node whose neighbours were withheld by
 * `getNeighbors`'s bound (graph-explorer/spec.md, "Hub expansion is
 * bounded": "the explorer SHALL say so"). A GLYPH, not a colour alone —
 * same reasoning as the seed ring's dash pattern (palette.ts's header):
 * this must be distinguishable without relying on hue discrimination,
 * and must coexist visually with a node that is ALSO a seed (the two
 * conditions are independent — a seed can easily have more neighbours
 * than the bound too), which a second concentric ring could not do
 * legibly. Fixed pixel size on screen (divided by globalScale, the same
 * idiom LABEL_FONT_SIZE_PX below uses) rather than scaling with the
 * node's own radius — it is a status indicator, not part of the node's
 * size encoding (degreeToRadius owns that, exclusively).
 */
const EXPANDABLE_BADGE_COLOR = "#b45309"; // amber-700 — outside palette.ts's categorical set, same reasoning as SEED_HIGHLIGHT_COLOR
const EXPANDABLE_BADGE_RADIUS_PX = 6;

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
function computeLabelPlacements(nodes: readonly DrawableNode[], globalScale: number): Map<string, LabelPlacement> {
  const fontSize = LABEL_FONT_SIZE_PX / globalScale;
  const candidates: LabelCandidate[] = nodes.map((node) => ({
    id: node.id,
    x: node.x ?? 0,
    y: node.y ?? 0,
    radius: node.radius,
    text: node.title || "(untitled)",
    // A seed's label must never disappear — losing the label on the
    // thing just searched for would be worse than an overlap. See
    // labelPlacement.ts's header and palette.ts's comment on why this
    // also keeps that module's six-node-type colour-plus-label
    // mitigation honest for seed nodes specifically.
    //
    // NOT also true of the hovered node (bd-hmd.4 review, should-fix
    // 4): that was tried — a ref updated in onNodeHover, read here —
    // but never actually took effect. force-graph's redraw is gated on
    // `!autoPauseRedraw || needsRedraw || isEngineRunning() || photons`
    // (traced through the installed source); once cooldownTicks elapses
    // and the simulation stops, updating a ref on hover sets none of
    // those, so nodeCanvasObject simply never runs again and the
    // "hovered node keeps its label" branch could never fire — dead
    // code that read as a working feature. Deleted rather than wired
    // up: forcing a redraw on every hover means either disabling
    // autoPauseRedraw (redraws every frame forever, for a label) or
    // reheating the simulation (visibly disturbs the layout just to
    // show a label) — both worse than the fix, which is that the DOM
    // tooltip (nodeLabel, below) already shows a hidden node's title on
    // hover regardless.
    alwaysShow: node.provenance.kind === "seed",
    priority: node.degree,
  }));
  const placements = placeLabels(candidates, fontSize);
  return new Map(placements.map((p) => [p.id, p]));
}

function drawNode(node: DrawableNode, ctx: CanvasRenderingContext2D, globalScale: number, placements: Map<string, LabelPlacement>, expandableNodeIds: ReadonlySet<string>): void {
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

  if (expandableNodeIds.has(node.id)) {
    const badgeRadius = EXPANDABLE_BADGE_RADIUS_PX / globalScale;
    const bx = x + node.radius * Math.SQRT1_2;
    const by = y - node.radius * Math.SQRT1_2;
    ctx.beginPath();
    ctx.arc(bx, by, badgeRadius, 0, 2 * Math.PI);
    ctx.fillStyle = EXPANDABLE_BADGE_COLOR;
    ctx.fill();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1 / globalScale;
    ctx.stroke();
    ctx.fillStyle = "#ffffff";
    ctx.font = `${badgeRadius * 1.4}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("+", bx, by + 0.5 / globalScale);
  }

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

export interface GraphCanvasProps {
  data: GraphCanvasData;
  /** Called on node click — App.tsx's `expandNode` (bd-hmd.5). Optional so this component still renders sensibly with no expansion wired up (e.g. a future read-only embed). */
  onNodeExpand?: (node: GraphNode) => void;
  /** Node ids with neighbours withheld by `getNeighbors`'s bound — drives both the on-canvas "+" badge and the sr-only list's text. See graph/expansion.ts's `expandableNodeIds`. */
  expandableNodeIds?: ReadonlySet<string>;
}

const NO_EXPANDABLE_NODES: ReadonlySet<string> = new Set();

export function GraphCanvas({ data, onNodeExpand, expandableNodeIds = NO_EXPANDABLE_NODES }: GraphCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  // A ref, not React state: it feeds the per-frame canvas draw, not the
  // component tree, so updating it must never trigger a React re-render
  // (that would fight force-graph's own animation loop for no benefit —
  // nothing here is rendered by React).
  const labelPlacementsRef = useRef<Map<string, LabelPlacement>>(new Map());

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
    <div className="flex h-full w-full flex-col overflow-hidden">
      {/*
        Accessibility (bd-hmd.4 review, should-fix): SearchResultsList
        rendered every result as a real, screen-reader-reachable <li> —
        title, type, source, degree, score, snippet. This canvas replaced
        it with a bare <canvas> and no fallback content, silently
        dropping all of that. role="img" + aria-label gives the canvas
        itself a short accessible name (the common baseline pattern for
        a canvas visualization with no accessible internal structure of
        its own — the canvas API exposes nothing to the accessibility
        tree); the sr-only list below is the actual text alternative,
        one entry per node, visually hidden but fully navigable by a
        screen reader — not folded into the aria-label string, which
        can't represent a list. This is also what keeps palette.ts's
        CVD mitigation honest for a screen-reader user specifically: the
        colour argument there depends on identity being available as
        text, and this list is text identity that never gets crowded
        out the way an on-canvas label can (labelPlacement.ts).
      */}
      <div ref={containerRef} role="img" aria-label={graphAriaSummary(data)} className="min-h-0 flex-1 bg-white">
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
              labelPlacementsRef.current = computeLabelPlacements(data.nodes as DrawableNode[], globalScale);
            }}
            nodeCanvasObject={(node, ctx, globalScale) => drawNode(node, ctx, globalScale, labelPlacementsRef.current, expandableNodeIds)}
            nodePointerAreaPaint={paintNodePointerArea}
            nodeLabel={nodeTooltip}
            onNodeClick={(node) => onNodeExpand?.(node as GraphNode)}
            // Release (bd-hmd.5): fires once the simulation actually stops
            // ticking — bounded by `cooldownTicks` below, so this is
            // neither "too early" (before an expansion's new nodes have
            // settled) nor "never" (a fixed cooldown always arrives). A
            // fresh closure every render reading the CURRENT `data.nodes`
            // is fine here — `onEngineStop` has `triggerUpdate: false`
            // (verified in the installed force-graph source), so handing
            // it a new function reference does not itself provoke another
            // reheat. See graph/expansion.ts's header for why this must be
            // `releasePins`'s in-place mutation and not a `setGraph` call.
            onEngineStop={() => releasePins(data.nodes as PositionedNode[])}
            linkColor={(link) => link.color}
            linkWidth={(link) => link.width}
            linkLabel={linkTooltip}
            cooldownTicks={200}
          />
        )}
      </div>
      <ul className="sr-only" aria-label="Nodes in this graph">
        {data.nodes.map((node) => (
          <li key={node.id}>{nodeAccessibleDescription(node, expandableNodeIds.has(node.id))}</li>
        ))}
      </ul>
    </div>
  );
}
