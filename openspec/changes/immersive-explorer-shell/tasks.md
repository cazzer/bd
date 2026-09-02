Order: 1 → 2 → (3, 4, 5) → 6. Groups 3, 4, and 5 all edit `src/App.tsx` (the type panel, the search bar, and the detail panel all live in the same shell component) — they depend on group 2's shell existing, but not on each other's *code*; because they collide in the same file, one implementer works them sequentially rather than three people in parallel. Group 6 depends on all three.

## 1. Dark-first tokens and dark canvas palette

- [x] 1.1 Define `surface`, `surface-elevated`, `fg`, `fg-muted`, `accent`, `hairline` tokens in `src/index.css` via Tailwind v4 `@theme`; set `color-scheme: dark` on the root
- [x] 1.2 Re-tune `CATEGORICAL_PALETTE` in `src/graph/palette.ts` for the dark ground — brighter values, still passing the module's documented CVD/adjacent-pair validation — keeping `colorForNodeType`, `colorForSourceSystem`, `knownNodeTypeColors`, `knownSourceSystemColors`, and `FALLBACK_COLOR`'s contracts unchanged
- [x] 1.3 Set `GraphCanvas.tsx`'s canvas background to the new `surface` token instead of the hardcoded `#ffffff`; move label colour, seed-highlight ring, and badge/edge stroke colours to values legible on the dark ground
- [x] 1.4 Update any test in `palette.test.ts` (or equivalent) that asserts a specific hex to the new values, without loosening what it actually checks (lookup, fallback, distinctness) — none did; `encoding.test.ts`'s colour assertions all call `colorForNodeType`/`colorForSourceSystem` rather than hardcoding hex, so nothing needed changing

## 2. Immersive shell: full-viewport canvas and floating layers

- [x] 2.1 Restructure `App.tsx` so `GraphCanvas` sizes to the viewport as the layout root, with all other controls absolutely positioned over it rather than sharing flex space
- [x] 2.2 Add the shared frosted-panel treatment (`backdrop-blur`, translucent surface, hairline border) and apply `pointer-events-none`/`pointer-events-auto` so empty chrome passes clicks through to the canvas and panels themselves remain interactive
- [x] 2.3 Move the search input and status line into a frosted bar fixed top-center, dropping the title/subtitle block
- [x] 2.4 Add a "New note" button at the search bar's end that opens the existing `CreateNoteForm` in a frosted popover (same `onCreated` contract, new container)
- [x] 2.5 Move `UnlinkedNotes` into a frosted disclosure fixed bottom-left, collapsed by default to a count
- [x] 2.6 Confirm opening/closing the detail panel and toggling the unlinked-notes disclosure never changes the canvas's measured size (matches the new "The map is the page" requirement's scenario) — true by construction (canvas lives in its own `fixed inset-0` layer, wholly independent of the overlay layers' DOM); not re-verified against a running app per this task's own boundary against starting the dev server — group 6's live run still owns that

## 3. Type control with prevalence ranking and canvas type focus

- [x] 3.1 Write `rankNeighborTypes(nodeId, nodes, links)` in `src/graph/typePrevalence.ts` — ranks a selected node's on-screen neighbours' types by count — with tests covering ties, a node with no neighbours, and a neighbour type absent from the palette
- [x] 3.2 Build `TypePanel.tsx` fixed top-right, replacing `GraphLegend.tsx`: default view is the top 8 types store-wide from `getStoreSummary().nodeTypes` with a disclosure for the rest; selected-node view uses `rankNeighborTypes` under an "around `<title>`" header
- [x] 3.3 Keep the edge-source-system swatches as a compact footer in `TypePanel.tsx` so the existing "Edge provenance is visible" requirement stays satisfied
- [x] 3.4 Add canvas-only type focus: clicking a type row dims all non-matching nodes without changing size or position; clicking again clears it; verify it composes with (doesn't clear or get cleared by) the existing seed-relevance highlight — dimming and the seed ring are independent draw-time checks in `GraphCanvas.tsx`'s `drawNode` (both gated on separate conditions, neither reset by the other); not verified against a running app per this task's boundary against starting the dev server
- [x] 3.5 Delete `GraphLegend.tsx` and its imports

## 4. Search matches types: suggestions and chips

- [x] 4.1 Write `matchNodeTypes(typed, nodeTypes)` in `src/lib/typeMatch.ts` — substring match against `node_type` names, ranked by count descending — with tests for empty input, no match, and a tie on count
- [x] 4.2 Add a suggestion dropdown to the search bar driven by `matchNodeTypes` over the same `getStoreSummary().nodeTypes` array `TypePanel` uses
- [x] 4.3 Add removable type chips; submitting the search bar calls `search({ query, nodeTypes: activeChipTypes })`
- [x] 4.4 Show a hint instead of calling `search` when chips are active but the text field is empty, since the server requires non-empty `query`
- [x] 4.5 Wire `TypePanel`'s type-focus click to also add/remove the corresponding chip, so the two entry points into "filter by type" stay consistent

## 5. Detail panel as a floating frosted panel

- [x] 5.1 Restyle `DetailPanel.tsx` from a bordered flex sibling to a frosted floating panel, fixed right below the type control, same `w-96` width
- [x] 5.2 Cap the panel to viewport height with internal scroll, and add an explicit close button (today's only close path is indirect) — capped via the parent flex column's `min-h-0 flex-1` (App.tsx) rather than a literal `max-h-[calc(100dvh-...)]`, since the type-control panel's height above it varies with content and a hardcoded pixel offset would be a guess; internal `overflow-y-auto` unchanged. Added an Escape-to-close handler alongside the pre-existing close button, since the panel is no longer a layout sibling with an implicit boundary.
- [x] 5.3 Confirm content editing, annotation, edge assert/retract/reweight, and the connect form all still function unchanged in the new container — verified by code inspection (no write-path logic touched, only className/shell and the new Escape listener) and `pnpm check`; not exercised against a running app per this task's boundary against starting the dev server

## 6. Verification

- [x] 6.1 Run `pnpm check` (typecheck + tests) clean, including the new `typePrevalence` and `typeMatch` tests
- [x] 6.2 Run the app against the seeded corpus; search, select a node, toggle a type focus, open and close the detail panel, and confirm the canvas never resizes or shifts
- [x] 6.3 Capture a screenshot of the immersive shell (search bar, type panel, an open detail panel, dark canvas) for the design record
- [x] 6.4 Spot-check contrast of panel text against the darkest plausible canvas backdrop beneath it
