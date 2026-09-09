// The force-directed graph canvas (bd-hmd.4, tasks.md 4.1-4.5).
//
// `ForceGraph2D` (react-force-graph-2d — see this ticket's report for
// why that package rather than the `react-force-graph` barrel: same
// component, same maintainer, same underlying `force-graph` engine, but
// without an unconditional static import of the unused 3D/VR/AR stack)
// draws to a `<canvas>`. Most of what decides WHAT gets drawn — radius,
// edge colour/width, highlight state — is computed ahead of time by the
// pure functions in graph/encoding.ts and graph/palette.ts and tested
// there; this file mostly only hands those already-computed values to
// the canvas APIs. The one deliberate exception is a NODE's type colour
// (bd-4ye): it is resolved HERE, live, per frame, against a `typeColors`
// prop (App.tsx's store-wide rank map, palette.ts's `assignTypeColors`)
// rather than baked into `GraphNode` at encode time — see
// `DrawContext`'s and `drawNode`'s own comments for why, and
// encoding.ts's `GraphNode.color` for the field this replaced. Nothing
// here is unit-tested (DOM/canvas assertions can't reach it) by design —
// see encoding.test.ts's header.
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
//
// Relevance (bd-cfc, openspec/changes/explorer-legibility/design.md
// decisions 1 and 4): a node's label (graph/labelPolicy.ts's
// `shouldLabel`, via `computeLabelPlacements`) and its halo treatment
// (`drawNode`'s `isRelevant`) both read the SAME four categories — seed,
// selected, direct neighbour of the selection, type-focus match —
// computed once per relevant node per frame, never a second
// classification invented for either concern. The "direct neighbours of
// the selected node" set itself is computed once per `(data,
// selectedNodeId)` via `useMemo` (`neighborIdsOfSelected`, below), never
// per frame.
//
// Free-area fit (bd-e9n, design.md decision 5): a search landing fits
// and centres the view within the free area to the left of the open
// right-column panels, not the full viewport - see the "Free-area fit"
// section below (fitToFreeArea and its own header) for the algebra, and
// fitRequestId's doc comment for how a settle caused by anything else
// (an expansion, annotate, connect, a saved edit - all of which reheat
// the same simulation) is told apart from one that should actually
// re-fit. Review follow-up: an earlier version also fit on every settled
// expansion, but the settle path fires whether or not the fetch actually
// added anything, so the first click on ANY node re-centred and
// re-scaled the whole view — expansion never re-fits now; new nodes
// enter near their parent (the existing "Expansion preserves the
// existing layout" requirement) and the person can pan.

import { useEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D, { type ForceGraphMethods } from "react-force-graph-2d";
import { graphAriaSummary, nodeAccessibleDescription } from "../graph/accessibility.js";
import type { GraphCanvasData, GraphLink, GraphNode } from "../graph/encoding.js";
import { releasePins, type PositionedNode } from "../graph/expansion.js";
import { robustBbox, ROBUST_BBOX_MIN_POINTS } from "../graph/fitBounds.js";
import { placeLabels, type LabelCandidate, type LabelPlacement } from "../graph/labelPlacement.js";
import { shouldLabel, truncateLabel } from "../graph/labelPolicy.js";
import { edgesTouchingNode, endpointId } from "../graph/nodeEdges.js";
import { colorForNodeType, edgeFamily } from "../graph/palette.js";
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

/**
 * Halo for every node that is NOT currently relevant (bd-cfc, design.md
 * decision 4: "Halos follow relevance too" — the same seed/selected/
 * neighbour-of-selected/type-focus-match categories decision 1 already
 * establishes for labels). ONE stop, not two, and fainter than either of
 * `AMBIENT_HALO_STOPS`' own stops — an ambient cluster still reads as
 * "there is more graph here" without the stacked-fill fog a uniform
 * two-stop halo on every node produced at density. Applying the FULL
 * (ambient or focused) halo only to relevant nodes, and this single ring
 * to everything else, is what makes that trade — see drawNode's own
 * `isRelevant` branch.
 */
const AMBIENT_SINGLE_RING_STOPS: ReadonlyArray<{ radiusScale: number; alpha: number }> = [{ radiusScale: 1.6, alpha: 0.08 }];

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
 * The truncated text actually drawn for a node's label (bd-cfc, design.md
 * decision 1: "A drawn label is truncated to 40 characters with an
 * ellipsis; the full title remains available through the existing hover
 * tooltip ... and in the detail panel"). Shared by `computeLabelPlacements`
 * (which needs the SAME text labelPlacement.ts's collision boxes are
 * estimated against — see labelBox in that file) and `drawNode` (which
 * draws it) so the two can never disagree about what text a placement's
 * box was actually sized for.
 */
function labelText(node: DrawableNode): string {
  return truncateLabel(node.title || "(untitled)");
}

/**
 * Which nodes get an on-canvas label this frame, and where — computed
 * once per frame (GraphCanvas's `onRenderFramePre`, before any node is
 * drawn), then read back per node by `drawNode` below.
 *
 * Two passes, kept deliberately separate (design.md decision 1): first,
 * graph/labelPolicy.ts's pure `shouldLabel` decides WHICH nodes are
 * eligible to be labelled at all this frame (seed / selected / neighbour
 * of the selection / hovered, always; an ambient node only once zoomed
 * in past the threshold) — a node that fails this never becomes a
 * `LabelCandidate` in the first place, so labelPlacement.ts's O(n²)
 * collision pass only ever runs over the (typically much smaller)
 * eligible subset, not every node in the view. Second,
 * graph/labelPlacement.ts's pure `placeLabels` decides WHERE each
 * survivor's label goes, avoiding overlap with node circles and other
 * placed labels — see that file's header for the full rationale
 * (bd-hmd.4 follow-up review: labels were overlapping in the corpus's
 * densest cluster).
 *
 * `isHovered` is always passed as `false` here (bd-hmd.4 review,
 * should-fix 4, still true after bd-cfc): a live per-hover redraw was
 * already tried — a ref updated in onNodeHover, read here — and never
 * actually took effect. force-graph's redraw is gated on
 * `!autoPauseRedraw || needsRedraw || isEngineRunning() || photons`
 * (traced through the installed source); once cooldownTicks elapses and
 * the simulation stops, updating OUR OWN state on hover sets none of
 * those, so nodeCanvasObject simply never runs again for a hover alone
 * — true regardless of whether that state is a ref or React state, since
 * the gate is inside force-graph's own engine, not anything React
 * re-rendering this component can reach. Forcing a redraw on every hover
 * means either disabling autoPauseRedraw (redraws every frame forever,
 * for a label) or reheating the simulation (visibly disturbs the layout
 * just to show a label) — both worse than the fix already in place: the
 * DOM tooltip (`nodeTooltip`, below) shows a node's full, untruncated
 * title on hover regardless of whether its on-canvas label is drawn.
 * `shouldLabel`'s `isHovered` branch is real and tested
 * (labelPolicy.test.ts) — it's simply never exercised by a live signal
 * from this canvas today, the same honest state bd-hmd.4 left it in.
 */
function computeLabelPlacements(nodes: readonly DrawableNode[], globalScale: number, selectedNodeId: string | null | undefined, neighborIdsOfSelected: ReadonlySet<string>): Map<string, LabelPlacement> {
  const fontSize = LABEL_FONT_SIZE_PX / globalScale;
  const candidates: LabelCandidate[] = [];
  for (const node of nodes) {
    const isSeed = node.provenance.kind === "seed";
    const isSelected = node.id === selectedNodeId;
    const isNeighborOfSelected = neighborIdsOfSelected.has(node.id);
    if (!shouldLabel({ isSeed, isSelected, isNeighborOfSelected, isHovered: false, globalScale })) {
      continue; // not eligible this frame — still one hover away via nodeTooltip, never gone
    }
    candidates.push({
      id: node.id,
      x: node.x ?? 0,
      y: node.y ?? 0,
      radius: node.radius,
      text: labelText(node),
      // explorer-legibility review (hub-density follow-up): a relevant
      // node's label is tried, and contests a slot, ahead of an ambient
      // one — but it CAN still lose that contest and be dropped once
      // every slot is genuinely taken (labelPlacement.ts's own header).
      // An earlier version force-placed on top of whatever was already
      // there instead, which is exactly the overlap this exists to
      // prevent at hub density (several seeds/neighbours converging on
      // one node).
      alwaysShow: isSeed || isSelected || isNeighborOfSelected,
      // Priority order (labelPlacement.ts's own doc comment): the
      // selected node itself outranks a seed, which outranks a mere
      // neighbour of the selection, which outranks everything else
      // (an ambient node, eligible only once zoomed in past
      // labelPolicy.ts's threshold) — NOT raw degree, which used to
      // decide this and let a high-degree ambient node's label win a
      // slot away from a lower-degree but more relevant one.
      priority: isSelected ? 3 : isSeed ? 2 : isNeighborOfSelected ? 1 : 0,
    });
  }
  const placements = placeLabels(candidates, fontSize);
  return new Map(placements.map((p) => [p.id, p]));
}

/**
 * Everything `drawNode` needs that is session/prop state rather than a
 * per-node data field — bundled into one object (built once per React
 * render in `GraphCanvas`'s body, NOT per frame or per node — see that
 * component's own comment) purely to keep `drawNode`'s own parameter
 * list from growing every time this file gains one more piece of
 * relevance state, not because any of these are expensive to compute.
 */
interface DrawContext {
  /** App.tsx's store-wide rank map (bd-4ye) — the SAME map GraphCanvas, TypePanel, and SearchBar all read, so none of them can disagree about a type's colour. */
  typeColors: ReadonlyMap<string, string>;
  focusedNodeType: string | null | undefined;
  selectedNodeId: string | null | undefined;
  /** One-hop neighbours of `selectedNodeId`, computed once per (data, selectedNodeId) — see `GraphCanvas`'s own `useMemo`. */
  neighborIdsOfSelected: ReadonlySet<string>;
}

/**
 * `focusedNodeType`/`typeColors`/etc. arrive bundled in `context`, not a
 * set of dimmed ids or a precomputed per-node colour: every draw call
 * already knows its own `node.nodeType`, so "is this node dimmed" /
 * "what colour is this node" are a single string comparison and a
 * single `Map.get` here (colorForNodeType is an O(1) lookup, no
 * allocation) rather than a per-frame Set/Map built ahead of time — see
 * this file's module header on cost.
 */
function drawNode(node: DrawableNode, ctx: CanvasRenderingContext2D, globalScale: number, placements: Map<string, LabelPlacement>, expandableNodeIds: ReadonlySet<string>, context: DrawContext): void {
  const x = node.x ?? 0;
  const y = node.y ?? 0;
  // bd-4ye: node-type colour is no longer a baked-in GraphNode field —
  // see encoding.ts's GraphNode.color comment. Resolved here, live,
  // against App.tsx's store-wide rank map, the same way `isFocusedMatch`
  // below already resolves `focusedNodeType` live against `node.nodeType`.
  const fillColor = colorForNodeType(node.nodeType, context.typeColors);

  // Wraps the WHOLE node draw — ring, fill, badge, label — in one
  // globalAlpha rather than only the fill: design.md's "reduced alpha on
  // fill" is the minimum bar, but dimming only the circle while its
  // label and expandable badge stayed full-strength would read as a
  // half-applied effect, not a receded node. `ctx.save()/.restore()`
  // scopes this to just this node's draw calls, so it never leaks into
  // the next node or link drawn this frame.
  ctx.save();
  const isFocusedMatch = Boolean(context.focusedNodeType) && node.nodeType === context.focusedNodeType;
  if (context.focusedNodeType && !isFocusedMatch) {
    ctx.globalAlpha = DIMMED_ALPHA;
  }

  const isSeed = node.provenance.kind === "seed";
  // bd-cfc, design.md decision 4: "Halos follow relevance too" — reuses
  // the SAME relevance categories decision 1 already establishes for
  // labels, computed once here and read by both the halo branch below
  // and (via computeLabelPlacements, called separately in
  // onRenderFramePre) the label draw path.
  const isSelected = node.id === context.selectedNodeId;
  const isNeighborOfSelected = context.neighborIdsOfSelected.has(node.id);
  const isRelevant = isSeed || isSelected || isNeighborOfSelected || isFocusedMatch;

  // Drawn first, so it sits behind the seed ring, fill, badge, and label
  // below — see AMBIENT_HALO_STOPS'/FOCUSED_HALO_STOPS'/
  // AMBIENT_SINGLE_RING_STOPS' own comments.
  drawHalo(ctx, x, y, node.radius, fillColor, isRelevant ? (isFocusedMatch ? FOCUSED_HALO_STOPS : AMBIENT_HALO_STOPS) : AMBIENT_SINGLE_RING_STOPS);

  if (isSeed) {
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
  ctx.fillStyle = fillColor;
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

  // Truncated (bd-cfc), the SAME text labelPlacement.ts's collision box
  // was estimated against — see labelText's own comment. The full,
  // untruncated title stays reachable via the hover tooltip
  // (`nodeTooltip`, below) and the detail panel.
  const label = labelText(node);
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
 * A family's colour is always a `#rrggbb` hex string (palette.ts's
 * `EDGE_FAMILIES` table never holds anything else) —
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

/**
 * Arrowhead size in SCREEN pixels (bd-o1e) — divided by `globalScale` at
 * the accessor, like every other screen-space length in this file.
 * Deliberately small: direction is a cue on an edge, not a feature of it.
 */
const LINK_ARROW_LENGTH_PX = 7;

/**
 * 1 puts the arrowhead flush against the target node's edge — force-graph
 * does the node-radius backoff itself (`posAlongLine = startR +
 * arrowLength + (lineLen - startR - endR - arrowLength) * relPos`), so
 * `relPos` is a fraction of the gap BETWEEN the two circles, not of the
 * centre-to-centre line. That only works if force-graph knows the real
 * radii, which is what `nodeVal`/`nodeRelSize` below are for.
 */
const LINK_ARROW_REL_POS = 1;

/**
 * Makes `sqrt(nodeVal(node)) * nodeRelSize` equal this app's own
 * `node.radius` (bd-o1e). force-graph derives a node's radius from those
 * two for three purposes, and every one of them was wrong here before,
 * because nothing ever set them: `nodeVal` defaults to `undefined` and
 * `nodeRelSize` to 4, so force-graph believed every node had radius 4
 * while `drawNode` was drawing 3 to 9.
 *
 * The visible consequence was that arrowheads vanished. Links are drawn
 * beneath nodes, and the arrow backoff used the believed radius (4) —
 * so on any node larger than that the head landed inside the circle and
 * the node painted over it. That hit exactly the wrong nodes: every
 * `child_of` edge in a repository's neighbourhood points AT the repo,
 * the largest node on screen, so containment direction disappeared
 * precisely where a reader most needs it.
 *
 * Feeding the true radius through fixes the other two consumers with it
 * — `getGraphBbox` (which `fitToFreeArea` builds on, and which was
 * under-counting large nodes when fitting) and the default pointer-area
 * paint (already overridden here by `paintNodePointerArea`, so no change
 * in practice). Squaring is exact rather than approximate: force-graph
 * takes the square root straight back out.
 */
const NODE_REL_SIZE = 1;
function nodeVal(node: GraphNode): number {
  return node.radius * node.radius;
}

/** Arrowheads are drawn solid rather than at LINK_ALPHA — a 5px triangle at 0.4 alpha is invisible, and the head is the whole point of drawing direction. */
const LINK_ARROW_ALPHA = 0.95;

/** A link dims only when BOTH endpoints fail to match the focused type — an edge with at least one endpoint of the focused type stays at full strength, since it's still part of "what's connected to the focused type." */
function isLinkDimmed(link: GraphLink, focusedNodeType: string | null | undefined, nodeTypesById: ReadonlyMap<string, string>): boolean {
  if (!focusedNodeType) return false;
  const srcType = nodeTypesById.get(endpointId(link.source));
  const dstType = nodeTypesById.get(endpointId(link.target));
  return srcType !== focusedNodeType && dstType !== focusedNodeType;
}

// --- Free-area fit (bd-e9n, design.md decision 5: "Fit-to-view respects
// the panels") -------------------------------------------------------------
//
// force-graph's own `zoomToFit(durationMs, padding)` centres its fitted
// bbox in the FULL viewport, symmetric padding on every side — there is
// no "fit within this sub-rectangle" primitive. Rather than call it and
// then correct the result (reading `zoom()`/`centerAt()` back mid-tween,
// racing whatever `durationMs` the animation is still running), this
// computes the same centre/zoom `zoomToFit` would (via the exposed
// `getGraphBbox`) but against the FREE width (`width - insetRight`)
// instead of the full width, then issues ONE animated `centerAt`+`zoom`
// pair — a single settle, not a fit followed by a visible correction.
//
// The algebra behind "shift the centre by `+insetRight / (2 * scale)`":
// zoomToFit centres its bbox in the full viewport, so before any shift
// the bbox's screen-space margin is `padding` on every side. Shifting the
// screen-space centre left by `insetRight / 2` px (equivalently, the
// GRAPH-space centre right by `insetRight / (2 * scale)`, since
// screen = graph * scale) turns that even `padding` margin into
// `padding - insetRight / 2` on the left and within the free area on the
// right — which is >= 0 (no clipping under the panel) as long as
// `padding >= insetRight / 2`. `FIT_PADDING_PX` below is chosen with
// exactly that margin, so the two calls below always land the bbox fully
// inside `[0, width - insetRight]`, centred with `FIT_BASE_PADDING_PX`
// clear on every side — never computed against the free width directly
// (which would ALSO work, but would zoom in more aggressively than
// today's `zoomToFit` padding contract does for the no-inset case this
// still has to match when insetRight is 0).
//
// Same defensive clamp `zoomToFit` itself applies (traced in the
// installed force-graph source, force-graph.js's own `zoomToFit`): a
// degenerate bbox (a single node, or every node stacked at one point)
// would otherwise divide by a zero-width/height span.
//
// Outlier-trimmed bbox (bd-e9n review, explorer-legibility finding 6):
// `getGraphBbox`'s bbox is the LITERAL extent of every drawn node, so one
// node that force-layout has drifted far from the rest shrinks the
// fitted zoom for every other node just to keep that one on-screen. At
// `ROBUST_BBOX_MIN_POINTS` nodes or more, this reaches for
// `graph/fitBounds.ts`'s `robustBbox` instead — the same bbox shape,
// computed from `data.nodes`' own x/y/radius and trimmed to the 5th-95th
// percentile per axis — so a handful of outliers no longer dictate
// everyone else's zoom level; those nodes can land off-screen, which is
// an accepted trade (see that file's own header). Below that count,
// `getGraphBbox` is used exactly as before — nothing changes for a
// small graph, and this never diverges from `zoomToFit`'s own no-inset
// padding contract for that case.
const FIT_DURATION_MS = 400;
const FIT_BASE_PADDING_PX = 48;
const FIT_MIN_ZOOM = 1e-12;
const FIT_MAX_ZOOM = 1e12;

type FreeAreaFittable = Pick<ForceGraphMethods<GraphNode, GraphLink>, "getGraphBbox" | "centerAt" | "zoom">;

/**
 * Fits the current graph data within the free area to the left of the
 * right-column panels, and centres it there — see this section's own
 * header for the algebra. `nodes` is `data.nodes` at the moment the
 * simulation settled — used ONLY for the outlier-trimmed bbox at
 * `ROBUST_BBOX_MIN_POINTS`+ nodes (see that constant's own comment);
 * below that count this reads `fg.getGraphBbox()` exactly as before and
 * `nodes` goes unused. A no-op when there is nothing placed yet (both
 * bbox sources return `null` for zero nodes, the same case `zoomToFit`
 * itself no-ops on).
 */
function fitToFreeArea(fg: FreeAreaFittable, nodes: readonly DrawableNode[], insetRight: number, width: number, height: number): void {
  const bbox =
    nodes.length >= ROBUST_BBOX_MIN_POINTS
      ? robustBbox(nodes.map((n) => ({ x: n.x ?? 0, y: n.y ?? 0, radius: n.radius })))
      : fg.getGraphBbox();
  if (!bbox) return;

  const padding = FIT_BASE_PADDING_PX + insetRight / 2;
  const bboxWidth = bbox.x[1] - bbox.x[0];
  const bboxHeight = bbox.y[1] - bbox.y[0];
  const scale = Math.max(FIT_MIN_ZOOM, Math.min(FIT_MAX_ZOOM, (width - padding * 2) / bboxWidth, (height - padding * 2) / bboxHeight));

  const centerX = (bbox.x[0] + bbox.x[1]) / 2 + insetRight / (2 * scale);
  const centerY = (bbox.y[0] + bbox.y[1]) / 2;
  fg.centerAt(centerX, centerY, FIT_DURATION_MS);
  fg.zoom(scale, FIT_DURATION_MS);
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
  /**
   * App.tsx's store-wide type-colour rank map (bd-4ye, palette.ts's
   * `assignTypeColors`) — the SAME map TypePanel and SearchBar receive,
   * so a node's fill/halo colour here never disagrees with its swatch
   * elsewhere. Required (not optional with a fallback) — every caller
   * already holds this from the same state `focusedNodeType`/`data`
   * derive from, so a silently-empty default would only mask a caller
   * that forgot to thread it through.
   */
  typeColors: ReadonlyMap<string, string>;
  /**
   * The currently selected node's id (bd-cfc) — drives both label
   * eligibility (design.md decision 1) and halo relevance (decision 4)
   * for the selection and its direct neighbours. `null`/`undefined`
   * means nothing selected, so only seed/type-focus relevance applies.
   */
  selectedNodeId?: string | null;
  /**
   * px currently occupied on the right by the open right-column panels
   * (bd-e9n, design.md decision 5) — 0 when none are open. App.tsx owns
   * exactly which panels are open (the same state that already decides
   * that column's rendered width), so this stays a plain prop rather
   * than a `ResizeObserver`/DOM measurement here — see this file's
   * "Free-area fit" section header. Never changes the canvas's own size
   * or `data`; it only shifts where a settled fit centres itself.
   */
  insetRight: number;
  /**
   * Bumped by App.tsx specifically when a search result lands — never by
   * any other graph-mutating write (an expansion settling, annotate,
   * connect, retract, reweight, a saved edit), and never by opening or
   * closing a panel alone. design.md decision 5 / Risks: "only a search
   * result landing triggers a fit." Every one of those OTHER writes also
   * reheats the simulation (they all go through graph/expansion.ts's
   * pin-then-merge, which gives `data` a fresh top-level reference every
   * time — see that file's header), so `onEngineStop` alone can't
   * distinguish "a search just landed" from "an edge got reweighted" or
   * "a node was expanded." Comparing this id against the id last fitted
   * for (inside `onEngineStop`, below) can. Review follow-up: an earlier
   * version also bumped this when an expansion settled — see this file's
   * own header for why that regressed ("the first click on any node
   * re-fits the whole view").
   */
  fitRequestId: number;
}

const NO_EXPANDABLE_NODES: ReadonlySet<string> = new Set();
const NO_NEIGHBORS: ReadonlySet<string> = new Set();

export function GraphCanvas({ data, onNodeExpand, expandableNodeIds = NO_EXPANDABLE_NODES, focusedNodeType = null, typeColors, selectedNodeId = null, insetRight, fitRequestId }: GraphCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const fgRef = useRef<ForceGraphMethods<GraphNode, GraphLink> | undefined>(undefined);
  // The `fitRequestId` this canvas last actually fit for — seeded to the
  // CURRENT prop so mounting never fits an empty/unsearched graph on its
  // own; only a later change (a new search landing) makes the comparison
  // in `onEngineStop` below fail and trigger a fit. See `fitRequestId`'s
  // own doc comment for why this, not the generic engine-stop signal
  // `releasePins` already uses, is what "only a search triggers a fit"
  // actually requires.
  const lastFittedRequestIdRef = useRef(fitRequestId);

  // A ref, not React state: it feeds the per-frame canvas draw, not the
  // component tree, so updating it must never trigger a React re-render
  // (that would fight force-graph's own animation loop for no benefit —
  // nothing here is rendered by React).
  const labelPlacementsRef = useRef<Map<string, LabelPlacement>>(new Map());

  // The current zoom, captured in `onRenderFramePre` and read by the link
  // accessors below (bd-o1e). force-graph runs that hook once per frame
  // BEFORE it draws links, so this ref is always this frame's value by
  // the time a link accessor reads it. It exists because `linkLineDash`
  // and `linkDirectionalArrowLength` are given only the link — unlike
  // `nodeCanvasObject`, which receives `globalScale` directly — while
  // force-graph draws links inside the zoom transform, so a dash length
  // handed over raw would be in GRAPH units and would visibly stretch as
  // the canvas zooms. Dividing by this reproduces the `/ globalScale`
  // idiom `LABEL_FONT_SIZE_PX` and `EXPANDABLE_BADGE_RADIUS_PX` already
  // use, so a relation's dash reads the same at every zoom level.
  const globalScaleRef = useRef(1);

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
      map.set(link.id, lightenHex(edgeFamily(link.family).color, LINK_TINT_AMOUNT));
    }
    return map;
  }, [data.links]);

  /**
   * One-hop neighbours of the selected node (bd-cfc, design.md decisions
   * 1 and 4) — computed once per `(data, selectedNodeId)` change via
   * `useMemo`, NEVER per frame or per node: reuses graph/nodeEdges.ts's
   * already-tested `edgesTouchingNode` (the same helper DetailPanel.tsx's
   * edge list is built from) rather than re-deriving the source/target
   * normalization it already handles. Both `drawNode` (halo relevance)
   * and `computeLabelPlacements` (label eligibility) read this same set
   * every frame as an O(1) `.has()` lookup — no per-frame recomputation.
   */
  const neighborIdsOfSelected = useMemo(() => {
    if (!selectedNodeId) return NO_NEIGHBORS;
    const ids = new Set<string>();
    for (const view of edgesTouchingNode(data.links, selectedNodeId)) {
      ids.add(view.otherNodeId);
    }
    return ids;
  }, [data.links, selectedNodeId]);

  // Built once per React render (not per frame — see DrawContext's own
  // comment), so `drawNode`'s per-frame closure below only ever reads an
  // already-computed object, never allocates one.
  const drawContext: DrawContext = { typeColors, focusedNodeType, selectedNodeId, neighborIdsOfSelected };

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
      {/*
        `id="graph-canvas-container"` + `tabIndex={-1}` (bd-e9n review):
        DetailPanel.tsx's `handleClose` falls back to focusing this
        container when neither the previously-focused element nor the
        search input is a valid restoration target — a plain `<div>`
        (even with `role="img"`) isn't focusable by default, so
        `tabIndex={-1}` makes `.focus()` actually land here rather than
        silently no-op to `<body>`. `-1` keeps it out of the normal Tab
        order — this is a programmatic fallback target, not a new stop
        in the page's own tab sequence.
      */}
      <div
        ref={containerRef}
        id="graph-canvas-container"
        tabIndex={-1}
        role="img"
        aria-label={graphAriaSummary(data)}
        className="min-h-0 flex-1 focus:outline-none"
      >

        {size.width > 0 && size.height > 0 && (
          <ForceGraph2D<GraphNode, GraphLink>
            ref={fgRef}
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
              globalScaleRef.current = globalScale;
              labelPlacementsRef.current = computeLabelPlacements(data.nodes as DrawableNode[], globalScale, selectedNodeId, neighborIdsOfSelected);
            }}
            nodeVal={nodeVal}
            nodeRelSize={NODE_REL_SIZE}
            nodeCanvasObject={(node, ctx, globalScale) => drawNode(node, ctx, globalScale, labelPlacementsRef.current, expandableNodeIds, drawContext)}
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
            //
            // The free-area fit (bd-e9n) piggybacks on this SAME settle
            // signal — it is exactly "the simulation actually stopped
            // ticking" for a fit too, not a second detector — but is
            // gated by the `fitRequestId` comparison below (see that
            // prop's own doc comment) so a settle caused by anything
            // other than a search landing (an expansion, annotate,
            // connect, retract, reweight, a saved edit — all of which
            // also reach this callback, per graph/expansion.ts's header)
            // leaves the already-fitted view untouched.
            onEngineStop={() => {
              releasePins(data.nodes as PositionedNode[]);
              if (fitRequestId !== lastFittedRequestIdRef.current) {
                lastFittedRequestIdRef.current = fitRequestId;
                const fg = fgRef.current;
                if (fg) fitToFreeArea(fg, data.nodes as DrawableNode[], insetRight, size.width, size.height);
              }
            }}
            linkColor={(link) => {
              const tinted = tintedLinkColorById.get(link.id) ?? edgeFamily(link.family).color;
              return hexToRgba(tinted, isLinkDimmed(link, focusedNodeType, nodeTypesById) ? DIMMED_ALPHA : LINK_ALPHA);
            }}
            // bd-o1e: dash and arrowhead are the channels that carry the
            // RELATION (design.md decision 1); width still carries weight,
            // scaled per family so a structural edge reads lighter than a
            // dependency. See weightToEdgeWidth on why width alone is a
            // weak signal in this store.
            linkWidth={(link) => link.width * edgeFamily(link.family).widthScale}
            linkLineDash={(link) => {
              const { dash } = edgeFamily(link.family);
              if (dash.length === 0) return null;
              const scale = globalScaleRef.current || 1;
              return dash.map((segment) => segment / scale);
            }}
            linkDirectionalArrowLength={(link) => (edgeFamily(link.family).arrow ? LINK_ARROW_LENGTH_PX / (globalScaleRef.current || 1) : 0)}
            linkDirectionalArrowRelPos={LINK_ARROW_REL_POS}
            linkDirectionalArrowColor={(link) => hexToRgba(tintedLinkColorById.get(link.id) ?? edgeFamily(link.family).color, isLinkDimmed(link, focusedNodeType, nodeTypesById) ? DIMMED_ALPHA : LINK_ARROW_ALPHA)}
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
