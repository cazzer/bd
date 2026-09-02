## Context

`add-visual-layer` shipped the explorer's substance: search, a progressively-loading force-directed graph, expansion, editing, annotation, hand edges. This change is a shell rewrite around that substance — no capability in `local-web-api`, `knowledge-store`, or `retrieval` is touched, and `apps/mcp` is untouched.

Current layout (`src/App.tsx`, ~330 lines): a flex column — a header block (title, search form, status line, create-note/unlinked-notes row) above a bordered flex row containing `GraphCanvas` + `GraphLegend` (a column) and, when `selectedNodeId` is set, `DetailPanel` as a `w-96` sibling that pushes the canvas narrower. `src/components/GraphLegend.tsx` is a display-only strip of hardcoded swatches from `palette.ts`, unrelated to what's actually selected or drawn. `src/index.css` is one line (`@import "tailwindcss";`) — no tokens, no dark mode, no `dark:` usage anywhere in the app. The server (`apps/web/server/routers/read.ts`) already accepts `nodeTypes`/`sourceSystems`/`edgeTypes` filters on `search` and already returns `nodeTypes`/`sourceSystems`/`edgeTypes` count arrays (`{ nodeType, count }[]`) from `getStoreSummary` — both unused by the UI today. This change is what starts using them.

## Goals / Non-Goals

**Goals:**

- The drawn graph occupies the full viewport at all times; no control's presence or absence changes its size.
- Every control reads as floating over a map, not as a page section: frosted surface, hairline border, pointer events passing through empty space to the canvas beneath.
- The type control makes "what's around this node" legible without a new fetch — it reads the graph already on screen.
- Dark becomes the only presentation, deliberately, with tokens shaped so a light variant is additive later rather than a rewrite.

**Non-Goals:**

- Touching retrieval, storage, or any tRPC procedure's contract.
- Building a light theme now, or a mobile/narrow-viewport layout.
- Changing what expansion, editing, annotation, or edge-assertion *do* — only where their triggers live on screen.

## Decisions

### The map is the page

`GraphCanvas` sizes to the viewport (not a flex-constrained pane), and every other control — search bar, type panel, detail panel, note popover, unlinked-notes disclosure — is a positioned overlay on top of it: `backdrop-blur`, a translucent surface colour, a hairline border. Pointer events pass through to the canvas everywhere except the panels themselves (`pointer-events-none` on wrapping layout elements, re-enabled per panel).

This is a hard reversal of the current structure, where the canvas is the thing that gets squeezed (by the header above it, by `DetailPanel` beside it). Making the canvas the layout root and everything else absolutely-positioned over it is what makes "opening detail doesn't resize the canvas" true by construction rather than by a size that happens not to change today.

### Dark-first, dark-only for now

Tokens (`surface`, `surface-elevated`, `fg`, `fg-muted`, `accent`, `hairline`) are defined once in `src/index.css` via Tailwind v4's `@theme`, and the root element sets `color-scheme: dark`. No light variant is built — the token layer exists so one could be added later without restructuring every component, not because a toggle is planned now.

The canvas background is set to match the page ground (deep near-black navy) rather than staying `#ffffff` (`GraphCanvas.tsx` today hardcodes white for both the fill and the stroke context calls) — a white canvas floating inside a dark page would read as a hole in the design, not a surface.

`palette.ts`'s `CATEGORICAL_PALETTE` is re-tuned for the dark ground: brighter values, still mutually distinct and CVD-safe per the dataviz skill's validator, still passing the module's own documented adjacent-pair gate. `colorForNodeType`, `colorForSourceSystem`, `knownNodeTypeColors`, `knownSourceSystemColors`, and `FALLBACK_COLOR`'s role (outside the categorical set, reads as "uncategorized") are unchanged in shape — only the hex values move. Tests in `palette.test.ts` (if any assert specific hexes) get updated values; their contracts — lookup by key, fallback for unknown keys, mutual distinctness — must still hold. Node labels move to a light colour for contrast against the dark fill; the seed-highlight ring moves to a light accent; badge/edge strokes that were dark-on-white move to whatever reads on the new ground.

*Alternative rejected:* a `dark:` variant alongside the existing light styles. Rejected because there is no light mode left to vary from — the request is to flip the default, not to add a second mode to an existing one. Building a `dark:`-prefixed system for a single supported theme is pure overhead; the token layer already gives a future light mode a clean seam without paying for one now.

### Search bar: minimal, and it searches types too

The header's title/status block collapses into a single frosted bar, top-center: one text input and a compact status line beneath it (idle / loading / error / result-count, same states `App.tsx` already tracks). A "New note" button sits at the bar's end and opens `CreateNoteForm` in a popover instead of inline — the form's own contract (`onCreated`) is unchanged, only its container.

Search now matches types as well as node content. As the person types, a small dropdown lists `node_type` values (from `getStoreSummary().nodeTypes`, already fetched for the type panel — see below) whose name contains the typed substring, ranked by count descending. This matching is a pure function, `matchNodeTypes(typed: string, nodeTypes: NodeTypeCount[]): NodeTypeCount[]`, in `src/lib/typeMatch.ts`, tested directly rather than through the dropdown component. Choosing a suggestion adds a **type chip** to the bar and clears the typed substring; chips are individually removable. Submitting runs `search({ query, nodeTypes: activeChipTypes })` — chips alone, with the text field empty, cannot search, because the server's `search` procedure requires `query` to be at least one character; the bar shows a hint ("add search text") rather than attempting the call.

*Why a substring match on already-fetched types, not a new endpoint:* the store has at most a handful of `node_type` values (six, per `palette.ts`'s own count today) — no pagination or server-side ranking is warranted for a list that size, and `getStoreSummary` is already the type panel's data source, so the dropdown reuses that same in-memory array rather than adding a request.

### Type control: ranked by prevalence, defaults to top types, drives a canvas focus

`GraphLegend.tsx` is replaced by `TypePanel.tsx`, a frosted control fixed top-right. It always shows a ranked list — swatch, type name, count — and a compact footer of edge-source-system swatches (this is what keeps `graph-explorer`'s existing "Edge provenance is visible" requirement satisfied; nothing about that requirement's scenarios changes).

- **No node selected:** the top 8 types store-wide by count, from `getStoreSummary().nodeTypes` sorted descending, with a disclosure to expand to the full list.
- **A node selected:** the header reads "around `<title>`", and the list ranks the node types of that node's neighbours **on the currently drawn graph** — derived from `graph.links`/`graph.nodes` already in state, not a new fetch — by how many of those neighbours carry each type.

Ranking is a pure function, `rankNeighborTypes(nodeId, nodes, links): { nodeType: string; count: number }[]`, in `src/graph/typePrevalence.ts`, tested directly against constructed graphs (ties, a node with no neighbours, a neighbour whose type is absent from the palette).

Clicking a type row toggles **type focus**: matching nodes render at full strength, everything else dims. This is transient canvas state — comparable to the existing query-relevance highlight — never a change to layout, size, or the underlying `GraphCanvasData`. Clicking the same row again clears it. Choosing a type this way also adds it as a search chip (one mechanism for "filter by this type," reachable from either the search bar's own suggestions or the type panel), consistent with the "search also matches types" decision above.

*Why derive from the drawn graph rather than fetching store-wide neighbour types:* the whole point of "around `<title>`" is what's actually on screen, mirroring how a person reads the graph itself — a store-wide neighbour-type count would answer a different, more expensive question nobody asked. It also keeps this control's data cost at zero additional requests, matching `add-visual-layer`'s degree decision ("computed for the returned node set, not fetched separately").

### Detail panel: same behaviour, now floating

`DetailPanel` keeps every behaviour `add-visual-layer` gave it — content, edit, annotate, edges, connect — and moves from a bordered flex sibling to a frosted floating panel, fixed on the right below the type control, same `w-96` width, now capped to viewport height with its own internal scroll (so a long edge list can't push the panel off-screen) and an explicit close button (today's close is only the click-away-from-`selectedNodeId` path via the graph or a new search; the panel becoming an overlay makes a discoverable close affordance necessary). Its data flow (`nodeId`, `allNodes`, `allLinks`, the six callback props) is unchanged.

### Create note and unlinked notes: out of the way until wanted

`CreateNoteForm`, currently inline in the header row, moves into a popover opened from the search bar's "New note" button — same component, same `onCreated` contract, different trigger and container. `UnlinkedNotes`, currently the same inline row, becomes a small frosted disclosure pinned bottom-left, collapsed by default to just a count, expanding to the existing list on click. Both changes are containers only; neither component's data-fetching or emitted events change.

### Accessibility carries over unchanged

`GraphCanvas`'s `role="img"` summary and its `sr-only`/`focus-within:not-sr-only` node list (the actual keyboard/screen-reader path, per that file's own header) are unchanged by this shell — they describe the graph, not the chrome around it. Visible focus rings are re-tuned for the dark ground rather than removed. Every panel's text keeps at least 4.5:1 contrast against the darkest plausible backdrop it can sit over (the canvas can be arbitrarily dark or busy underneath a frosted panel; the panel's own translucent surface colour plus its text colour must clear the ratio without relying on what's drawn behind it).

## Risks / Trade-offs

- **`backdrop-blur` cost on a busy canvas** → the panels are small relative to the viewport and static (no continuous animation drives their blur), so the cost is a one-time composite per repaint, not per simulation tick; revisit only if profiling shows otherwise.
- **Type focus and query relevance are two transient highlight mechanisms on the same canvas now** → both are dimming/highlighting layers over the same node set, never geometry, and are independent (focusing a type doesn't clear seed highlighting or vice versa); if that combination reads as visually noisy in practice, the next lever is suppressing one while the other is active, not implemented here without evidence.
- **Re-tuning `palette.ts`'s hexes touches a module other code depends on for stable identity** → contracts (lookup, fallback, mutual distinctness) are pinned by this design and by existing tests; only the specific hex values move, and any test asserting a specific old hex is updated alongside, never loosened.
- **Detail panel becoming an overlay removes its previous implicit boundary against the canvas** → the explicit close button is the mitigation; internal scroll capped to viewport height prevents it from growing past the window the way a flex sibling's overflow used to be constrained by its neighbour.

## Migration Plan

Additive/replacing within `apps/web` only — no schema, no server, no `apps/mcp` change. `GraphLegend.tsx` is deleted and replaced by `TypePanel.tsx` in the same change; nothing outside `App.tsx` imports `GraphLegend`. Rollback is reverting the `apps/web` commit; no data or migration to unwind.

## Open Questions

- ~~Should type focus persist across a new search, the way a chip does, or clear the way seed-relevance highlighting clears?~~ **Resolved during task group 3/4 implementation (bd-14q/bd-73t): type focus clears when a new search result replaces the graph** — `App.tsx`'s `runSearch` resets `focusedType` to `null` in the same branch (`result.mode !== "empty"`) where `selectedNodeId` already resets, so it clears exactly when the drawn neighbourhood it was reading actually changes, not on every form submission (an empty-result search leaves the canvas — and now the focus — untouched, matching "Query matches nothing"). Chips are unaffected by this: they're the applied search filter itself, not a canvas-reading aid, so they persist across the search they just drove.
