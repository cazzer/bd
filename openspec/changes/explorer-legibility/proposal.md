## Why

`immersive-explorer-shell` made the canvas the whole window; it did not make a dense result legible. A live screenshot at ~40 drawn nodes (search plus a few expansions) shows five compounding problems:

- **Every node draws its full title**, so titles collide in anything denser than a handful of nodes — `labelPlacement.ts` avoids label-on-label overlap but has no notion of "don't draw this label at all," so a crowded cluster is a wall of overlapping text.
- **`palette.ts` only knows the six openspec/doc node types.** The GitHub ingestor (`packages/core/src/github.ts`, landed after `immersive-explorer-shell`) writes `gh-issue` and `repo` nodes, and both fall back to `FALLBACK_COLOR` — the same grey. Once a store has GitHub content, type colour — the encoding `TypePanel` and the canvas both lean on — stops distinguishing anything for that content.
- **Every node draws an ambient halo** (`AMBIENT_HALO_STOPS`, two concentric low-alpha fills, unconditional). At the density a real search-plus-expansion produces, overlapping halos merge into fog rather than reading as individual glow.
- **One hub node dwarfs its cluster.** `degreeToRadius` scales with `sqrt(degree)` uncapped; a node with an order of magnitude more edges than its neighbours draws large enough to visually dominate the view.
- **The canvas centres on the full viewport, not the free area.** `GraphCanvas` has no awareness of the fixed `w-96` right column (`TypePanel` + `DetailPanel`); force-graph's default centering force centres the layout under the whole window, so a chunk of the result routinely sits half-hidden behind the panels. The detail panel itself opens straight to its full content — editor, annotate, edges, connect — a dense wall for a person who often just wants to know what the node is.

None of this is a retrieval or data problem — every capability this change touches already exists; nothing here is a new fetch or a schema change. It is the same kind of shell-legibility gap `immersive-explorer-shell` closed for layout, now showing up as encoding-density at real corpus size.

## What Changes

- **Labels follow relevance.** A node is labelled only when it's a seed, selected, a direct neighbour of the selection, hovered, or the view is zoomed in past a threshold; other labels stay hidden (full title still available via existing hover tooltip and in the detail panel). Truncated to 40 characters with an ellipsis when shown.
- **Type colours are assigned by store-wide prevalence at load, not hard-coded.** The already-fetched `getStoreSummary().nodeTypes`, sorted by count descending, maps onto the categorical palette in rank order; the fixed openspec/doc lookup table is removed. `App` holds the resulting colour map and threads it to the canvas, `TypePanel`, search chips, and the sr-only node list, so every surface agrees.
- **Hub radius is capped** at roughly 3x the minimum radius; `degreeToRadius` stays monotonic and sqrt-scaled up to the cap, and the node's real degree remains visible in the detail panel's meta row.
- **Halos follow relevance too.** Full ambient+focused halo treatment is reserved for seeds, the selection and its direct neighbours, and type-focused matches; every other node gets at most a single faint ring, not two stacked stops.
- **Fit-to-view respects the panels.** After a search or an expansion, the view fits and centres within the free area left of the right-column panels rather than the full viewport, via a `GraphCanvas` `insetRight` prop `App` derives from which panels are currently open.
- **The detail panel opens as a summary** — title, a meta row (type/source/degree), and the first paragraph of content — with a "Show more" control that expands to today's full panel (editor, annotate, edges, connect). Editing always happens in the expanded state.

## Non-Goals

- **No server changes.** `search`, `getStoreSummary`, and `getNeighbors` already return everything every decision above needs.
- **No light theme, no mobile layout.** Both remain out of scope, unchanged from `immersive-explorer-shell`'s own non-goals.
- **No new density computation per frame.** Halo and label policy are both threshold/relevance checks against state `App` and `GraphCanvas` already hold — never a per-frame clustering or overlap-count pass.
- **`bd-1g2`** ("Canvas labels overlap at ~40-node density and clip under floating panels") **is superseded by this change** — its two suggested options (hide lower-priority labels past a density threshold; keep fit-to-view inset from the panel columns) are exactly decisions 1 and 5 below, generalized (relevance-based hiding, not just a density threshold) and specified properly rather than left as a follow-up note. The orchestrator should close `bd-1g2` once this change lands.

## Capabilities

### Modified Capabilities

- `graph-explorer`: node size is now capped at a maximum radius; labels, halos, and the type control's colours are governed by relevance/prevalence rather than drawn unconditionally or hard-coded; the fitted view accounts for open panels; the detail panel defaults to a summary.

No capability is added or removed — this change, like `immersive-explorer-shell`, is entirely about `graph-explorer`'s presentation requirements.

## Impact

- Changed, `apps/web` only: `src/graph/palette.ts` (rank-based colour assignment replaces the hard-coded type table), `src/graph/encoding.ts` (radius cap), `src/components/GraphCanvas.tsx` (relevance-gated halos and labels, `insetRight`-aware fit), `src/components/TypePanel.tsx` and `src/components/SearchBar.tsx` (consume the shared colour map), `src/App.tsx` (owns the colour map and `insetRight`), `src/components/DetailPanel.tsx` (summary/expanded states).
- New: `src/graph/labelPolicy.ts` (+ test), `src/lib/firstParagraph.ts` (+ test).
- `src/graph/labelPlacement.ts`'s existing collision-avoidance logic is reused unchanged, now applied only to the subset of labels `labelPolicy.ts` decides should be drawn.
- No changes to `packages/core`, `packages/db`, `apps/mcp`, or any tRPC procedure signature. No new dependencies; no schema migration.
