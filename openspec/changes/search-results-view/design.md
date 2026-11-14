## Context

See proposal.md for the motivation. These facts about the current store and app shape the approach:

- **What a review is.** A review is a beads `work_item` whose `metadata.labels` array holds exactly `review` (`REVIEW_LABEL`, `packages/core/src/reviews.ts`). The board and the review queue already test it as `metadata->'labels' @> '["review"]'`. There are 343 such nodes today. `metadata.project` is set on every beads work item (2267) and on `beads_project` nodes. GitHub, git and repo-markdown nodes carry no `project`.
- **The listing and search primitives.** `listNodes` (`list.ts`) compiles `equals`/`oneOf` predicates to jsonb containment, served by `nodes_metadata_gin_idx` (`jsonb_path_ops`). jsonb containment matches a primitive against an array only at the top level: `{"labels":["review"]} @> {"labels":"review"}` is false (checked against the dev database). So no existing predicate can say "labels holds review". `retrieve()` is full-text seeds plus graph expansion and returns a subgraph, not a list.
- **What the view can read.** `resolved_nodes` exposes the generated `search` tsvector (checked in `information_schema`), so a canonical-only text match needs no fold.
- **Routing and headers.** Every view already renders a header with `ReviewQueuePill`, so a header search box has one obvious slot per view. Routes are a parse/format pair in `lib/route.ts`. The board drawer loads its item through `boardItem` on its own, so `/board?project=<p>&item=<bead id>` opens a review whether or not its card made the 25-card closed column. A review's external id is its bead id (e.g. `collective-sx4.20.10.1`).
- **Concurrent work.** `bd-d38` is editing the server auth layer, `routers/inbox.ts`, `routers/write.ts`, `src/trpc.ts`, `main.tsx` and `ConnectScreen`. This change touches none of them.

## Goals / Non-Goals

**Goals:**
- One query answers a page of results and the facet counts.
- Header search is the same on every view.
- Old reviews are reachable with their attachments.

**Non-Goals:**
- No fuzzy (trigram) fallback in the results view. Retrieval's exact parsing only, so "nothing matched" means exactly that. Follow-up if exact misses too much.
- No project facet for GitHub or git nodes, whose project is implicit in the external id or repo. They have no `project` and pass only while no project is chosen.
- No change to `brain_list`'s MCP input schema, so agents don't get `contains` yet. The core and store contract support it; exposing it is a follow-up.
- No search-as-you-type. Submit runs the query.
- No new MCP tool and no change to the graph's own retrieval query.

## Decisions

### 1. A new core module `find.ts`, not an extension of `listNodes` or `retrieve`

`findNodes(db, { text?, nodeTypes?, projects?, reviewsOnly?, limit?, offset? })` builds one statement with these CTEs:

- `tsq`: `websearch_to_tsquery('english', text)` when text is given.
- `base`: canonical rows from `resolved_nodes`, matched by `search @@ q` when there is text. Each row carries `node_type`, `metadata->>'project'`, `metadata @> '{"labels":["review"]}'` as `is_review`, a relevance from `ts_rank_cd`, and `updated_at`.
- Three booleans per row: `type_ok`, `project_ok`, `review_ok`.
- `page`: rows where all three hold, ordered by relevance desc (text only), then `updated_at` desc, then `id` desc. Limited to `limit + 1` from `offset`, with a `ts_headline` snippet computed for page rows only.
- Facets:
  - Type counts: rows where `project_ok AND review_ok`, grouped by type.
  - Project counts: rows where `type_ok AND review_ok`, grouped by project, null excluded.
  - Review count: rows where `type_ok AND project_ok AND is_review`.
  - The total.
  - Each facet list is capped (`MAX_FACET_VALUES`, 50) and ordered by count desc, then value.
- The whole answer is one `json_build_object`.

Rejected alternatives:
- **Adding `text` to `listNodes`.** Listing is keyset-paged on `updated_at`, and relevance order would break that cursor. Its spec also promises "without query text".
- **Reusing `retrieve`.** It returns a scored subgraph with expansion and budgets, not a flat page, and it would need a second mode.

Reviews and projects are fixed facets in core rather than a generic "facet on key K" option. A generic key would invite an expression-like surface. Two named facets, both containment-compatible, are the smallest validated shape. `REVIEW_LABEL` already lives in core.

### 2. Canonical rows only (`resolved_nodes`), no `merged_into` fold

CLAUDE.md confines the fold-on-match exception to the retrieval module. The results view lists the survivors' own text. A term that appears only in a merged-away node's text is not found here, though the graph's search still finds it. Rejected: copying retrieval's `nodes` scan plus fold, which would spread the documented exception to a second module.

### 3. Offset paging, bounded

Relevance is a float computed per query, so a keyset over (relevance, updated_at, id) would need the cursor to carry a float and survive re-ranking. Offset over a stable total order (the tie-break ends in `id`) gives no repeats while the store is unchanged, which is what the spec promises. `limit` defaults to 50, max 200. `offset` max is 5000, more than the store's current node count. Past that, the request is refused naming the bound. The server's budget pass drops from the tail, and the next `offset` is `offset + rows returned`, never `offset + limit`.

### 4. `contains` predicate in `list.ts`

`{ key, op: "contains", value: scalar }` compiles to `metadata @> {key: [value]}`. That is containment and `jsonb_path_ops`-indexable, the same shape the board already uses. It is validated like `equals` (key and scalar bounds) and counts toward `MAX_LIST_PREDICATES`. `find.ts` uses the same containment expression for reviews only. The web `list` procedure's Zod union gains the variant so view filters can use it. `normalizeViewMetadata` validates filters through `resolveListNodesOptions`, so it accepts `contains` with no second copy.

### 5. Web procedure `find` in `routers/read.ts`

The Zod input:
- `text?` (max 500, trimmed; empty means none)
- `nodeTypes?`, `projects?` (each 1–`MAX_LIST_NAMES` non-empty strings)
- `reviewsOnly?`
- `limit?`, `offset?`

It is mapped to core and errors go through `mapCoreError("find", …)`. Rows are cut down to the summary DTO (id, nodeType, sourceSystem, externalId, title, updatedAt, snippet, project, status, closedAt, isReview), so review comments and card metadata never travel. `boundResponse` runs with `ctx.responseCharBudget` like `list`. The procedure is public and read-only, so it is unaffected by `BRAIN_READ_ONLY`.

### 6. Route `search` in `lib/route.ts`

The route is `{ view: "search", q, types, projects, reviewsOnly }`, spelled `/search?q=…&type=…&project=…&review=1`. `type` reuses the graph's repeated-parameter rule and `project` reuses the board's. Changing a filter calls `navigate(…, "replace")`. Submitting text calls `push`. `SearchView` is lazy in `App.tsx` like the board and inbox. `lib/searchRow.ts` turns a result into its address:
- A review with a project goes to `formatRoute({view:"board", viewId:null, projects:[project], item: externalId})`.
- Anything else goes to `/graph?node=<id>`.

"Open in graph" goes to `/graph?q=<text>&type=…`. This mapping is a pure function with node-environment tests.

### 7. One header search box, the graph's bar redirected

`HeaderSearch.tsx` is a compact input plus a submit button. It is mounted beside `ReviewQueuePill` in the headers of `BoardView`, `FeedView`, `CodeView`, `TimelineView`, `InboxView` and `SearchView`. On the results view it is prefilled from the route. The graph keeps its own `SearchBar`, with its type suggestions and chips. Its submit now navigates to the results view with its text and chosen types, instead of calling `runSearch` with history `push`. `applyRoute` still runs `runSearch` for a `q` in the address, so "Open in graph", reloads and old links keep drawing. Rejected: one fixed shell bar in `App.tsx` above every view. The graph canvas and the board are full-height layouts with their own top chrome, and an overlay bar would collide with both, along with the review drawer's `sm`-up padding.

## Risks / Trade-offs

- [No-text queries scan every canonical node to compute facets. That is about 3.9k rows today, trivial, but O(store).] → Bounded by the store's statement timeout. If the store grows past ~100k nodes, split facets into index-served per-facet counts. Noted for follow-up, not built now.
- [A merged-away node's text is not searchable here (decision 2).] → The graph's search still finds it. The trade is stated in `find.ts`'s header.
- [Offset paging can shift if the store changes between pages, e.g. a live beads ingest mid-browse.] → Accepted for a personal tool. A changed filter or text resets to offset 0.
- [Redirecting the graph's submit changes a long-standing interaction.] → "Open in graph" is one click from the results, and the address-driven graph path is unchanged. The graph-explorer delta records the change.
- [The concurrent `bd-d38` change will also edit `packages/core/src/index.ts`.] → Additions only, which should be a trivial merge.
