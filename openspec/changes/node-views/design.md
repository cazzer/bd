## Context

See proposal.md for motivation. What shapes the approach:

- **The shared node upsert replaces `metadata` wholesale** (`packages/core/src/nodes.ts`, the `ON CONFLICT ... DO UPDATE SET metadata = excluded.metadata` branch), and the web write path refuses every node that is not `human`- or `agent`-sourced (`isEditableSourceSystem`). A setting on an importer-owned node is unreachable from the web and erased on re-import. Edges are separate rows keyed on `(src, dst, type, source_system)`; no importer deletes another source's edges.
- **`merge.ts` never touches `edges`.** Every reader folds endpoints through `coalesce(merged_into, id)` (`retrieval.ts`, `lookup.ts`, `work-items.ts`). Anything new that reads edges does the same.
- **Only `blocks` is cycle-guarded** (the `edges_blocks_acyclic_trigger` `WHEN` clause). A `child_of` cycle is insertable through `brain_link` today.
- **The store has never constrained edge cardinality.** One node may carry N `child_of` edges to N parents from one or several sources.
- **`edges_src_id_edge_type_idx (src_id, edge_type)` and `edges_dst_id_edge_type_idx` exist**; the metadata GIN index is `jsonb_path_ops`, which serves `@>` and not `?`.
- **`apps/web/src/App.tsx` is both the router and the graph view**: one component owning `graph`, `expansions`, `selectedNodeId`, `focusedType`, `chips`, `fitRequestId`, `submittedSearch`, `detailExpanded`, the note form, and five refs, with `applyRoute` (initial load and `popstate`) and `navigate` (the only History API caller) closed over all of it. `src/lib/route.ts` is a one-member discriminated union whose header invites a second member.
- **`listNodes` and `resolveListNodesOptions` exist in core** (`list.ts`) and are wired as `brain_list` in `apps/mcp/src/tools/read.ts` with `boundResponse` budgeting; `apps/web/server/budget.ts` has the same `boundResponse`. `ListedNode` carries `metadata` and a per-row keyset `cursor`.
- **`normalizeWorkItemMetadata`** (`work-items.ts`) is the precedent for a contract enforced at every writer and by no database constraint; `apps/mcp/src/tools/write.ts` calls it when `nodeType === WORK_ITEM_NODE_TYPE`.

## Goals / Non-Goals

**Goals:**

- Views, default-view declarations, and inheritance work with zero DDL, and every new read folds merges and survives a `child_of` cycle.
- The graph view moves out of the app shell without changing any behaviour the `url-addressable-views` scenarios pin down.
- The feed is the smallest list that can be dogfooded against this project's own beads import: open work items, their fields, their links.

**Non-Goals:**

- A view editor, a view picker, or any web write path for views (MCP only in v1).
- Resolving default views for every drawn node up front; v1 resolves the selected node only, though the procedure is batched so that can change without an API change.
- Putting the feed's page position in the URL; "load more" is in-memory, as expansions are for the graph.
- The `code` renderer: reserved in the contract, drawn by nothing.

## Decisions

### 1. A view is validated in core by `normalizeViewMetadata`, mirroring the work-item contract

`packages/core/src/views.ts` exports `VIEW_NODE_TYPE = "view"`, `VIEW_RENDERERS = ["graph", "feed", "code"]`, `DEFAULT_VIEW_EDGE_TYPE = "default_view"`, and `normalizeViewMetadata(input, { itemLabel })`. It requires `renderer ∈ VIEW_RENDERERS` and `filter` to be an object accepted by `resolveListNodesOptions` minus `limit` and `cursor` (those belong to the reader, not the view). It reuses `list.ts`'s validation rather than duplicating it: the filter is passed through `resolveListNodesOptions` and any `InvalidListOptionError` is re-thrown as an `InvalidViewError` naming the node, `filter`, and the inner message. Unknown keys pass through, as they do for work items. The MCP write tool branches on `VIEW_NODE_TYPE` exactly where it branches on `WORK_ITEM_NODE_TYPE`.

*Why not validate in the database?* `node_type` is open text by house rule; a CHECK constraint would be the first type-specific rule in the schema and would need a migration for every renderer added.

*Why nest `filter` when `list.ts` only filters top-level scalars?* Nobody lists views by their filter. Views are found by type (`nodeTypes: ["view"]`) or by the `default_view` edge, so the nested object costs nothing, and it keeps the view's metadata one key away from the listing options it becomes.

### 2. `default_view` is a plain edge; resolution, not the write path, rejects a bad target

The edge goes through `upsertEdges`/`brain_link`/`assertEdge` untouched. Resolution joins the target against `nodes WHERE node_type = 'view' AND merged_into IS NULL` and simply finds nothing for a mis-targeted edge.

*Rejected: refusing the edge at write time.* That is a type check on the target row for one edge type, in a path shared by every loader; the only precedent (`blocks`) is a database trigger with a spec of its own. A mis-targeted `default_view` is visible in `brain_neighbors`, harmless, and cheap to fix by re-linking. If it becomes a recurring mistake, an MCP-side check in `brain_link` is a small later change that needs no spec change beyond a scenario.

*Rejected: a partial unique index making `default_view` one-per-source.* Re-pointing would then violate the index instead of updating, since the shared upsert conflicts on `(src, dst, type, source)`, and a DELETE+INSERT special case would land in the one function every loader shares. A deterministic tie-break costs one `ORDER BY`.

### 3. Resolution is one statement, seeded from an id array, walking `child_of` upward with set semantics

`resolveDefaultViews(db, ids)` in `views.ts`, bounded to `MAX_RESOLVE_IDS` (200, matching `getNodes`), ids validated as UUIDs the way `lookup.ts` does. Shape:

- `alias` CTE: for each distinct input id, the canonical id (`coalesce(merged_into, id)`), so a merged-away input resolves through its survivor.
- `ancestors(start_id, node_id, depth)`: base row `(canonical, canonical, 0)`; recursive term joins `edges e` on `coalesce(src.merged_into, e.src_id) = ancestors.node_id AND e.edge_type = 'child_of'`, yielding `coalesce(dst.merged_into, e.dst_id)` at `depth + 1`, with `UNION` (not `UNION ALL`) and `WHERE depth < MAX_RESOLVE_DEPTH` (32). `UNION` bounds each depth to distinct nodes rather than paths — a node reached by two paths at one depth is one row, the same lesson `work-items.ts` and migration `0005` encode — but it does not terminate a cycle: the `UNION` key includes `depth`, so a cycle member is re-emitted at every depth (measured: 33 rows on a 3-node cycle) and, uncapped, the walk runs to `statement_timeout`. The depth cap is the terminator. The `probe_ids`/alias pattern from `retrieval.ts` keeps `edges_src_id_edge_type_idx` in play for the common unmerged case.
- Candidate CTE: `ancestors` joined to `edges dv` on the folded source and `dv.edge_type = 'default_view'`, joined to `nodes v` on the folded target with `v.node_type = 'view' AND v.merged_into IS NULL`.
- Final: `DISTINCT ON (start_id) ORDER BY start_id, depth, dv.weight DESC, v.id`, returning `start_id, v.id, v.title, v.metadata->>'renderer', ancestors.node_id AS declared_by`. Left-joined back to the input array so every input id yields a row, `view` null when nothing matched.

The result is `Array<{ nodeId, view: { id, title, renderer } | null, declaredBy: string | null }>` in input order. Returning title and renderer costs nothing (the view row is already joined) and spares the web a second fetch to name the affordance.

*Why depth then weight then id, and not weight first?* "Nearest declaration wins" is the inheritance rule; weight only breaks ties among declarations equally near. A heavy edge on a distant ancestor overriding a light one on the parent would make the parent's declaration unreachable — the opposite of the CSS-like intuition a person brings.

*Rejected: a materialised `scope_id`/`governed_by` pointer.* See proposal.md, Impact. Also: the recursion here is one indexed probe per level and terminates at a small depth; the expensive recursions in this repo are fan-outs, and this is not one.

### 4. The app shell becomes a view switch; each view keeps its own URL handling

`apps/web/src/App.tsx` becomes small: it parses `location` into a `Route`, redirects an unknown path to `/graph` with the same query (as today), and renders `GraphView` or `FeedView` keyed on `route.view`. It re-reads `location` on `popstate` and whenever a view calls the shared `navigate`. Today's `App` body moves to `src/components/GraphView.tsx` essentially verbatim: it keeps its `applyRoute`, its generation guards, its own `popstate` listener, and its `navigate` calls, with two changes — its listener ignores a parsed route whose `view` is not `graph` (the shell is about to swap it out), and `navigate` is imported from a tiny `src/lib/navigate.ts` that writes history and notifies the shell.

*Why not hoist `applyRoute` into the shell and drive `GraphView` by a `route` prop?* `applyRoute` is entangled with `runSearch`, `selectNode`, and two generation counters whose review follow-ups fixed four races; turning an imperative call into a prop-driven effect re-opens all four for a refactor whose only goal is to add a sibling. Moving the body verbatim keeps every `url-addressable-views` scenario true by construction; the switch is the only new logic.

*What crossing views costs.* Switching from `/feed` to `/graph` unmounts one view and mounts the other, so the graph starts empty and applies its route on mount, as a fresh page load does. Back from the graph to the feed re-fetches the feed. This matches the existing stance that exploration state is not addressable.

### 5. Route grammar: `/feed?view=<id>`

`Route = GraphRoute | FeedRoute`, `FeedRoute = { view: "feed"; viewId: string | null }`. `parseRoute` accepts `/feed` and `/feed/`; an empty or malformed `view` parameter parses to `viewId: null` (malformed parameters degrade to defaults, as for the graph). `formatRoute` gains a case. `FEED_VIEW_PATH` is exported beside `GRAPH_VIEW_PATH`. Unknown-path redirect is unchanged; `graphRouteFromSearch` still parses graph parameters path-agnostically for it.

*Rejected: `/feed?type=work_item&status=open` style inline filters.* A URL would then be a second, hand-written encoding of the listing filter with its own validation surface; and it could not express "this epic's feed." The view node is the filter's home; the URL names the node.

### 6. The feed fetches the view, then lists; rows are read straight from metadata

`FeedView` loads the view node with the existing `getNodes` procedure, checks `nodeType === "view"` and that `metadata.filter` is an object (the server validated it at write time; the client only guards against a hand-edited row), then calls the new `list` procedure with `{ ...filter, limit: 50 }`. "Load more" calls again with `nextCursor` and appends. A row renders:

- title, and the node type as a chip;
- `status`, `priority`, `assignee` when the corresponding metadata value is a string or number (present on work items; simply absent otherwise);
- every top-level metadata value that is a string beginning with `http://` or `https://`, as a link whose text is the key (`url`, `pr_url`, whatever the writer chose), `rel="noopener noreferrer"` in a new tab.

Row activation navigates with a push to `{ view: "graph", q: null, types: [], node: id }`; the graph's existing "deep-linked node outside the result is drawn on its own" path shows it. The feed is read-only and never asks for content.

*Rejected: a typed row schema per node type.* The feed's value is that an agent can write any filter and see rows without the web knowing the type; a per-type renderer is the code view's job, later.

### 7. Two read procedures; `list` mirrors `brain_list`

`server/routers/read.ts` gains `list` (input: `nodeTypes`, `sourceSystems`, `updatedSince`, `where`, `limit`, `cursor`, with the same zod bounds the MCP tool uses; resolver: `listNodes` then `boundResponse`, cursor taken from the last row actually kept) and `resolveDefaultViews` (input: 1–200 UUIDs; resolver: `resolveDefaultViews`). Both are queries, both go through the existing error mapper. `InvalidViewError` maps to `BAD_REQUEST` beside `InvalidWorkItemError`.

### 8. The affordance lives in the detail panel and is resolved after selection

`GraphView` calls `resolveDefaultViews([selectedNodeId])` in the same place it already fetches the selected node's detail, stores the answer in state keyed by node id, and passes it to `DetailPanel` as `defaultView`. The panel renders, under the info rows, a button "Open as feed · <view title>" when `defaultView.view.renderer === "feed"`, and nothing for `graph`, `code`, or null. The button navigates with a push to `{ view: "feed", viewId }`. A failed resolution sets the state to null and is otherwise ignored; the graph never waits on it.

## Risks / Trade-offs

- **`child_of` cycles are legal.** → The depth cap (`MAX_RESOLVE_DEPTH`) is what terminates the walk; `UNION` only bounds each depth to distinct nodes rather than paths, since its key includes `depth` and a cycle member is re-emitted at every depth. A test writes a two-node cycle and asserts termination and a null answer. If settings ever carry permission, a `child_of` acyclicity trigger lands first (proposal, Non-Goals).
- **Edges have no revision history**, so a re-pointed `default_view` is not auditable. → Accepted for a presentation preference; `brain_neighbors` shows the current edge and its ingest run. Revisit if views start carrying anything a person would want to trace.
- **Moving 900 lines verbatim can still break the URL scenarios** through an import, a ref, or the second `popstate` listener. → The `url-addressable-views` live check (32 assertions, headless Playwright per `bd memories ui-review-without-the-claude-in-chrome-extension`) is re-run after the extraction and again after the feed lands; `route.test.ts` grows the feed cases.
- **Multi-parent tie-break by lesser view id is arbitrary.** → It is deterministic, which is what the scenario demands; a person who cares sets a heavier edge.
- **Loose metadata reading in the feed** (`status` on a non-work-item is shown if present). → Intended: the feed shows what is there. Nothing is written back.
- **A `view` whose filter references a metadata key no node has** lists nothing. → The feed's empty state says "no nodes match this view" rather than looking broken.

## Migration Plan

No schema change. Deploy is a normal build. Rollback: revert the code; view nodes and `default_view` edges left in the store are inert data that nothing else reads.

## Open Questions

- Whether the graph should batch-resolve every drawn node so the canvas can hint which nodes prefer a feed. The procedure is batched already; this is a rendering decision that changes no spec and can wait for a real ask.
