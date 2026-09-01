## 1. Degree and bounded neighbours in core

- [x] 1.1 Add degree to the retrieval result: a scoped aggregate over the returned node set, counted on canonical nodes with endpoints folded through `merged_into` and merge-induced self-connections excluded
- [x] 1.2 Add a `limit` and a continuation to the neighbour fetch, ordered by descending edge weight with a deterministic tie-break on id, reporting whether more were withheld
- [x] 1.3 Extend the retrieval and neighbour result types with the new fields, keeping `apps/mcp` compiling and its tests green
- [x] 1.4 Write tests for the degree spec scenarios: degree counts beyond the returned subgraph, degree across a merge, a merge-induced self-connection is not counted, an unconnected node reports zero
- [x] 1.5 Write tests for the bounded-neighbour scenarios: a 500-neighbour hub against a limit of 25, deterministic ordering when weights tie, fetching the remainder without repeats or gaps, fewer neighbours than the limit
- [x] 1.6 Confirm with `EXPLAIN (ANALYZE, BUFFERS)` that the degree aggregate is a keyed lookup on indexed columns rather than a full-table count, and record the measurement

## 2. Human write surface in core

- [x] 2.1 Add note creation — standalone or annotating an existing node — attributed to an ingest run with `source_system: 'human'`, reusing the existing validation and attribution path
- [x] 2.2 Add annotation: create the note and its `annotates` edge in one transaction, leaving the annotated node's content and hash untouched
- [x] 2.3 Add content update for an editable node, rejecting any node whose source system marks it as file-backed
- [x] 2.4 Add edge assert, retract, and reweight, where retraction removes only the calling source system's assertion
- [x] 2.5 Write tests for the knowledge-store scenarios: hand-authored content is separable from agent and loader content, a person's oversized or control-character content is rejected identically, annotating a file-backed node leaves it unchanged, re-loading an annotated source preserves the annotation, retracting a human edge leaves a loader's assertion intact, re-asserting an existing edge is a no-op
- [x] 2.6 Export the new functions from `packages/core` and confirm `pnpm check` is green across all packages

## 3. Local server and web app skeleton

- [x] 3.1 Scaffold `apps/web`: Vite, React, TypeScript, Tailwind, wired into the pnpm workspace and the root `typecheck` script
- [x] 3.2 Add the tRPC server bound to loopback only, with startup validation that exits naming the connection target when the database is unreachable
- [x] 3.3 Define the read procedures — search, bounded neighbours, node fetch, store summary — as thin calls into `packages/core`
- [x] 3.4 Define the write procedures — create note, annotate, update content, assert/retract/reweight edge — each attributed to a human ingest run
- [x] 3.5 Map core's error taxonomy to responses that name the offending field and never leak a stack trace, an internal path, or the connection string
- [x] 3.6 Wire the typed client into the React app and prove end-to-end inference: change a procedure's return type, confirm typechecking fails at the caller, revert
- [x] 3.7 Render a plain list of search results — no graph yet — and confirm a real query returns real rows from the seeded corpus

## 4. The graph canvas

- [x] 4.1 Add `react-force-graph` and render the search result as a force-directed canvas graph
- [x] 4.2 Size nodes by the square root of their store-wide degree, and verify a ten-times-degree hub draws at roughly three times the radius
- [x] 4.3 Colour nodes by `node_type` and render labels legibly at the default zoom
- [x] 4.4 Style edges by provenance: colour by `source_system`, thickness by `weight`
- [x] 4.5 Show query relevance as a transient highlight on seeds only, clearing when a new query runs, never affecting size or position
- [x] 4.6 Verify against the seeded corpus that a store whose edges are uniformly structural is visually uniform — the `bd-8no` finding should be apparent on sight

## 5. Progressive expansion

- [ ] 5.1 Expand a node's neighbours on click, merging them into the running simulation
- [ ] 5.2 Preserve layout on merge: reuse existing node objects rather than reconstructing the array, seed new nodes at the expanded node's coordinates, and reheat with `alphaTarget` decaying to zero rather than `restart()`
- [ ] 5.3 Bound each expansion by the neighbour limit, indicate when neighbours were withheld, and offer a way to draw the next tranche
- [ ] 5.4 Handle expanding onto an already-drawn node: no duplicate, draw the connecting edge
- [ ] 5.5 Test the layout-stability scenarios: placed nodes stay within tolerance of their previous positions across an expansion, and new nodes enter adjacent to their parent
- [ ] 5.6 Verify the empty-result path leaves the canvas intact and states that both search modes were tried

## 6. Editing, annotation, and creation

- [ ] 6.1 Open a node's detail from the graph, showing content, type, source system, and its file origin when it has one
- [ ] 6.2 Add the tiptap editor with `@tiptap/markdown`, enabled only for editable nodes; render file-backed nodes read-only with their origin shown
- [ ] 6.3 Add annotation from any node, including read-only ones, creating the note and its `annotates` edge and drawing both immediately
- [ ] 6.4 Add standalone note creation, and surface unlinked notes somewhere findable so degree-zero notes do not silently accumulate
- [ ] 6.5 Add hand edge editing from the graph: assert between two nodes with a relationship type, retract, and reweight
- [ ] 6.6 Test the explorer scenarios for editing: a repo-sourced node offers no editing affordance, annotating one leaves its content unchanged, an edited note's new text is searchable, and a hand-drawn edge is drawn with hand-authored provenance styling
- [ ] 6.7 Run the whole thing against the seeded corpus end to end: search, expand, annotate, link, and confirm `pnpm check` is green
