## Why

There is no way to find an old review in the web app. The board keeps only the 25 most recently closed cards per project (`CLOSED_PER_PROJECT`), the inbox lists board reviews only while they are open, and the only search is the graph's, which draws a subgraph instead of a list and can't filter by project. The screenshots and videos are still on disk (`~/.local/share/breakdown/reviews`, 744 files since 2026-10-29), but nothing in the UI leads back to them.

## What Changes

- A search box sits in the header of every view: graph, board, feed, code, timeline, inbox, and the new results view. Submitting from any of them, the graph's own bar included, opens one results view.
- A new **search results view** at `/search`, held in the address like every other view (`?q=`, repeated `type=`, repeated `project=`, `review=1`). It shows a ranked list of matching nodes with facet filters for **node type**, **project**, and **reviews only**, each with a count. Empty search text is allowed, so filters alone can list things like "every review in `collective`, newest first".
- A review result opens the board drawer for that item (`/board?project=…&item=…`), so its screenshots, video and comments show even when the card is no longer on the board. Any other result opens in the graph with that node selected. The view also offers "Open in graph" for the current query.
- A new core read, **find nodes**: search text (optional) plus structured filters, plus facet counts, in one statement. It is exposed as one validated web procedure.
- Node listing gains one predicate kind, **`contains`**: a top-level metadata array holds a scalar. Reviews are `work_item`s labelled `review`, and `equals` can't express "labels holds `review`", because jsonb containment only matches a primitive against an array at the top level. Like the existing kinds, `contains` compiles to jsonb containment and uses the existing GIN index.

Rejected alternatives:
- **Raise or page the board's closed column.** It would find old reviews only by scrolling one project's board, with no text search.
- **Add filters to the graph's search.** The graph draws a bounded neighbourhood and isn't a list, so "all reviews in a project" doesn't fit it.
- **Make review its own node type.** It would need a type migration in the beads importer and would break the work-item contract the board relies on. A facet over the existing label gets the same result.

## Capabilities

### New Capabilities

- `search-results`: the header search box on every view and the address-held results view, with type, project and review facets and where each result opens.

### Modified Capabilities

- `knowledge-store`: listing by structure gains the `contains` predicate, and a new requirement covers finding nodes by search text and structure together, with facet counts.
- `local-web-api`: a new read procedure serves the results view, bounded and budgeted like the other reads.
- `graph-explorer`: submitting from the graph's search bar opens the results view. The graph still draws from a query in its address ("Open in graph").

## Impact

- `packages/core`: new find module (text + filters + facets), `contains` in `list.ts` predicate validation and compilation, export additions in `index.ts`.
- `apps/web/server/routers/read.ts`: one new procedure and its Zod schema. No change to the auth files, `routers/inbox.ts` or `routers/write.ts`, which the concurrent `bd-d38` work is editing.
- `apps/web/src`: `lib/route.ts` (new `search` route), `App.tsx` (lazy view), new `SearchView` and a shared header search box, one header line in each of `GraphView`, `BoardView`, `FeedView`, `CodeView`, `TimelineView`, `InboxView`. `trpc.ts` and `main.tsx` are not touched.
- No migration, no new environment variable, no model call. `brain_list`'s MCP schema is unchanged; exposing `contains` to agents is a follow-up.
