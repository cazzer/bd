## Why

The explorer draws the store, but it does not let a person read it. A review against the live corpus (1750 nodes, 3248 edges, 14 node types, 9 edge types) found that every visual channel the graph spends is spent on the wrong variable, and that two of them are measurably dead:

- **Edge colour encodes source system against a table that misses every real source.** `SOURCE_SYSTEM_COLORS` knows `repo`/`human`/`agent`; the store's edges are `git` (838), `github` (791), `beads` (82). All 57 edges of a sample search returned `git`, so every edge drew `FALLBACK_COLOR` gray — while the legend advertised three colours present on zero edges.
- **Node size is capped so tightly it quantizes.** `degreeToRadius` hits `NODE_RADIUS_MAX` at degree 6. In that same search 16 of 40 nodes (degree 6 through 98) drew at an identical 9px. This violates the existing spec scenario "one node has ten times the degree of another → its radius is larger by a factor of about three": above degree 6 the actual factor is exactly 1.

Meanwhile `edgeType` — the relation, which is what the architecture is *for* — is invisible until hover, and `blocks`/`child_of` draw undirected. Selecting a hub covers the graph in halos until no edge is visible at all. The type legend reports store-wide counts beside a canvas showing none of them. And the timeline renders as a flat card list with the date repeated on every row and nothing conveying cadence.

Now, because the store is finally large enough that these stop being cosmetic: at 40-node results and degree-98 hubs, a person cannot answer "what am I looking at" from the picture.

## What Changes

Five groups, sequenced — 1 and 2 both rewrite canvas drawing, 5 consumes the palette decision from 3.

1. **Edge encoding carries relation, not provenance.** Colour and dash keyed on `edgeType`, degrading gracefully for an unknown type (edge types are open text — a new one must never need a migration). Arrowheads on the directional relations. Source system demoted to the hover tooltip, which already shows it. Legend footer renames from "edge source" to the relations actually drawn. **BREAKING** at the spec level: replaces the `Edge provenance is visible` requirement.
2. **Dense selections stay legible.** Halo drawing capped to a top-N by relevance instead of firing on every neighbour of the selection; links drawn in a pass above halos; a label with no free slot displaced or given a leader line rather than dropped.
3. **The legend describes the canvas.** On-canvas type counts primary, store counts secondary; a type row filters rather than only tinting; the palette tail becomes an explicit "other" swatch instead of six types silently sharing one gray behind a disclosure.
4. **Expansion is reversible and degree is readable.** Collapse one node's expansion, and reset to seeds. Degree encoding retuned so a hub reads as a hub — the current cap engages at degree 6 and flattens the entire tail.
5. **The timeline reads as time.** Day headers with the date shown once, spacing that reflects real elapsed time, type colour on the row sharing the graph palette, per-type counts on the chips, and the constant `source · relation` text collapsed out of the row body.

Out of scope, recorded so the boundary is explicit: no change to the URL contract of any view, no new read procedure, no schema or migration, and no new environment variable. `bd-7l2` (render-smoke-test harness) is **not** made a prerequisite — these groups verify with `pnpm check` plus Playwright against the running app, which is already proven in-session. Making an untouched P2 infra bead a blocker would balloon the change for no legibility gain.

## Capabilities

### New Capabilities

None. Every requirement here modifies a capability that already exists.

### Modified Capabilities

- `graph-explorer`: replaces `Edge provenance is visible` with a requirement that edge *relation* is the encoded channel and direction is drawn; modifies `Node size encodes connectedness` so the degree channel stays monotonic across the store's real range instead of saturating at degree 6; adds requirements that a dense selection keeps its structure visible, that the type legend describes the drawn graph, and that expansion is reversible.
- `timeline-view`: modifies how a timeline row and its chips read, so elapsed time, cadence, and type composition are visible in the page rather than recoverable only by reading every row.

## Impact

**Code — `apps/web/src`:**

- `graph/palette.ts` — edge-relation palette replaces `SOURCE_SYSTEM_COLORS` as the drawn channel; node palette gains an explicit overflow bucket. Shared with the timeline (group 5), so this file becomes cross-view.
- `graph/encoding.ts` — `degreeToRadius` and the `NODE_RADIUS_*` constants; `GraphLink` gains the fields group 1 draws from.
- `graph/labelPlacement.ts` — displacement/leader-line fallback where it currently returns `visible: false`.
- `graph/expansion.ts` — collapse and reset, alongside the existing merge functions. Its pin/release choreography must survive intact.
- `components/GraphCanvas.tsx` — halo budget, link/halo draw order, arrowheads, dash patterns.
- `components/TypePanel.tsx` — on-canvas counts, filtering rows, edge-relation legend.
- `components/GraphView.tsx` — owns graph state, so collapse/reset controls and the filter selection land here.
- `components/TimelineView.tsx` + `lib/timelineRow.ts` — day grouping, elapsed-time spacing, row colour, chip counts.

**Tests:** the repo's pure-function/vitest split holds — `encoding.ts`, `labelPlacement.ts`, `expansion.ts`, `palette.ts`, `timelineRow.ts` are unit-tested; `GraphCanvas.tsx` deliberately is not, and stays that way.

**Beads:** `bd-3k2` ("Explorer palette: source-system colours for github and git") is subsumed by group 1 and should be superseded or closed against this change rather than implemented separately. `bd-ab9`, `bd-qaz`, and `bd-a5e` sit adjacent to group 4 and should be checked for overlap, not necessarily fixed here.

**Not affected:** no database migration, no new tRPC procedure, no MCP tool change, no model dependency or API key. The app still reads only `DATABASE_URL`, `BRAIN_READ_ONLY`, and `WEB_SERVER_PORT`.
