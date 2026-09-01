// Categorical colour assignment for the graph canvas (bd-hmd.4, tasks.md
// 4.3/4.4 — "colour nodes by node_type", "colour edges by
// source_system"). Hex values and slot ORDER are the validated default
// categorical palette from Claude's dataviz skill
// (references/palette.md): that fixed order is the colour-vision-
// deficiency safety mechanism (adjacent-pair ΔE ≥ 8 CVD / ≥ 15
// normal-vision, validated by scripts/validate_palette.js), not
// cosmetic — slots are assigned in the documented order and never
// reshuffled or generated on the fly.
//
// `node_type` and `source_system` are both open text by design (design.md:
// "note requires no migration — node_type is open text by existing
// design"; packages/core/src/editability.ts's comment makes the same
// point for source_system: "everything else is presumed file/loader-
// backed"). Below are two *fixed* lookup tables, keyed by the values
// this repo's own loader is known to produce today
// (packages/core/src/corpus.ts's deriveNodeType for node types;
// packages/core/src/seed.ts's SOURCE_SYSTEM plus
// packages/core/src/editability.ts's EDITABLE_SOURCE_SYSTEMS for source
// systems), each with one shared fallback colour for anything else.
//
// Deliberately a fixed map, not a "next free slot" assignment: a type's
// colour must not depend on what else happens to appear in one search
// result, the same stability graph-explorer/spec.md asks of node SIZE
// ("a node is drawn at the same size wherever it appears") — here
// extended to colour, or a node would appear to change category between
// queries with nothing about it having changed.
//
// `node_type` has six known values — more than the three slots
// scripts/validate_palette.js's `--pairs all` gate can clear together
// (a graph canvas shows every category simultaneously, like a scatter
// plot, not merely adjacent-in-a-stack). Run against all six
// (2026-09-01): adjacent-pair checks (the gate for stacks/bars/lines)
// pass; the `--pairs all` gate fails as documented (worst CVD pair
// #008300<->#eb6834 ΔE 3.2 protan, worst normal-vision pair
// #e87ba4<->#eb6834 ΔE 12.9) — the palette doc's own escape valve is
// "legal ONLY with secondary encoding: direct labels ... or texture".
// `source_system` has three known values, inside the three-slot cap,
// and passes `--pairs all` outright — no secondary encoding needed
// there.
//
// COUPLING (bd-hmd.4 follow-up review — read this before touching
// either module): the node_type mitigation above is NOT "every node is
// always labelled." graph/labelPlacement.ts hides a label when its node
// is crowded and not a seed/hovered — the fix for labels overlapping in
// the corpus's densest cluster, which unconditional per-node labels
// caused. A hidden-label node's type is still one hover away
// (graph/tooltip.ts's tooltip always states node_type/source_system as
// text), but hover-only identity is weaker than an always-visible
// label — it requires the person to act, not just look, so the
// mitigation is now conditional rather than universal. Two things keep
// it honest rather than quietly regressing: (1) `labelPlacement.ts`
// marks every seed node's label `alwaysShow` — the CVD-hardest pairs
// above are exactly the pairs a person is most likely staring at right
// after a search, and those never lose their label; (2) if hidden
// labels turn out to strand real confusion at higher density (more
// likely once bd-hmd.5 adds expansion), the next lever is biasing
// `labelPlacement.ts`'s `priority` by colour-confusability instead of
// raw degree — not implemented now; degree already tracks "the node
// most worth a persistent label" well enough for this corpus, and
// doing more than that without evidence of an actual problem would be
// solving a problem this ticket hasn't observed.
export const CATEGORICAL_PALETTE = [
  "#2a78d6", // 1 blue
  "#eb6834", // 2 orange
  "#1baf7a", // 3 aqua
  "#eda100", // 4 yellow
  "#e87ba4", // 5 magenta
  "#008300", // 6 green
  "#4a3aa7", // 7 violet — reserved, unused by either table below today
  "#e34948", // 8 red — reserved, unused by either table below today
] as const;

/**
 * Colour for anything not in a table below. Deliberately OUTSIDE the
 * categorical set above — `scripts/validate_palette.js` confirms it
 * fails that palette's own chroma floor ("reads gray"), which is exactly
 * the point: an unrecognised type must read as "uncategorized," never
 * coincidentally collide with a real category's hue.
 */
export const FALLBACK_COLOR = "#8a8886";

/** packages/core/src/corpus.ts's deriveNodeType — the six node_type values this repo's loader produces. */
const NODE_TYPE_COLORS: Readonly<Record<string, string>> = {
  doc: CATEGORICAL_PALETTE[0],
  "openspec-spec": CATEGORICAL_PALETTE[1],
  "openspec-proposal": CATEGORICAL_PALETTE[2],
  "openspec-design": CATEGORICAL_PALETTE[3],
  "openspec-tasks": CATEGORICAL_PALETTE[4],
  "openspec-readme": CATEGORICAL_PALETTE[5],
};

/** packages/core/src/seed.ts's SOURCE_SYSTEM ("repo") plus editability.ts's EDITABLE_SOURCE_SYSTEMS ("human", "agent"). */
const SOURCE_SYSTEM_COLORS: Readonly<Record<string, string>> = {
  repo: CATEGORICAL_PALETTE[0],
  human: CATEGORICAL_PALETTE[1],
  agent: CATEGORICAL_PALETTE[2],
};

/** Fill colour for a node, keyed by `node_type`. Unknown types get `FALLBACK_COLOR` — never a crash, never an arbitrary per-render assignment. */
export function colorForNodeType(nodeType: string): string {
  return NODE_TYPE_COLORS[nodeType] ?? FALLBACK_COLOR;
}

/** Colour for an edge, keyed by `source_system`. Same fallback rule as `colorForNodeType`. */
export function colorForSourceSystem(sourceSystem: string): string {
  return SOURCE_SYSTEM_COLORS[sourceSystem] ?? FALLBACK_COLOR;
}

/** Every (node_type -> colour) pair this module knows, for the legend — insertion order is the palette's fixed order. */
export function knownNodeTypeColors(): ReadonlyArray<readonly [string, string]> {
  return Object.entries(NODE_TYPE_COLORS);
}

/** Every (source_system -> colour) pair this module knows, for the legend. */
export function knownSourceSystemColors(): ReadonlyArray<readonly [string, string]> {
  return Object.entries(SOURCE_SYSTEM_COLORS);
}
