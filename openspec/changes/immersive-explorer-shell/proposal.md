## Why

`add-visual-layer` made the store observable — search, an ego-network graph, click-to-expand, editing and annotation. What it did not make is immersive. The graph sits in a bordered pane below a header block, sharing the window with a title, a search form, and a create-note/unlinked-notes row; a fixed `w-96` detail panel elbows the canvas sideways the moment a node is selected. The graph — the one thing that shows what the store actually holds — gets a fraction of the window, and the fraction it gets moves under it.

The user's own framing: it should feel like exploring a galaxy of thoughts, not filling out a form above a chart. That is a presentation problem, not a data or retrieval problem — every capability this change touches already exists; nothing here is a new fetch.

## What Changes

- **The canvas becomes the whole window.** `GraphCanvas` fills the viewport; every other control floats over it in a frosted-glass layer instead of sharing flex space with it. Selecting a node no longer resizes or shifts the canvas.
- **Dark-first.** Tokens defined in `src/index.css` via Tailwind v4 `@theme`; root gets `color-scheme: dark`. Canvas background matches the page ground. `palette.ts`'s node-type colours are re-tuned for a dark ground (function signatures and contracts unchanged).
- **Search collapses to a frosted bar at the top**, centered: one input plus a compact status line, with a "New note" button at its end opening the existing `CreateNoteForm` in a popover.
- **Search matches node types as well as node text.** Typing surfaces a small dropdown of matching `node_type` names ranked by store-wide count (from `getStoreSummary`); choosing one adds a removable type chip, and submitting runs `search` with the active chips as its `nodeTypes` filter.
- **`GraphLegend` is replaced by `TypePanel`**, a frosted control on the right: a ranked list of node types with swatch, name, and count. With nothing selected it shows the top types store-wide; with a node selected it shows that node's on-screen neighbours' types, ranked by prevalence, under a header naming the selected node. Clicking a type toggles a transient canvas-only **type focus** (matching nodes full-strength, everything else dimmed) and adds the type as a search chip. A compact footer keeps the existing edge-source-system swatches.
- **`DetailPanel` becomes a floating frosted panel** on the right, below the type control, same `w-96` and same functionality, now height-capped with internal scroll and a close button, instead of a bordered flex sibling.
- **Unlinked notes move to a small frosted disclosure**, bottom-left, collapsed by default to a count.

## Non-Goals

- **No light theme.** Dark is the only mode this change builds; tokens are structured so a light variant could be added later, but none is.
- **No server changes.** `search`, `getStoreSummary`, and `getNeighbors` already return everything this shell needs (`nodeTypes` filter, `nodeTypes` count map, the drawn graph's own links for neighbour-type prevalence).
- **No new way to distinguish expansion-loaded nodes from search results** — that is `bd-ab9`, unrelated to layout.
- **No mobile layout.** The floating-panel shell is a desktop-viewport design; a narrow-viewport variant is not addressed.
- **No change to expansion, editing, annotation, or hand-edge behaviour** — `add-visual-layer`'s scenarios for those hold exactly as written; only where their controls live on screen changes.

## Capabilities

### Modified Capabilities

- `graph-explorer`: search also matches type names and applies them as filters; the canvas fills the viewport and controls float over it without reducing the drawable area; a type control reflects the current selection by prevalence; the explorer's default presentation is dark.

No capability is added or removed — this change is entirely about `graph-explorer`'s presentation requirements.

## Impact

- Changed, `apps/web` only: `src/App.tsx` (shell restructure), `src/index.css` (dark tokens via `@theme`), `src/graph/palette.ts` (dark-ground node colours, same exported contracts), `src/components/GraphCanvas.tsx` (dark canvas background), `src/components/DetailPanel.tsx` (floating panel styling).
- Removed: `src/components/GraphLegend.tsx`.
- New: `src/components/TypePanel.tsx`, `src/lib/typeMatch.ts` (+ test), `src/graph/typePrevalence.ts` (+ test).
- No changes to `packages/core`, `packages/db`, `apps/mcp`, or any tRPC procedure signature.
- No new dependencies; no schema migration.
