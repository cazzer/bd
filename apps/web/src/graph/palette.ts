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
// `source_system` stays a small, genuinely fixed set (packages/core/src/
// seed.ts's SOURCE_SYSTEM, editability.ts's EDITABLE_SOURCE_SYSTEMS) —
// no ingestor has ever added a fourth one, so SOURCE_SYSTEM_COLORS below
// is left as the fixed table it always was; only node_type's assignment
// moved to rank.
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

/** packages/core/src/seed.ts's SOURCE_SYSTEM ("repo") plus editability.ts's EDITABLE_SOURCE_SYSTEMS ("human", "agent"). Fixed, unlike node_type's rank-based assignment above — see module header for why this table stays a table. */
const SOURCE_SYSTEM_COLORS: Readonly<Record<string, string>> = {
  repo: CATEGORICAL_PALETTE[0],
  human: CATEGORICAL_PALETTE[1],
  agent: CATEGORICAL_PALETTE[2],
};

/** Colour for an edge, keyed by `source_system`. Same fallback rule as `colorForNodeType`. */
export function colorForSourceSystem(sourceSystem: string): string {
  return SOURCE_SYSTEM_COLORS[sourceSystem] ?? FALLBACK_COLOR;
}

/** Every (source_system -> colour) pair this module knows, for the legend. */
export function knownSourceSystemColors(): ReadonlyArray<readonly [string, string]> {
  return Object.entries(SOURCE_SYSTEM_COLORS);
}
