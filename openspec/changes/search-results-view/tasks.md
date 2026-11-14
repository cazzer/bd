## 1. Core: `contains` predicate and `findNodes`

- [x] 1.1 `list.ts`: add the `contains` predicate kind (validated like `equals`, compiled to `metadata @> {key: [value]}`, counted toward `MAX_LIST_PREDICATES`). Tests: a labels array holding the value matches, a bare string and an array without it don't, a non-scalar is rejected naming the predicate.
- [x] 1.2 New `find.ts` with `findNodes` per design decision 1: optional text, `nodeTypes`, `projects`, `reviewsOnly`, `limit` (default 50, max 200), `offset` (max 5000), one statement from `resolved_nodes`, ordering per spec, `ts_headline` snippet on page rows, facet counts each excluding its own dimension, facet lists capped at 50. Module header documents the canonical-only choice (decision 2) and offset paging (decision 3).
- [x] 1.3 `find.test.ts` with scoped fixtures (unique source system and project, never global counts): reviews-only in one project with no text, newest first; text plus type filter, with type counts still covering other types; facet counts exclude their own dimension; nodes without a project pass only with no project chosen; merged-away nodes neither returned nor counted; paging with offset never repeats; oversized limit, offset and name lists rejected before querying.
- [x] 1.4 Export `findNodes` and its types and constants from `packages/core/src/index.ts`, additions only. `pnpm --filter @breakdown/core test` passes.

## 2. Web API: `find` procedure

- [ ] 2.1 `routers/read.ts`: `findInputSchema` and the `find` procedure per design decision 5. Summary DTO only (no content, no full metadata), `boundResponse` with the tail-drop next offset, errors through `mapCoreError("find", …)`. Register it alongside `search` and `list`. Do not touch the auth files, `routers/inbox.ts`, `routers/write.ts` or `src/trpc.ts`.
- [ ] 2.2 `list` procedure's predicate Zod union gains `contains`.
- [ ] 2.3 Tests (`routers/read` or schema tests): invalid input rejected naming the field; the response carries facets and the summary fields; over-budget responses drop from the tail and report more. `pnpm check` passes.

## 3. Web UI: header search and results view

- [ ] 3.1 `lib/route.ts`: `SearchRoute` and `/search` parse/format (`q`, repeated `type`, repeated `project`, `review=1`), plus `route.test.ts` cases for round-trips, trimming, duplicates and a trailing slash.
- [ ] 3.2 `lib/searchRow.ts` plus tests: result to address (a review with a project goes to the board drawer, otherwise `/graph?node=`), the "Open in graph" address, and filter toggles giving the next route.
- [ ] 3.3 `components/HeaderSearch.tsx`, mounted beside `ReviewQueuePill` in `BoardView`, `FeedView`, `CodeView`, `TimelineView` and `InboxView`. `GraphView`'s `SearchBar` submit navigates to the results view with its text and types; `applyRoute` still draws from an address `q`.
- [ ] 3.4 `components/SearchView.tsx`, lazy in `App.tsx`: a header with `HeaderSearch` and `ReviewQueuePill`, then a facet column (types, projects, reviews only, each with counts), then a results list (title, type, project, status or closed date, snippet, review badge) with load-more, empty and error states, and "Open in graph". Filter changes `replace`, text submit `push`s. Keyboard reachable.
- [ ] 3.5 Live check against the running dev server (`:5310`; don't restart it): search from the board header, filter to reviews in `collective`, open a review older than the board's closed column and confirm its images load in the drawer, open a `gh-pr` result in the graph, reload and use back/forward. Screenshots go to visual review once at close (`context/visual-review.md`).
