// Categorical colour assignment for the graph canvas (bd-hmd.4, tasks.md
// 4.3/4.4 — "colour nodes by node_type", "colour edges by
// source_system"; rank-based node_type assignment: bd-4ye,
// openspec/changes/explorer-legibility/design.md decision 2). Hex
// values and slot ORDER are the validated default categorical palette
// from Claude's dataviz skill (references/palette.md): that fixed order
// is the colour-vision-deficiency safety mechanism (adjacent-pair ΔE ≥ 8
// CVD / ≥ 15 normal-vision, validated by scripts/validate_palette.js),
// not cosmetic — slots are assigned in the documented order and never
// reshuffled or generated on the fly.
//
// `node_type` is open text by design (packages/core/src/corpus.ts's
// deriveNodeType, plus the GitHub ingestor landed after this app's first
// palette — gh-issue/repo — is proof new node_types keep arriving from
// new ingestors). A FIXED lookup table therefore goes stale the moment a
// new ingestor ships a node_type nobody added a row for — exactly what
// happened to gh-issue/repo before bd-4ye (both fell through to
// FALLBACK_COLOR, indistinguishable from "uncategorized"). Node type
// colour is assigned instead by RANK: `assignTypeColors` takes an
// already store-wide-count-ranked list of type names (App.tsx derives
// this from `getStoreSummary().nodeTypes`, most prevalent first — see
// graph/typePrevalence.ts's `topStoreTypes`) and maps rank index i onto
// `CATEGORICAL_PALETTE[i]` in order, so the most common type in the
// store always gets slot 0, the second-most-common gets slot 1, and so
// on — no code change needed when a new ingestor's node_type shows up,
// because this function reads whatever the store currently holds rather
// than a table someone has to remember to update.
//
// Stability is explicitly SESSION-scoped, not permanent identity: two
// different sessions (or the same session before/after a large ingest
// that reorders store-wide counts) can assign a given type a different
// colour. Accepted per design.md's own Risk section — re-ranking to
// reflect what's actually in the store beats a stale colour built for a
// store that no longer looks like that, and is preferable to the
// alternative (a fixed table) this replaces, which is the exact "silently
// stops covering new ingestors" problem being removed. Within one
// session, the map is only ever recomputed when `getStoreSummary` is
// re-fetched (App.tsx: on load, and after a write that could add a new
// node_type) — the same cadence `nodeTypeCounts` state already follows.
//
// `source_system` is no longer a colour at all (bd-o1e) — the reasoning
// this comment used to carry, that it was "a small, genuinely fixed set",
// was true of `repo`/`human`/`agent` and false of the loaders that
// actually write edges. See the note where that table used to live.
//
// CATEGORICAL_PALETTE has 8 slots; validated (2026-09-01, dark-ground
// re-tune — bd-ktj) against this module's own --color-ground surface
// (`#070b14`, index.css): adjacent-pair checks (the gate for
// stacks/bars/lines) pass; the stricter `--pairs all` gate (every
// category visible simultaneously, as a graph canvas does) fails once
// more than ~3 types are assigned at once (worst CVD pair #d55181<->
// #199e70 ΔE 1.6 deutan, worst normal-vision pair #c98500<->#d95926 ΔE
// 10.6) — legal only with the palette doc's own escape valve, a
// secondary encoding, which this app already has: every node carries a
// text label (GraphCanvas.tsx/labelPlacement.ts) whenever bd-cfc's label
// policy (graph/labelPolicy.ts) draws one, and a screen-reader user gets
// type as text unconditionally via the sr-only node list
// (accessibility.ts's nodeAccessibleDescription) regardless of what's
// drawn on canvas.
//
// COUPLING (bd-hmd.4 follow-up review, still true after bd-4ye's rank
// change — read this before touching either module): the mitigation
// above is NOT "every node is always labelled." graph/labelPolicy.ts
// (bd-cfc) withholds a label from a node that isn't a seed, the
// selection, a neighbour of the selection, or hovered, unless the view
// is zoomed in past a threshold — a hidden-label node's type is still
// one hover away (graph/tooltip.ts's tooltip always states
// node_type/source_system as text), but hover-only identity is weaker
// than an always-visible label, so the mitigation stays conditional, not
// universal — see labelPolicy.ts's own header for the current, honest
// version of that claim.
export const CATEGORICAL_PALETTE = [
  "#3987e5", // 1 blue
  "#d95926", // 2 orange
  "#199e70", // 3 aqua
  "#c98500", // 4 yellow
  "#d55181", // 5 magenta
  "#008300", // 6 green
  "#9085e9", // 7 violet
  "#e66767", // 8 red
] as const;

/**
 * Colour for a type ranked past `CATEGORICAL_PALETTE`'s length.
 * Deliberately OUTSIDE the categorical set above — `scripts/
 * validate_palette.js` confirms it fails that palette's own chroma floor
 * ("reads gray"), which is exactly the point: a type past the palette's
 * length must read as "uncategorized," never coincidentally collide with
 * a real category's hue. Slate-500 rather than the light-mode fallback's
 * warm gray (`#8a8886`, too dark to read against the dark ground) —
 * still clears the surface's 3:1 contrast floor.
 */
export const FALLBACK_COLOR = "#64748b";

/**
 * Assigns each of `rankedTypes` a colour by its position in the array —
 * index 0 (the most prevalent type store-wide) gets
 * `CATEGORICAL_PALETTE[0]`, and so on; an index past the palette's
 * length gets `FALLBACK_COLOR`. Pure and order-only: the CALLER is what
 * turns `getStoreSummary().nodeTypes` into a ranked, deduplicated list of
 * type NAMES (count desc, name-asc tie-break — graph/typePrevalence.ts's
 * `topStoreTypes`/`sortByCountThenName`) before calling this, so this
 * function's whole contract is "index i gets palette slot i" — it never
 * itself reads a count or breaks a tie.
 *
 * Computed once in App.tsx alongside the existing `nodeTypeCounts` state
 * (design.md decision 2) and passed down to every surface that shows a
 * type colour — GraphCanvas, TypePanel, SearchBar's chip/suggestion
 * swatches — so none of them can disagree about what colour a type is.
 */
export function assignTypeColors(rankedTypes: readonly string[]): Map<string, string> {
  const colors = new Map<string, string>();
  rankedTypes.forEach((nodeType, rank) => {
    colors.set(nodeType, CATEGORICAL_PALETTE[rank] ?? FALLBACK_COLOR);
  });
  return colors;
}

/**
 * Fill colour for a node, keyed by `node_type`, looked up in `colors` —
 * the SAME map every caller got from `assignTypeColors`, per this
 * module's header. A type absent from `colors` (never ranked — e.g. the
 * store summary hasn't loaded yet) gets `FALLBACK_COLOR`, never a crash,
 * never an arbitrary per-render assignment.
 */
export function colorForNodeType(nodeType: string, colors: ReadonlyMap<string, string>): string {
  return colors.get(nodeType) ?? FALLBACK_COLOR;
}

// `SOURCE_SYSTEM_COLORS`, `colorForSourceSystem` and
// `knownSourceSystemColors` lived here until bd-o1e removed them. They
// mapped `repo`/`human`/`agent` onto palette entries and decided an
// edge's drawn colour. The premise was wrong in practice: those three
// name 39 of the store's 1750 nodes and essentially none of its 3248
// edges, which come from `git` (838), `github` (791) and `beads` (82) —
// so every edge in a real search resolved to `FALLBACK_COLOR` while
// TypePanel's footer advertised three colours present on no edge.
//
// Source system did not stop mattering; it stopped being a COLOUR.
// graph/edgeLegend.ts reports it as a composition count, which states
// "every edge here came from one loader" more directly than a uniform
// colour ever implied it. The channel it vacated went to the relation
// families below.

// --- Edge relation families (readable-graph-and-timeline, bd-o1e,
// design.md decision 1) ----------------------------------------------------
//
// What replaced `colorForSourceSystem` as the channel an edge is DRAWN
// from. The old encoding spent edge colour on source system against a
// table that knew `repo`/`human`/`agent` while the store's edges are
// `git` (838), `github` (791) and `beads` (82) — so every edge in a real
// search drew `FALLBACK_COLOR` and the legend advertised three colours
// present on no edge. Meanwhile `edgeType`, which is what the typed-edge
// architecture exists to express, was reachable only by hovering.
//
// Why dash + arrowhead rather than colour-by-edgeType (the obvious
// reading of that finding, and the one this change deliberately did not
// take): `assignTypeColors` above already spends eight saturated hues on
// NODE types. A second categorical hue scale on edges puts two colour
// legends in one picture, and a blue line beside a blue node then encodes
// nothing shared. Dash pattern and arrowhead are channels nothing else
// uses, and they read at the low stroke weights edges are drawn at.
// Family strokes are therefore deliberately LOW-CHROMA — they must not
// compete with the node palette for the reader's colour attention.
//
// Why families rather than one style per edge type: `edge_type` is open
// text (the same reason `node_type` is — a new relation must never need a
// migration). Nine types exist today; a family table with a defined
// fallback admits a tenth without a design change, a per-type table does
// not. `sibling` is deliberately left out: it is one edge in the whole
// store and it is not in design.md's table, so it exercises the fallback
// rather than being quietly assigned a home it was never designed one for.

export type EdgeFamilyKey = "containment" | "dependency" | "reference" | "configuration" | "unassigned";

export interface EdgeFamily {
  key: EdgeFamilyKey;
  /** Shown in the legend — names the relation, not the mechanism. */
  label: string;
  /** `#rrggbb`; low-chroma by design (see this section's header). */
  color: string;
  /**
   * Dash lengths in SCREEN pixels. GraphCanvas divides these by
   * `globalScale` before `setLineDash`, the same idiom `LABEL_FONT_SIZE_PX`
   * and `EXPANDABLE_BADGE_RADIUS_PX` already use, so a dash holds its
   * appearance as the canvas zooms. Empty means solid.
   */
  dash: readonly number[];
  /** Whether direction is drawn. Source → target, always. */
  arrow: boolean;
  /** Multiplies the weight-derived width, so a structural relation can read lighter than a dependency. */
  widthScale: number;
}

const EDGE_FAMILIES: Readonly<Record<EdgeFamilyKey, EdgeFamily>> = {
  containment: { key: "containment", label: "contains", color: "#8fa3bd", dash: [], arrow: true, widthScale: 1 },
  dependency: { key: "dependency", label: "depends", color: "#c2917f", dash: [6, 4], arrow: true, widthScale: 1.2 },
  reference: { key: "reference", label: "refers", color: "#8a93a6", dash: [1.5, 3], arrow: false, widthScale: 0.85 },
  configuration: { key: "configuration", label: "configures", color: "#9d93b8", dash: [], arrow: true, widthScale: 0.7 },
  unassigned: { key: "unassigned", label: "other", color: "#6b7280", dash: [1, 5], arrow: false, widthScale: 0.85 },
};

/**
 * The assignment itself. Source → target reads as: a `child_of` edge
 * points from the child TO its container, which is the direction both
 * `child_of` and `belongs-to` are already stored in (see the git and
 * GitHub loaders), so the arrowhead needs no per-type reversal.
 */
const FAMILY_BY_EDGE_TYPE: Readonly<Record<string, EdgeFamilyKey>> = {
  child_of: "containment",
  "belongs-to": "containment",
  "part-of-change": "containment",
  blocks: "dependency",
  closes: "dependency",
  mentions: "reference",
  touches: "reference",
  default_view: "configuration",
};

/** Never throws and never returns undefined — an unrecognised relation gets the reserved `unassigned` styling rather than vanishing. */
export function familyKeyForEdgeType(edgeType: string): EdgeFamilyKey {
  return FAMILY_BY_EDGE_TYPE[edgeType] ?? "unassigned";
}

export function edgeFamily(key: EdgeFamilyKey): EdgeFamily {
  return EDGE_FAMILIES[key];
}

export function familyForEdgeType(edgeType: string): EdgeFamily {
  return EDGE_FAMILIES[familyKeyForEdgeType(edgeType)];
}

/** Every family, in the order the legend lists them. */
export function knownEdgeFamilies(): readonly EdgeFamily[] {
  return [EDGE_FAMILIES.containment, EDGE_FAMILIES.dependency, EDGE_FAMILIES.reference, EDGE_FAMILIES.configuration, EDGE_FAMILIES.unassigned];
}
