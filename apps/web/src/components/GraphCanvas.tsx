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
//
// Canvas type focus (bd-14q, `focusedNodeType` prop): App.tsx owns
// WHETHER a type is focused (TypePanel's click), this file owns HOW that
// reads on screen — a per-draw-call alpha reduction for a non-matching
// node (`drawNode`) or link (`isLinkDimmed`/`hexToRgba`), recomputed every
// frame from the node's own `nodeType`/a small id->type Map, never a
// second copy of `data` and never a change to any node's size or
// position. See each helper's own comment for the per-frame cost.

import { useEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D from "react-force-graph-2d";
import { graphAriaSummary, nodeAccessibleDescription } from "../graph/accessibility.js";
import type { GraphCanvasData, GraphLink, GraphNode } from "../graph/encoding.js";
import { releasePins, type PositionedNode } from "../graph/expansion.js";
import { placeLabels, type LabelCandidate, type LabelPlacement } from "../graph/labelPlacement.js";
import { endpointId } from "../graph/nodeEdges.js";
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
const SEED_HIGHLIGHT_COLOR = "#a5b4fc"; // indigo-300 — a light accent ring, legible against the dark ground (was near-black, invisible on it)
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
const EXPANDABLE_BADGE_COLOR = "#fbbf24"; // amber-400 — outside palette.ts's categorical set, same reasoning as SEED_HIGHLIGHT_COLOR; brightened from amber-700 for the dark ground
const EXPANDABLE_BADGE_RADIUS_PX = 6;

/**
 * Canvas background (bd-ktj, then bd-8ub review immersive-brief item 11):
 * `ForceGraph2D`'s `backgroundColor` prop sets `canvas.style.background`
 * on the underlying `<canvas>` element (verified against the installed
 * `react-force-graph-2d`/`force-graph` source — it's a CSS style, not a 2D
 * context fill, and the engine's own per-frame `clearCanvas` only ever
 * does `ctx.clearRect`, never paints this colour itself, so a transparent
 * value here is not fighting anything that redraws over it every frame).
 * Transparent, not a solid hex: the point of this review's starfield
 * (App.tsx's `.ambience` layer, index.css) is for it to show THROUGH the
 * canvas, and "match the page ground" (design.md) is best satisfied by
 * literally being the page ground rather than a second hardcoded copy of
 * it that would need to stay in sync by hand.
 */
const CANVAS_BACKGROUND_COLOR = "rgba(0, 0, 0, 0)";

/**
 * Alpha applied to a node/edge that doesn't match the canvas's focused
 * type (bd-14q, TypePanel's row click — design.md: "matching nodes
 * render at full strength, everything else dims"). Reduced, not zero —
 * a dimmed node/edge stays visible and clickable, just visually receded
 * relative to whatever's focused. Independent of, and composes with,
 * the seed-relevance ring above: both are transient drawing layers over
 * the same node set, never geometry (design.md's Risks section).
 *
 * 0.25 -> 0.12 (bd-8ub review, should-fix 9): against the grey clusters
 * this app's real corpus produces, 0.25 read as barely dimmed at all —
 * the focused set's advantage wasn't legible. Lowered alongside
 * `FOCUSED_HALO_STOPS` below (the other half of that same fix: a
 * brighter halo on the MATCHING nodes, not just a darker everything
 * else), so the payoff reads from both directions at once.
 */
const DIMMED_ALPHA = 0.12;

/**
 * Soft halo behind every node (bd-8ub review, immersive brief item 10:
 * "the canvas reads as a node-link diagram, not a galaxy"). Two
 * concentric, low-alpha fills in the node's own colour, scaled by its
 * OWN radius (which already encodes degree — see degreeToRadius in
 * graph/encoding.ts) rather than a fixed pixel size, so a hub's halo
 * reads bigger the same way its circle already does. Deliberately NOT
 * `ctx.shadowBlur` (a blur-radius-sized offscreen composite, paid by the
 * canvas every frame, per node with a shadow) and NOT a per-frame
 * `createRadialGradient` (allocates a new gradient object per node per
 * frame — exactly the GC-pressure pattern a 200-tick force simulation
 * redraw loop can't afford) — two extra `ctx.arc`+`ctx.fill` calls per
 * node are neither: no new object per frame (the stop tables below are
 * module-level constants, reused by every node, every frame) and no
 * offscreen composite.
 */
const AMBIENT_HALO_STOPS: ReadonlyArray<{ radiusScale: number; alpha: number }> = [
  { radiusScale: 2.2, alpha: 0.1 },
  { radiusScale: 1.5, alpha: 0.18 },
];

/**
 * Halo stops for a node matching the canvas's focused type (bd-8ub
 * review, should-fix 9 — the other half of the `DIMMED_ALPHA` fix
 * above): brighter than `AMBIENT_HALO_STOPS`, so a focused node visibly
 * glows relative to the now-more-dimmed rest of the graph, rather than
 * the payoff resting on the dimming alone.
 */
const FOCUSED_HALO_STOPS: ReadonlyArray<{ radiusScale: number; alpha: number }> = [
  { radiusScale: 2.2, alpha: 0.22 },
  { radiusScale: 1.5, alpha: 0.34 },
];

/** Draws `stops`' concentric circles behind a node — see `AMBIENT_HALO_STOPS`'s own comment for why this shape (not shadowBlur, not a gradient) and its per-frame cost. */
function drawHalo(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, color: string, stops: ReadonlyArray<{ radiusScale: number; alpha: number }>): void {
  for (const stop of stops) {
    ctx.beginPath();
    ctx.arc(x, y, radius * stop.radiusScale, 0, 2 * Math.PI);
    ctx.fillStyle = hexToRgba(color, stop.alpha);
    ctx.fill();
  }
}

const LABEL_COLOR = "#e2e8f0"; // slate-200 — matches --color-fg, legible on the dark ground (was slate-800, dark-on-dark)
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

/**
 * `focusedNodeType`, not a set of dimmed ids: every draw call already
 * knows its own `node.nodeType`, so "is this node dimmed" is a single
 * string comparison here rather than a per-frame Set built ahead of
 * time — see this file's module header on cost.
 */
function drawNode(node: DrawableNode, ctx: CanvasRenderingContext2D, globalScale: number, placements: Map<string, LabelPlacement>, expandableNodeIds: ReadonlySet<string>, focusedNodeType: string | null | undefined): void {
  const x = node.x ?? 0;
  const y = node.y ?? 0;

  // Wraps the WHOLE node draw — ring, fill, badge, label — in one
  // globalAlpha rather than only the fill: design.md's "reduced alpha on
  // fill" is the minimum bar, but dimming only the circle while its
  // label and expandable badge stayed full-strength would read as a
  // half-applied effect, not a receded node. `ctx.save()/.restore()`
  // scopes this to just this node's draw calls, so it never leaks into
  // the next node or link drawn this frame.
  ctx.save();
  const isFocusedMatch = Boolean(focusedNodeType) && node.nodeType === focusedNodeType;
  if (focusedNodeType && !isFocusedMatch) {
    ctx.globalAlpha = DIMMED_ALPHA;
  }

  // Drawn first, so it sits behind the seed ring, fill, badge, and label
  // below — see AMBIENT_HALO_STOPS'/FOCUSED_HALO_STOPS' own comments.
  drawHalo(ctx, x, y, node.radius, node.color, isFocusedMatch ? FOCUSED_HALO_STOPS : AMBIENT_HALO_STOPS);

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
    ctx.restore(); // matches the outer ctx.save() above — this early return must still pop it
    return; // dropped for this frame — still one hover away via nodeLabel's tooltip, never gone
  }

  const label = node.title || "(untitled)";
  const fontSize = LABEL_FONT_SIZE_PX / globalScale;
  ctx.font = `${fontSize}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillStyle = LABEL_COLOR;
  ctx.fillText(label, x + placement.dx, y + placement.dy);
  ctx.restore();
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

/**
 * `link.color` is always a `#rrggbb` hex string (palette.ts's
 * `colorForSourceSystem`/`FALLBACK_COLOR` never produce anything else) —
 * this only ever runs on that known shape, converting it to an rgba
 * string so a dimmed edge can carry reduced alpha the same way a dimmed
 * node's fill does. `linkColor` (below) only returns a colour string;
 * force-graph itself sets `ctx.strokeStyle` to it, so alpha has to travel
 * inside the colour string rather than via a `ctx.globalAlpha` this file
 * doesn't get to scope around the link draw call.
 */
const rgbaCache = new Map<string, string>();

// Called for every halo stop of every node and for every link, every frame;
// the (hex, alpha) domain is tiny (a handful of palette colours × four
// alphas), so caching turns a per-frame string allocation into a Map hit.
function hexToRgba(hex: string, alpha: number): string {
  const key = `${hex}|${alpha}`;
  const cached = rgbaCache.get(key);
  if (cached !== undefined) return cached;
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  const rgba = `rgba(${r}, ${g}, ${b}, ${alpha})`;
  rgbaCache.set(key, rgba);
  return rgba;
}

/** Blends `hex` toward white by `amount` (0-1) — the "light tint" half of an edge's "faintly luminous line" (bd-8ub review, immersive brief item 10), so a low-alpha edge reads as a pale glow rather than just a faded version of the raw, fully-saturated source-system hue. */
function lightenHex(hex: string, amount: number): string {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  const mix = (channel: number) => Math.round(channel + (255 - channel) * amount);
  return `#${[mix(r), mix(g), mix(b)].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/** Fraction of the way from the raw source-system hue toward white, for the tinted link colour above. */
const LINK_TINT_AMOUNT = 0.35;
/**
 * Edge alpha for the common (non-dimmed) case (bd-8ub review, immersive
 * brief item 10: "thin, faintly luminous lines ... rather than solid
 * grey"). A dimmed edge (type focus active, neither endpoint matching —
 * see `isLinkDimmed`) uses `DIMMED_ALPHA` instead, same as a dimmed
 * node's fill.
 */
const LINK_ALPHA = 0.4;

/** A link dims only when BOTH endpoints fail to match the focused type — an edge with at least one endpoint of the focused type stays at full strength, since it's still part of "what's connected to the focused type." */
function isLinkDimmed(link: GraphLink, focusedNodeType: string | null | undefined, nodeTypesById: ReadonlyMap<string, string>): boolean {
  if (!focusedNodeType) return false;
  const srcType = nodeTypesById.get(endpointId(link.source));
  const dstType = nodeTypesById.get(endpointId(link.target));
  return srcType !== focusedNodeType && dstType !== focusedNodeType;
}

export interface GraphCanvasProps {
  data: GraphCanvasData;
  /**
   * Called on node click — App.tsx's combined `handleNodeClick` (bd-hmd.5's
   * expansion, plus bd-hmd.6's "a click both expands and selects": the
   * detail panel simply reflects whichever node this last named, no
   * second gesture). Optional so this component still renders sensibly
   * with no interaction wired up (e.g. a future read-only embed).
   *
   * Also wired to the sr-only node list below (bd-hmd.6, "Detail panel
   * ... reachable by keyboard"): each entry is a real `<button>` calling
   * this same handler, not just static text — bd-hmd.4/.5 left the
   * on-canvas click with no keyboard equivalent as a known, explicitly
   * deferred gap; this ticket's own detail panel is the first feature
   * that actually needs opening by keyboard, so it closes that gap here
   * rather than deferring it again. Activating a list entry is the exact
   * same gesture as clicking the node on canvas — not a new, third way in.
   */
  onNodeExpand?: (node: GraphNode) => void;
  /** Node ids with neighbours withheld by `getNeighbors`'s bound — drives both the on-canvas "+" badge and the sr-only list's text. See graph/expansion.ts's `expandableNodeIds`. */
  expandableNodeIds?: ReadonlySet<string>;
  /**
   * The node type currently focused via TypePanel (bd-14q) — nodes/edges
   * not matching this type render dimmed; `null`/`undefined` means no
   * focus, everything at full strength. Transient drawing state only:
   * never changes a node's size, position, or `GraphCanvasData` itself —
   * see `drawNode`'s and `isLinkDimmed`'s own comments for how this is
   * applied per-frame without touching `data`.
   */
  focusedNodeType?: string | null;
}

const NO_EXPANDABLE_NODES: ReadonlySet<string> = new Set();

export function GraphCanvas({ data, onNodeExpand, expandableNodeIds = NO_EXPANDABLE_NODES, focusedNodeType = null }: GraphCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  // A ref, not React state: it feeds the per-frame canvas draw, not the
  // component tree, so updating it must never trigger a React re-render
  // (that would fight force-graph's own animation loop for no benefit —
  // nothing here is rendered by React).
  const labelPlacementsRef = useRef<Map<string, LabelPlacement>>(new Map());

  // node id -> node type, for `isLinkDimmed` (a link's endpoints carry
  // only an id, or force-graph's resolved node object, per nodeEdges.ts's
  // header — never the type directly). Rebuilt only when `data.nodes`
  // itself changes identity (mergeGraphData gives it a new array on every
  // search/expansion, but not every render), not per frame — `linkColor`
  // below does a cheap O(1) Map lookup per link per frame against this,
  // not an O(nodes) scan.
  const nodeTypesById = useMemo(() => {
    const map = new Map<string, string>();
    for (const node of data.nodes) {
      map.set(node.id, node.nodeType);
    }
    return map;
  }, [data.nodes]);

  // link.id -> its white-tinted colour (bd-8ub review, immersive brief
  // item 10), computed once per `data.links` change rather than per frame
  // per link — same reasoning as `nodeTypesById` above: `linkColor` below
  // still only pays for one `hexToRgba` call per link per frame (for the
  // alpha), not that PLUS a `lightenHex` call it would otherwise repeat
  // 60 times a second for a value that never changes between renders.
  const tintedLinkColorById = useMemo(() => {
    const map = new Map<string, string>();
    for (const link of data.links) {
      map.set(link.id, lightenHex(link.color, LINK_TINT_AMOUNT));
    }
    return map;
  }, [data.links]);

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
      {/*
        No background class here (bd-ktj) — deliberately transparent, so
        App.tsx's `.ambience` layer (index.css's vignette + starfield)
        shows through before the ResizeObserver's first measurement
        resolves and `ForceGraph2D` mounts below. Once it does,
        CANVAS_BACKGROUND_COLOR keeps that same transparency on the canvas
        itself (bd-8ub review, immersive brief item 11) — see that
        constant's own comment.
      */}
      <div ref={containerRef} role="img" aria-label={graphAriaSummary(data)} className="min-h-0 flex-1">
        {size.width > 0 && size.height > 0 && (
          <ForceGraph2D<GraphNode, GraphLink>
            graphData={data}
            width={size.width}
            height={size.height}
            nodeId="id"
            linkSource="source"
            linkTarget="target"
            backgroundColor={CANVAS_BACKGROUND_COLOR}
            // Recomputed once per frame, before any node is drawn —
            // force-graph mutates x/y directly onto the same node objects
            // in `data.nodes`, so reading them here reflects this frame's
            // actual layout. See computeLabelPlacements' own doc comment.
            onRenderFramePre={(ctx, globalScale) => {
              labelPlacementsRef.current = computeLabelPlacements(data.nodes as DrawableNode[], globalScale);
            }}
            nodeCanvasObject={(node, ctx, globalScale) => drawNode(node, ctx, globalScale, labelPlacementsRef.current, expandableNodeIds, focusedNodeType)}
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
            linkColor={(link) => {
              const tinted = tintedLinkColorById.get(link.id) ?? link.color;
              return hexToRgba(tinted, isLinkDimmed(link, focusedNodeType, nodeTypesById) ? DIMMED_ALPHA : LINK_ALPHA);
            }}
            linkWidth={(link) => link.width}
            linkLabel={linkTooltip}
            cooldownTicks={200}
          />
        )}
      </div>
      {/*
        `focus-within:not-sr-only` (bd-hmd.6), not a bare `sr-only`: this
        list's buttons are now real activation controls (see onNodeExpand's
        own comment above), and a control a sighted keyboard user can
        reach but never SEE focused is only half "reachable by keyboard".
        Tabbing into any entry reveals the whole list, fixed near the
        top-left so it's never clipped by this panel's own
        `overflow-hidden`; it returns to sr-only the moment focus leaves.
      */}
      <ul
        className="glass sr-only-node-list sr-only max-h-64 w-72 space-y-1 overflow-y-auto p-2 text-xs text-fg focus-within:not-sr-only focus-within:fixed focus-within:top-4 focus-within:left-4 focus-within:z-50"
        aria-label="Nodes in this graph"
      >
        {data.nodes.map((node) => (
          <li key={node.id}>
            <button
              type="button"
              onClick={() => onNodeExpand?.(node)}
              className="block w-full rounded px-1 py-0.5 text-left hover:bg-surface-strong focus:bg-surface-strong focus:outline-none"
            >
              {nodeAccessibleDescription(node, expandableNodeIds.has(node.id))}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
