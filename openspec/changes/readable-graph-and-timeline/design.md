## Context

See proposal.md — Why. Three facts about the current implementation shape every decision below.

**The node palette already owns hue.** `assignTypeColors` hands each node type one of eight `CATEGORICAL_PALETTE` hues by store-wide prevalence rank, resolved live per frame in `GraphCanvas.tsx` against a `typeColors` prop. Any edge encoding that also reaches for saturated hue puts two categorical colour scales in one picture, and the reader has to learn which scale a given colour belongs to before it means anything.

**Draw order is already available and is currently working against us.** `force-graph` renders `onRenderFramePre` → links → nodes (`nodeCanvasObject`) → `onRenderFramePost`. Halos are drawn inside `drawNode`, which is `nodeCanvasObject` — so they land *after* links and cover them. `GraphCanvas.tsx` already uses `onRenderFramePre` (for `computeLabelPlacements`), so the hook we need is one we are already in.

**The degree distribution is far more skewed than the encoding assumes.** Measured against the live store: p50=2, p75=4, p90=7, p95=11, p99=22, max=329. `degreeToRadius` saturates at `NODE_RADIUS_MAX` when `4·√d ≥ 9`, i.e. at **degree 6** — so every node from roughly the 90th percentile upward draws at an identical 9px. The flattened band is precisely the band a person is scanning for.

Constraints inherited from the repo: `node_type` and `edge_type` are open text, so no encoding may assume a fixed set or require a migration to admit a new value. The pure-function/vitest split holds — `encoding.ts`, `palette.ts`, `labelPlacement.ts`, `expansion.ts`, `timelineRow.ts` are unit-tested; `GraphCanvas.tsx` deliberately is not. `expansion.ts`'s pin-then-merge choreography exists to protect spatial memory and must survive.

## Goals / Non-Goals

**Goals:**

- One categorical colour scale in the picture, owned by node type.
- Every visual channel spent on a variable that actually varies in this store.
- Encodings that degrade gracefully for an unseen `node_type` or `edge_type`.
- Changes confined to `apps/web` — no server, schema, or core change.

**Non-Goals:**

- Re-laying-out the graph, changing the force simulation, or altering the pin/release contract.
- Any change to a view's URL grammar (`?view=`, `?node=`, repeated `?type=`, the `NO_TYPE_CHOSEN` marker).
- A new tRPC procedure. Everything here is drawn from data the existing reads already return.
- Making `bd-7l2`'s render-smoke-test harness a prerequisite. These groups verify with `pnpm check` plus Playwright against the running app.
- Fixing `bd-qaz` / `bd-a5e` (degree staleness). Group 4 touches degree *encoding*, not degree *freshness*; conflating them widens the change.

## Decisions

### 1. Edges get dash + arrowhead; hue stays with node type

Relation type is carried primarily by **dash pattern and arrowhead**, with edges drawn in a low-chroma neutral rather than a second categorical hue ramp. Relations group into families that share a stroke idiom:

| Family | Relations | Stroke | Arrowhead |
|---|---|---|---|
| containment | `child_of`, `belongs-to`, `part-of-change` | solid | toward the container |
| dependency | `blocks`, `closes` | dashed | toward the target |
| reference | `mentions`, `touches` | dotted | none |
| configuration | `default_view` | thin solid | toward the view |
| unassigned | anything else | dotted, neutral, distinct from `reference` | none |

*Why not colour-by-`edgeType`:* it was the obvious reading of the review finding, and it is wrong. With node types already spending eight hues, a second hue scale on edges means a blue line next to a blue node encodes nothing shared, and the reader must hold two legends. Dash and arrowhead are unused channels that cost nothing and read at the low stroke weights edges are drawn at.

*Why families rather than one style per type:* nine relation types exist today and the column is open text. A family table with a defined fallback admits a tenth without a design change; a per-type table does not.

*Rejected — keeping source system as a secondary hue:* it is near-constant within any one view (all 57 edges of the sample query were `git`), so it would spend a channel to draw a constant.

### 2. Halos move to `onRenderFramePre` and are budgeted

Halo drawing leaves `drawNode` and moves into `onRenderFramePre`, beside the existing `computeLabelPlacements` call. Because that hook runs before links, halos land beneath edges automatically — no compositing tricks, no second link pass.

The set of haloed nodes is capped at a constant `MAX_HALOED_NODES` (start at 12), chosen by the existing relevance tier (selected > seed > neighbour-of-selected > focused match) with node id as the tie-break so the set is stable frame to frame. Beyond the cap, nodes keep their fill and their label eligibility but draw no halo.

*Why a budget rather than shrinking the halo:* the failure in `05-graph-selected.png` is a count problem, not a radius problem. `isNeighborOfSelected` is true for every neighbour, so a degree-98 selection paints 28+ halos; any radius large enough to read on one node merges into a wash at 28. Shrinking the radius makes a single-node halo useless without fixing the crowd.

*Rejected — dropping the `isNeighborOfSelected` tier:* neighbour emphasis is the point of selecting a node. Bounding the count keeps the intent and removes the failure.

### 3. Displaced labels get a leader line

`labelPlacement.ts` currently returns `visible: false` when no candidate slot is free. It gains a second phase: a candidate that exhausts its ring of slots is offered a displaced placement further out along the vector away from the local centre of mass, and — because a displaced label is no longer adjacent to its node — carries a `leader` segment the canvas strokes. A label is dropped only when the displaced placement also collides.

This stays pure and testable: the function returns placements and leader endpoints; `GraphCanvas.tsx` only strokes them.

### 4. The type control counts the canvas and filters it

`TypePanel` takes the drawn nodes as its source of counts in the unselected state, not `getStoreSummary()`. The store-wide figure stays, rendered small and dimmed beside the on-canvas one, because "552 more of these exist that you are not looking at" is genuinely useful — it just is not the primary number.

A row toggles a **filter**, hiding non-matching nodes and the edges that would dangle, rather than the current `focusedNodeType` tint. The tint remains as the hover affordance.

Palette overflow becomes an explicit terminal row — "other (6 types)" with the fallback swatch — expandable to name them. Eight hues stay: categorical discriminability degrades past roughly eight, and with `node_type` open text there is no fixed count to design a larger palette for.

### 5. Degree: retune the curve, then carry the tail in a ring

Two changes to `encoding.ts`:

- `NODE_RADIUS_SCALE` 4 → **3** and `NODE_RADIUS_MAX` 9 → **14** (`NODE_RADIUS_MIN` stays 3). The cap then engages at degree ≈ 22, the measured p99, so 99% of nodes sit on the discriminating √ curve instead of 90%. Spot checks: d=2 → 4.2, d=11 (p95) → 10.0, d=20 → 13.4. A ten-fold degree difference still gives ≈3.16× radius, satisfying the retained scenario.
- Degree past the cap is carried by a **stroke ring** whose width grows with `log(degree / cap)`, so the 329-degree hub is distinguishable from a 22-degree node without either being drawn larger.

*Rejected — simply raising the cap:* the cap exists (bd-4ye) to stop a hub swamping the canvas, and uncapped √ scaling puts the max-degree node at a 54px radius. Moving the saturation point to p99 keeps that protection while ending the flattening; the ring covers what remains.

### 6. Collapse by holder set, not by undo stack

Each drawn node gains a set of **holders**: the sentinel `"query"` when it came from the current search result, plus the id of every node whose expansion introduced it. Collapsing node *X* removes *X* from every holder set and drops nodes whose set is then empty; edges go with their endpoints. Reset-to-seeds drops every node not held by `"query"`. Neither touches surviving nodes' positions, so the pin/release contract is untouched.

*Rejected — an undo stack of graph snapshots:* it grows with exploration, and replaying a snapshot restores old positions, which is exactly the spatial-memory violation `expansion.ts` was written to avoid.

### 7. Timeline spacing is compressed, with an explicit marker past a threshold

Gap between consecutive rows maps through a clamped log of the elapsed interval to a bounded pixel range (a floor of the normal row gap, a ceiling of a few rows' height). Past a threshold interval, the gap is replaced by an explicit separator naming the interval ("3 weeks later"), which is both more readable and what keeps one ancient item from consuming the page.

Grouping is by **day**, with a sticky day header; the row keeps only its time-of-day. Week grouping is the fallback if a day header proves too frequent on sparse timelines — deferred, listed below.

### 8. The type palette becomes cross-view

`palette.ts` is already pure and store-ranked. `TimelineView` gains the same `getStoreSummary()`-derived ranking `GraphView` computes, so a `commit` is the same green in both. The ranking call is a small read the timeline already pairs with two others on load.

*Rejected — a fixed type→colour table:* `node_type` is open text; a table would need editing every time a loader introduces a type, which is the migration burden the schema deliberately avoids.

## Risks / Trade-offs

- **Dash patterns disappear at low zoom** → dash lengths are specified in screen pixels (divided by `globalScale`, as the existing badge and label sizes already are), so they hold their appearance as the canvas zooms.
- **Arrowheads add per-frame cost on dense graphs** → `force-graph`'s built-in `linkDirectionalArrowLength` is used rather than custom canvas work, and arrowheads are suppressed for the `reference` family, which is the largest by count (1461 of 3248 edges).
- **A budgeted halo may omit the node a person just clicked** → the selected node holds the top relevance tier, so it is never the one dropped. Verified by ordering, not by chance.
- **Filtering by type can empty the canvas** → the filter is a toggle with its own visible state and the count that predicts the result, so an empty canvas is a chosen outcome rather than a surprise.
- **Retuning radius changes every existing screenshot and any visual expectation** → no test asserts on drawn radius (`GraphCanvas.tsx` is untested by design); `encoding.test.ts` asserts on `degreeToRadius` and will be updated with the new constants as part of group 4.
- **Group 5 depends on group 3's palette decision** → the sequence is fixed 1 → 2 → 3 → 4 → 5, and group 5 must not start before group 3 lands. This is why the groups run serially rather than in parallel waves.
- **`bd-3k2` is superseded, not implemented** → if this change is abandoned mid-flight, that bead must be reopened rather than left closed against a change that never landed.

## Migration Plan

No data migration, no schema change, no deploy step — this is client rendering in `apps/web`. Rollback is reverting the branch.

The one durable state change is a beads bookkeeping one: `bd-3k2` is superseded by group 1's bead and should be closed with a reason naming this change.

## Open Questions

- **Day versus week grouping in the timeline.** Day is the starting choice. If a sparse timeline (a repository with one commit a month) produces a header per row, week grouping is the fallback. Answerable from the rendered result in group 5 without changing the spec, which requires only that a period be named once per group.
- **Where the "other (n types)" group sits in the ranked list.** Terminal is the starting choice. Purely presentational; no spec or task consequence.
