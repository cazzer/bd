## Context

`immersive-explorer-shell` (archived at commit `7068047`) made the canvas full-viewport and every control a floating overlay — layout was the problem it solved. This change is a legibility pass on top of that shell, at the density a real session actually reaches: a live screenshot with ~40 drawn nodes (one search plus a few expansions) showed labels colliding, `gh-issue`/`repo` nodes (from the GitHub ingestor, landed after `immersive-explorer-shell`) both reading as the same fallback grey because `palette.ts` only maps the six openspec/doc `node_type` values, ambient halos merging into fog, one hub node visually swamping its cluster, the fitted view sitting half under the fixed right-column panels, and the detail panel opening straight to its densest state.

`bd-1g2` ("Canvas labels overlap at ~40-node density and clip under floating panels"), filed during `immersive-explorer-shell`'s own live review, named two of these symptoms and sketched two fixes: "hide lower-priority labels past a density threshold" and "keep the canvas fit-to-view inset from the panel columns." This change supersedes it — decision 1 below generalizes the label fix from a density threshold to relevance (a node's role in the current query, not just how crowded its neighbourhood is), and decision 5 is exactly the fit-to-view inset, specified as a real requirement rather than left as an open follow-up.

Every decision here reads existing state or existing fetches (`getStoreSummary().nodeTypes`, the drawn `graph.nodes`/`graph.links`, the already-computed `globalScale` force-graph passes to `nodeCanvasObject`) — no new tRPC call, no new server capability, no schema change.

## Goals / Non-Goals

**Goals:**

- A dense result (~40+ nodes) reads as a legible graph, not a wall of overlapping text and merged halos.
- Type colour distinguishes every type actually present in the store, including types added after this UI was first built, without a code change per new type.
- One hub node no longer visually dominates its cluster, while its actual degree stays discoverable.
- The fitted view lands in the space a person can actually see it, not partly behind a panel.
- Opening a node's detail defaults to "what is this," not "every tool this panel has."

**Non-Goals:**

- No retrieval, storage, or tRPC contract change — this is presentation only, like `immersive-explorer-shell` before it.
- No per-frame density computation (counting overlaps, clustering) — every policy here is a threshold or relevance check against state already held.
- No light theme, no mobile/narrow-viewport layout — both remain out of scope, unchanged from the prior change.
- No new mechanism for distinguishing expansion-loaded nodes from search results (`bd-ab9`) — unrelated to this change.

## Decisions

### 1. Labels follow relevance

A node's label is drawn only when the node is a seed of the current query, the selected node, a direct neighbour of the selected node, or currently hovered; every other label is withheld unless the view is zoomed in past a threshold on `globalScale` (the value force-graph already passes into `nodeCanvasObject` and `onRenderFramePre`), threshold ≈ 1.6. A drawn label is truncated to 40 characters with an ellipsis; the full title remains available through the existing hover tooltip (`graph/tooltip.ts`) and in the detail panel.

Policy — "is this node's label eligible, and what's the truncated text" — is a pure function in a new `src/graph/labelPolicy.ts`, tested directly (seed/selected/neighbour/hovered eligible at any zoom; ambient node eligible only above the zoom threshold; truncation at exactly 40 and below it). `GraphCanvas.tsx`'s existing collision-avoidance pass (`labelPlacement.ts`'s `placeLabels`) is unchanged and still runs — but now only over the subset of candidates `labelPolicy.ts` decided should be drawn at all, rather than every node in the view. This keeps the two concerns separate exactly the way `encoding.ts`/`GraphCanvas.tsx` already separate "what to draw" from "how to draw it": `labelPolicy.ts` decides *whether* a label exists this frame, `labelPlacement.ts` still decides *where* it goes among the labels that do.

*Why relevance, not `bd-1g2`'s density threshold:* a density threshold hides labels only once a neighbourhood is crowded, which is exactly the moment a person most wants to know what a node they're looking at actually is. Relevance answers "is this node part of what I'm looking at right now" directly — a seed or the selected node's neighbourhood stays labelled at any density, while an ambient node ten hops from anything relevant stays quiet even in a sparse view, until zooming in signals the person wants to read that area specifically.

### 2. Type colours are assigned by store-wide rank at load, not hard-coded

`getStoreSummary().nodeTypes` — already fetched today for `TypePanel`'s default view and the search bar's type suggestions — is sorted by count descending and mapped onto `palette.ts`'s existing `CATEGORICAL_PALETTE` in rank order: the most common type in the store gets slot 0, the second-most-common gets slot 1, and so on. A type past the palette's length gets `FALLBACK_COLOR`, same as today. This is a pure function, `assignTypeColors(rankedTypes: NodeTypeCount[]): Map<string, string>`, in `src/graph/palette.ts`, tested directly (empty store, fewer types than palette slots, more types than palette slots, a tie in count). The existing fixed `NODE_TYPE_COLORS` lookup table — the six-entry openspec/doc map that leaves `gh-issue`/`repo` grey today — is removed; `colorForNodeType` becomes a lookup into the assigned map (with the same fallback contract) rather than the old static table.

The resulting `Map<string, string>` is computed once in `App` alongside the existing `nodeTypeCounts` state (same effect, same fetch) and passed down to `GraphCanvas`, `TypePanel`, the search bar's chip swatches, and the sr-only node list — every surface that shows a type colour reads the same map, so a person never sees the canvas and the type panel disagree about what colour a type is.

*Stability:* rank by store-wide count is stable within a session — the map is recomputed only when `getStoreSummary` is re-fetched (today: on load and after a write that could change counts, same as `nodeTypeCounts` already does). A newly-appearing type can only ever push existing types to a lower rank, never reassign a type already at rank *k* to a different rank unless something above it in count changes — the same "wherever it appears" stability `graph-explorer/spec.md` already asks of node size, now extended to colour by rank rather than by hard-coded identity.

*Why rank over the store's own types rather than a bigger hard-coded table:* the ingestor set that writes into this store is not fixed — the GitHub ingestor is the second one, after the openspec loader, and nothing says it's the last. A fixed table requires a code change (and a `palette.ts` re-validation against the CVD gate) every time a new ingestor ships a new `node_type`; rank-by-prevalence needs none, because it reads a value (`getStoreSummary().nodeTypes`) that's already correct for whatever the store currently holds.

### 3. Hub radius is capped

`degreeToRadius` (`src/graph/encoding.ts`) keeps its existing `NODE_RADIUS_SCALE * sqrt(degree)` shape but adds a ceiling, `NODE_RADIUS_MAX`, at roughly 3x `NODE_RADIUS_MIN` — the same "about a factor of three, not ten" language the existing spec requirement already uses for a 10x-degree hub, now enforced as an actual cap rather than left as an emergent property of sqrt scaling that a large enough degree spread can still blow past. Radius stays monotonic in degree and identical across views up to the cap; a node past the cap draws at the same radius as any other node past the cap, and its real, uncapped degree remains visible in the detail panel's meta row (`degree` is already threaded there unchanged).

This MODIFIES the existing "Node size encodes connectedness" requirement rather than adding a new one — the requirement's shape (sqrt scaling, store-wide degree, stability across views) is unchanged; only the ceiling is new.

### 4. Halos follow relevance too

The existing halo mechanism (`AMBIENT_HALO_STOPS` / `FOCUSED_HALO_STOPS`, `drawHalo` in `GraphCanvas.tsx`) is unconditional today — every node gets the two-stop ambient halo regardless of relevance, which is what turns a dense cluster into fog. This change gates the full treatment the same way label eligibility is gated in decision 1: a seed, the selected node, its direct neighbours, and a type-focus match get their existing halo (ambient or focused stops, unchanged shape and cost — still two `ctx.arc`+`ctx.fill` calls, no new per-frame allocation). Every other node gets at most a single, fainter ring — one stop, not two — so an ambient cluster still reads as "there is more graph here" without the stacked-fill fog the screenshot showed.

This reuses the same relevance categories decision 1 already establishes (seed / selected / neighbour / type-focus match) rather than inventing a second classification — a node's "is this relevant right now" answer is computed once per frame and read by both the label and halo draw paths.

### 5. Fit-to-view respects the panels

`GraphCanvas` gains an `insetRight` (px) prop that `App` derives from which right-column panels are currently open (`TypePanel` is always open; `DetailPanel` adds its own `w-96` when a node is selected) — the same width arithmetic `App.tsx` already owns for that column's layout, just also handed to the canvas. After a search settles, the view is fit and centred within the free area to the left of that inset rather than the full viewport: the fit's target centre is shifted left by half the inset in screen space, so the drawn neighbourhood lands where a person can actually see all of it rather than half-hidden behind the type or detail panel. Expansion never re-fits: an expanded node's new neighbours enter near their parent (the existing "Expansion preserves the existing layout" requirement), and the person can pan to them — an earlier implementation also fit on every settled expansion, but the settle signal fires whether or not the fetch actually added anything, so the very first click on any node re-centred and re-scaled the whole view, which review caught as a regression, not a feature.

*Why a prop, not the canvas reading the DOM:* `App` already owns exactly which panels are open (`selectedNodeId`, the type panel's fixed presence) — that's the same state that decides the column's rendered width today. Handing `GraphCanvas` a number keeps it a pure function of props, consistent with how it already receives `data`, `focusedNodeType`, and `expandableNodeIds`, rather than adding a `ResizeObserver`/DOM-measurement dependency for a value the parent can compute directly.

### 6. Detail panel opens as a summary

`DetailPanel` gains a summary state: title, a meta row (type / source system / degree — same fields already shown today, reordered to the top), and the first paragraph of the node's content, at `w-80` (narrower than today's `w-96`, since a summary needs less width than an editor). A pure helper, `firstParagraph(markdown: string): string`, in a new `src/lib/firstParagraph.ts` (tested: single paragraph, multiple paragraphs, leading blank lines, a document with no paragraph break at all), extracts the excerpt without depending on the markdown renderer. A "Show more" control expands to today's full panel — content/editor, annotate, edges, connect — at `w-96`; collapsing returns to the summary. Editing (`ContentSection`'s edit affordance) is only reachable from the expanded state; opening a node for editing therefore requires one extra click ("Show more") beyond today, which is the trade this decision makes deliberately — most opens are "what is this," not "let me edit it."

## Risks / Trade-offs

- **Relevance-gated labels could hide the label on a node someone genuinely wants to read at a glance, in a sparse-but-unzoomed view.** Mitigated by the zoom-threshold fallback (decision 1) and by hover/click always being one gesture away from the full title — the same mitigation `labelPlacement.ts`'s own header already documents for its own hidden-label case (hover-only identity is weaker than an always-on label, but never gone entirely).
- **Rank-based type colour means a type's colour can shift between sessions if the store's count ordering changes** (e.g., a large GitHub ingest pushes `gh-issue` above `openspec-proposal`). Accepted: decision 2's stability claim is explicitly *within* a session, not permanent identity — the alternative (a fixed table) is the exact problem this change removes (a hard-coded list that silently stops covering new ingestors), and re-ranking to reflect what's actually in the store is preferable to a stale colour built for a store that no longer looks like that.
- **The radius cap and the halo/label relevance gating both reduce visual differentiation among high-degree or ambient nodes** — a capped hub and a merely-large node can draw at the same radius; a dimmed ambient halo carries less information than today's uniform one. Accepted as the direct trade this change is making: legibility at density over maximal per-node information density, matching the screenshot's own complaint that today's full-information rendering has become illegible past ~40 nodes. The detail panel's meta row (uncapped real degree) is the mitigation for the one case (hub size) where the lost information is something a person might actually need.
- **`insetRight`-aware fitting adds a second thing (panel state, not just search state) that can trigger a re-fit.** Scoped tightly: only a search result landing triggers a fit, and only the *target* of that fit reads `insetRight` — opening or closing a panel on its own, or expanding a node, with no new search, does not re-fit or move the already-drawn graph. This keeps `immersive-explorer-shell`'s "opening detail does not resize the canvas" requirement intact: the canvas's own size is still untouched by any panel; only where a *future* fit centres itself changes.

## Migration Plan

Additive/replacing within `apps/web` only — no schema, no server, no `apps/mcp` change, same shape as `immersive-explorer-shell`'s own migration plan. `palette.ts`'s hard-coded `NODE_TYPE_COLORS` table is deleted and replaced by `assignTypeColors`'s output in the same change; every caller of `colorForNodeType` is updated to go through the new lookup, so there is no window where two colour sources disagree. Rollback is reverting the `apps/web` commit; no data or migration to unwind. `bd-1g2` is closed by the orchestrator once this change lands, per the proposal's Non-Goals.

## Open Questions

None — all six decisions above are settled; nothing here is deferred to implementation-time judgment beyond ordinary code review.
