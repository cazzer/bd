## Context

See proposal.md for motivation. What shapes the approach, as it stands on `main` with code-view merged:

- **Metadata contracts live at the writers.** `normalizeWorkItemMetadata` (`packages/core/src/work-items.ts`) and `normalizeViewMetadata` (`views.ts`) are pure functions each writer calls before `upsertNodes`: the MCP write tool per item, `patchWorkItem` on the merged document, the beads importer per row. `upsertNodes` stays type-agnostic and the database enforces nothing about metadata. `closed_at` is the precedent for a timestamp under a contract: parsed with `new Date`, rejected when `NaN`, stored as `toISOString()`.
- **A metadata-only change is an update.** `unsafeBuildUpsertNodesQuery` (`nodes.ts`) bumps `updated_at` and reports `updated` when `metadata IS DISTINCT FROM` the stored row, even though `content_hash` covers only title and content. Re-running a loader that adds a key rewrites every row it touches.
- **Neighbour reads have one house shape.** `buildGetNeighborsQuery` (`lookup.ts`): `self` folds the id, `alias` collects the merged-away rows, `probe` is both, `raw_neighbors` is a `UNION ALL` of outgoing and incoming edges with the far endpoint folded through `merged_into`, `filtered` joins `resolved_nodes` and drops the merge-induced self-loop, then a keyset page fetches `limit + 1`. Its order is `weight DESC, node_id, edge_id`, one row per edge; it computes a store-wide degree per row and returns no metadata. `getSubtree` (`tree.ts`) is the precedent for a read with one required id: `InvalidLookupIdError` before SQL for a malformed id, `NodeNotFoundError` for zero rows.
- **Listing validation is reusable.** `resolveListNodesOptions` (`list.ts`) bounds `nodeTypes` and `sourceSystems` (`MAX_LIST_NAMES`) and throws `InvalidListOptionError` naming the option; the view contract already routes through it rather than copying the rules.
- **The shell, the route, and the affordance are the extension points code-view proved.** `Route` in `apps/web/src/lib/route.ts` is widened per view; `App.tsx` switches on `route.view`; `DetailPanel` offers `OfferedRenderer = "feed" | "code"` and `GraphView.handleOpenDefaultView` pushes the address. The graph's own route carries repeated `type` parameters for its chips (`?type=a&type=b`), parsed into `types: string[]`.
- **`FeedView` is the pattern for a view driven by a `view` node.** `getNodes` for the view, `viewFilterOf` (`lib/viewFilter.ts`), then the data read with the filter spread in, `PAGE_SIZE` 50, load-more by cursor guarded against stale answers, three empty states that never redirect, row links extracted by `lib/feedRow.ts`.
- **`timeline` is the invalid-renderer fixture** in `views.test.ts`, `apps/web/server/errors.test.ts`, `apps/mcp/src/errors.test.ts`, `apps/mcp/src/server.test.ts`, and in two node-views scenarios this change restates.
- **What the store holds to anchor on.** `github` writes `repo` and open `gh-issue` joined by `belongs-to` (issue → repo) and `mentions` (issue → issue), with `createdAt`/`updatedAt` in metadata; `beads` writes `work_item` joined by `child_of` and `blocks`, with `source_created_at`; `git` writes `repo`/`directory`/`file` joined by `child_of`, with no time at all.

## Goals / Non-Goals

**Goals:**

- One key, one canonical form, enforced where every other contract is enforced, so a node from any source — including one an agent writes by hand — takes its place on a timeline with no reader-side parsing.
- The timeline read folds merges, excludes self-loops, and pages by keyset exactly as the neighbour read does, so the two agree about what "adjacent" means.
- Re-running a loader is the whole backfill.
- The renderer is added the way `code` was: widen the set, the route, the switch, and the offer; nothing about the existing views moves.

**Non-Goals:**

- An index on `occurred_at`. The anchored read sorts a neighbour set that the edge indexes already bound; an expression index would serve only a store-wide order, which is the unanchored timeline the proposal defers.
- Grouping rows by day, or a calendar. Rows carry their time; a day header is layout the first week of use will settle.
- Choosing the anchor from within the timeline. The anchor comes from the graph, through the offer or a deep link.

## Decisions

### 1. `occurred_at` is a metadata contract with a fixed-width canonical form

`packages/core/src/event-time.ts` exports `OCCURRED_AT_KEY = "occurred_at"` and `normalizeOccurredAt(metadata, { index?, itemLabel? })`: pure; returns a copy of the metadata with `occurred_at` rewritten to `new Date(value).toISOString()` when the value is a string (or a `Date`, for a loader that already parsed one) that parses; with the key deleted when the value is absent or `null`; and throws `InvalidEventTimeError(item, value, reason)` (new in `errors.ts`, shaped like `InvalidViewError`) otherwise. `toISOString()` is `YYYY-MM-DDTHH:mm:ss.sssZ` for every instant between years 0 and 9999, so two canonical values compare chronologically as text — which is what lets the read order and page on `metadata->>'occurred_at'` with no cast and no parse. The normalizer runs at every writer, for every node type: the MCP write tool applies it to each item before the type-specific contract (so a `work_item` or `view` with a bad time is named by `occurred_at`, not by its type's contract); `patchWorkItem` applies it to the merged document beside `normalizeWorkItemMetadata`; `mapBeadsIssueToNode` and the GitHub loader's two mappings write the source's created instant through it. `git-repo.ts`, `seed.ts`, and the human note path write no time, so they call nothing.

*Rejected: a `nodes.event_at` column.* A real type and a real index, but it reaches every read DTO (`ListedNode`, `getNodes`, the MCP `get`, the web `list`), needs `CREATE OR REPLACE VIEW resolved_nodes` and a change to the `node_revisions` snapshot trigger in the same migration, and asks `upsertNodes` to learn a column that is not title, content, or metadata. The key can be promoted to a column later with a backfill from the key itself. *Rejected: normalizing inside `upsertNodes`.* The write path would then know one metadata key, and the work-item and view contracts would be the odd ones out. *Rejected: seconds precision, or a form without the `Z`.* Either breaks text order against the millisecond form `closed_at` already stores.

### 2. Which instant a loader writes

The principle: the moment a person would place the item at on a timeline. Beads issues → `created_at`; GitHub issues → `createdAt`; GitHub repositories → `createdAt`. The existing keys stay beside the new one, so nothing that reads `source_created_at` or `createdAt` changes. Files and directories have no event and get nothing; a repository root from the git loader gets nothing either — the GitHub `repo` node of the same repository carries its creation, and the two are `brain_merge`'s case, not a loader's.

*Rejected: `closed_at` for a closed work item.* Moves an item along the timeline when it closes, and a timeline anchored on an epic then shows its children in closing order — a different, also useful, view that a second key or a per-node fan-out (proposal Non-Goals) serves better than overloading the one key. *Rejected: `updated_at` from the source.* That is what the store's own `updated_at` already approximates, and it is the order the feed has.

### 3. One anchored read, `getTimeline`, with its own statement

`packages/core/src/timeline.ts` exports `DEFAULT_TIMELINE_LIMIT` (50), `MAX_TIMELINE_LIMIT` (500), `buildGetTimelineQuery(params)`, and `getTimeline(db, anchorId, options)`. The statement opens with the `self`/`alias`/`probe`/`raw_neighbors`/`filtered` CTEs in `lookup.ts`'s exact shape (both directions, far endpoint folded, `resolved_nodes` join, self-loop guard), with `filtered` also carrying `n.metadata` and applying the narrowing (`node_type = ANY(...)` and `source_system = ANY(...)`, each `NULL` for "all", retrieval.ts's nullable-filter convention). Then `per_node` takes `DISTINCT ON (node_id)` ordered by `node_id, weight DESC, edge_type, edge_id` — one row per neighbour, the heaviest edge's type and direction — and `timed` keeps the rows where `metadata ? 'occurred_at'`, projecting `metadata->>'occurred_at' AS occurred_at`. The page is a keyset over `(occurred_at DESC, node_id ASC)`: `occurred_at < cursor OR (occurred_at = cursor AND node_id > cursor_id)`, `LIMIT limit + 1` so `hasMore` needs no count. A final `untimed` CTE counts `per_node` rows without the key — one aggregate over the same bounded set, so the answer names what it left out. Rows: `{ id, nodeType, sourceSystem, externalId, title, occurredAt, metadata, edgeType, direction, weight }`; never content. `anchorId` is validated as a UUID before SQL (`InvalidLookupIdError`), zero rows from `self` is `NodeNotFoundError`, and `nodeTypes`/`sourceSystems` go through `resolveListNodesOptions`'s name validation — lifted into an exported helper in `list.ts` rather than copied — so `InvalidListOptionError` names the option. `limit` and the cursor's shape (`{ occurredAt: string; id: string }`) are validated here, `InvalidLookupOptionError` as `tree.ts` does.

*Why not order `getNeighbors` by time.* Its order is the graph's (weight), its rows are one per edge, it returns no metadata, and it computes a store-wide degree per row that the timeline never draws; a flag that changes all four is a second procedure wearing the first's name. *Why not a global listing order.* `listNodes`'s cursor is `(updated_at, id)` and every view shares it; a second sort key there is the unanchored timeline the proposal defers. *Why `DISTINCT ON` before the time filter.* A node joined twice — a `belongs-to` and a `mentions` — is one item on a timeline; the neighbour read's one-row-per-edge is right for a graph and wrong here, and choosing the heaviest edge makes the relation shown deterministic. *Why the untimed count is in the same statement.* It is the honest half of the answer — "3 shown, 12 have no time" — and the set it counts is the one the page was cut from, so a second request could disagree with the first.

### 4. Route grammar: `/timeline?view=<id>&node=<anchor>&type=<t>&type=<t>`

`TimelineRoute = { view: "timeline"; viewId: string | null; node: string | null; types: string[] }`, `TIMELINE_VIEW_PATH = "/timeline"`, `parseRoute` accepts the path with one trailing slash, `formatRoute` emits `view`, `node`, then each `type` in order, absent ones omitted. `type` is repeated, not comma-joined, because that is what the graph's chips already do and one parser rule serves both. Chip toggles `navigate(…, "replace")`: a chip is a state of one listing, as the graph's selection is a state of one drawing, so back leaves the view rather than undoing a toggle. Row activation pushes `{ view: "graph", node }`; the offer from the graph pushes `{ view: "timeline", viewId, node: selectedNodeId, types: [] }` — empty, so every chip starts selected.

*Rejected: chip state in component state only.* Reload and a shared link lose the selection, which is the thing the address exists to keep. *Rejected: push per toggle.* Five toggles, five back presses to leave.

### 5. `TimelineView` loads the view like the feed, then the anchor and its timeline in parallel

The first two reads are `FeedView`'s verbatim: `getNodes` for the view, `viewFilterOf`. Then, with an anchor, `getNodes([node])` (for the heading — "<anchor title> · <view title>") runs beside `timeline({ anchorId, nodeTypes: chosen, sourceSystems: filter.sourceSystems, limit: 50 })`. `chosen` is computed by a pure helper in `src/lib/timelineRow.ts`: the address's `types` intersected with the view's `nodeTypes`; an empty address means all of the view's; a view with no `nodeTypes` means no chips and `nodeTypes` omitted; every chip deselected means no read and the "no type is chosen" state. A chip toggle formats the new route and replaces; the effect keyed on `(viewId, node, chosen)` re-reads. Load-more is `FeedView`'s: the cursor from the last answer, appended only if the view, anchor, and chosen set are unchanged. Rows: the time (local, `Intl.DateTimeFormat` with date and time), title, `type · source`, the relation as `edgeType` with an arrow for direction, work-item fields when present (`pickRowFields`), and links (`extractLinks`) beside the button as the feed draws them. Below the rows, "N connected items have no time" when `untimedCount > 0`. Empty states keep the "Timeline" heading and the graph link: no view, not a view, no anchor ("Choose a node in the graph to see its timeline"), anchor not found, nothing timed.

*Rejected: reading the anchor through `getNeighbors` to also draw its degree.* The heading needs a title; the degree is the graph's concern. *Rejected: deriving chips from the rows' types.* Unstable across pages and empty when nothing is timed.

### 6. The affordance is keyed by renderer, and the timeline offer carries the anchor

`OfferedRenderer` becomes `"feed" | "code" | "timeline"`; the button reads "Open as timeline · <title>"; `GraphView.handleOpenDefaultView` pushes the timeline route with `node: selectedNodeId` for `timeline`, as it does for `code`. `App.tsx` mounts `TimelineView` lazily as it does `CodeView` — not for bundle size (the view has no heavy dependency) but so the pattern for a fourth view is the pattern for the third.

### 7. The invalid-renderer fixture becomes `kanban`

`VIEW_RENDERERS` gains `"timeline"`, so the four test files that reject it need a renderer that stays invalid; `kanban` is a plausible future renderer nobody has reserved. The MCP tool description, the MCP error hint, and the web error hint list the four renderers. The two node-views scenarios that name `timeline` as the rejected example are restated with `kanban` in this change's deltas; the node-views change's own files are not edited, since a delta restating the whole requirement is how a modified requirement is carried at archive.

## Risks / Trade-offs

- **Text order depends on every writer canonicalizing.** → Every real writer passes through one normalizer; the read never parses; a test writes a non-canonical string through the raw `upsertNodes` and documents that it sorts as text — a bypass is test-only and visible. Promoting the key to a column is the escape hatch if a writer outside core ever appears.
- **An anchor with thousands of neighbours sorts in memory per page.** → The set is bounded by the anchor's edges, which `edges_src_id_edge_type_idx` / `edges_dst_id_edge_type_idx` serve; at this store's scale (a repository with under a hundred issues, an epic with a dozen children) that is sub-millisecond. The expression index is the lever, and the unanchored timeline is when it is needed.
- **The untimed count is an aggregate over the same set on every page.** → Same bound as the page itself; cheaper than the degree the neighbour read computes per row today.
- **One time per node under-represents items with several.** → Named in the proposal as a non-goal; loaders choose the created instant so the choice is at least uniform.
- **`kanban` may one day be a real renderer.** → It is then renamed in four test files, as `timeline` is now.
- **A chip toggle replaces the address, so it is not undoable by back.** → The chips are on screen; the selection is one click away in either direction.

## Migration Plan

No schema change. Deploy is a normal build. Backfill: `pnpm ingest:beads` and `pnpm ingest:github` once, which report every timed node as updated. Rollback: revert the code; `occurred_at` keys already written are inert metadata that no other reader interprets.
