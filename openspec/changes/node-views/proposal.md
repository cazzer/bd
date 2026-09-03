## Why

The explorer has exactly one way to look at anything: a force graph. That is the right view for "what is near this," and the wrong one for "what is my team working on" — a question whose natural answer is a list of open work items with their status, owner, and the external links that point at the real pull request or ticket. The store can already select those items (`listNodes`, `brain_list`), but the web app never calls it and has no surface to draw the result.

Adding a second view raises the question the first one never had to answer: which view should open when someone lands on a node? A person should be able to say "this epic and everything under it opens as a feed" once, on one node, and have every child inherit it. The obvious place for that setting — the governed node's own metadata — does not work here: the batch upsert replaces `metadata` wholesale, so the next beads or GitHub import erases anything a person or agent wrote there. The setting has to live somewhere the importers do not own.

## What Changes

- **A `view` node type.** A view is an ordinary node, written by a person or an agent, whose metadata names a renderer (`graph`, `feed`, or `code`) and carries a validated listing filter — the same filter shape `listNodes` already accepts. A view is data, so an agent can write one through `brain_write` the way it writes anything else. The contract is enforced at every writer in core, never by the database, so `node_type` stays open text and no migration is needed.
- **A `default_view` edge.** From any node to a view node, asserted through the existing edge paths (`brain_link`, `assertEdge`). Because the edge is its own row, owned by whoever asserted it, an importer re-running over the governed node leaves it intact. Nothing constrains cardinality; when a node carries more than one, the heavier edge wins, then the lower view id.
- **Inherited resolution.** A node's effective default view is the `default_view` edge on itself or on its nearest ancestor along `child_of`, resolved for a whole batch of ids in one statement that folds merged endpoints, tolerates cycles, and stops at a depth cap. `child_of` is hereby the containment relation every future importer writes when its source has a hierarchy — it already carries this meaning for work items; this change makes it the one relation settings inherit along.
- **A feed view at `/feed`.** Rows show a node's title, its work-item status, priority, and assignee when present, and any external links found in its metadata. The feed is driven by a view node: `/feed?view=<id>` renders that view's filter. Rows page by the listing cursor. Activating a row opens the node in the graph.
- **The graph is extracted from the app shell first.** `App.tsx` is today both the router and the graph view. Before a second view exists, the graph becomes a `GraphView` component and `App` keeps only the route, `applyRoute`, and `navigate` — so the second view slots in beside the first instead of into it.
- **The web API gains two read procedures**: structured listing (a mirror of `brain_list`) and batched default-view resolution.
- **No new column, no migration, no new dependency.** No web UI for creating views yet; in v1 a view is created over MCP.

## Non-Goals

- **No view editor.** A person creates a view by asking their Claude session to write one. The feed only reads.
- **No code view yet.** The `code` renderer name is reserved so a view written today stays valid when that renderer lands; the feed and graph are the only renderers this change draws. The code view is its own change and depends on a repository ingestor that does not exist yet (`bd-aow`).
- **No automatic redirect on landing.** Opening `/graph?node=<id>` still draws the graph. Resolution answers "what view does this node prefer"; the design decides where that answer is offered, and it never blocks graph rendering.
- **No cardinality constraint on `default_view`.** The store has never constrained edge cardinality and this change does not start; ties resolve deterministically instead.
- **No `child_of` acyclicity trigger.** Only `blocks` is cycle-guarded today. Resolution is written to survive a `child_of` cycle rather than to prevent one. If settings ever carry permission, the trigger lands first — recorded here so it is not forgotten.
- **No history for edges.** Re-pointing a `default_view` edge leaves no revision; edges have no history table and this change does not add one.

## Capabilities

### New Capabilities

- `node-views`: what a view node is and how it is validated, what a `default_view` edge means, how a node's effective view resolves through `child_of` (folding merges, tolerating cycles, breaking ties), and what the feed view shows and how it is addressed.

### Modified Capabilities

- `work-items`: `child_of` is nominated as the containment relation along which node settings inherit; every importer with a hierarchy writes it.
- `brain-mcp`: the write tool validates and defaults a `view` node's metadata before anything is persisted, as it already does for `work_item`.
- `local-web-api`: the read surface gains structured listing and batched default-view resolution.

## Impact

- `packages/core`: new `views.ts` — the view metadata contract (`normalizeViewMetadata`), the `default_view` edge constant, and `resolveDefaultViews(ids)`; exports. Tests for cycle safety, merge folding, and multi-parent tie-break.
- `apps/mcp`: `brain_write` validates `view` nodes; the error mapper names the offending field. No new tool.
- `apps/web`: `src/lib/route.ts` gains a `feed` route; `src/App.tsx` shrinks to routing with the graph moved to `src/components/GraphView.tsx`; new `src/components/FeedView.tsx`; `server/routers/read.ts` gains `list` and `resolveDefaultViews`.
- `packages/db`: untouched. No column on `nodes`, so `resolved_nodes` is untouched; no index, because resolution walks `edges_src_id_edge_type_idx` and `edges_dst_id_edge_type_idx`, which exist.
- Rejected alternatives: a `scope_id` column on `nodes` (needs the `resolved_nodes` replacement, a merge repoint inside `mergeNodes`, and four coordinated edits to get revision history right, for a presentation preference); the setting in the governed node's metadata (clobbered by the shared upsert on the next import, and the web write path refuses importer-owned nodes anyway); a unique per-node pointer edge (a cardinality constraint the store has never had, and a re-point would then violate the shared edge upsert's conflict key).
