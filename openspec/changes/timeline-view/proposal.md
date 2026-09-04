## Why

The store knows when it first saw a node and when it last rewrote one, and nothing else about time. A GitHub issue opened in March and loaded yesterday sorts as yesterday's; a work item created a week ago and touched this morning sorts as this morning's. So the question the graph cannot answer today — "what happened around this repository, in order?" — has no sort key to answer it with. Every loader already holds the source's own timestamps, each under a different name (`source_created_at` in beads, `createdAt` in github, none in git), so the missing piece is one agreed place to put the moment an item happened, and one view that orders by it. This is the fourth renderer `node-views` reserved room for, and the first that reads time.

## What Changes

- **An event-time contract on node metadata.** Any node may carry `occurred_at`: the moment a person would place the item at on a timeline. Every writer that applies a metadata contract today (the MCP write tool, the work-item patch, each loader) normalizes it to one canonical form before anything is persisted, so text order equals time order and a later reader never parses. Absent means the node has no timeline position, not an error. The loaders that hold a source time write it: beads and the GitHub loader. `git` files and directories have no event and write nothing.
- **An anchored, time-ordered read.** One new core read answers, for an anchor node, the canonical nodes adjacent to it that carry `occurred_at`, ordered newest first, filtered by node type and source system, paged by a keyset cursor, and counts the adjacent nodes the filter matched that carry no time. Merged endpoints fold to their survivors the way every other neighbour read does. The web API exposes it as one procedure.
- **A timeline view at `/timeline`.** Addressed by a `view` node's id, the anchor, and the reader's chosen types: `/timeline?view=<id>&node=<anchor>&type=<t>&type=<t>`. The view's filter names the node types offered as chips, all selected until the reader deselects; the chosen set lives in the address so back, reload, and a shared link reproduce it. Rows show the item's time, title, type, source, and how it relates to the anchor; activating one opens the graph on that node. Empty states never redirect.
- **The renderer set gains `timeline`**, and the detail panel's offer — "Open as timeline · <title>" — carries the selected node as the anchor, so a repository or an epic reached in the graph is one click from its history.
- **The invalid-renderer fixture changes name.** `timeline` has been the repo's canonical example of a renderer the contract rejects, in tests and in two spec scenarios; those become `kanban`.
- **No schema change, no migration, no new edge type.** Time lives in metadata, so re-running a loader is the backfill.

## Non-Goals

- **No PR or commit ingestion.** The GitHub loader writes `repo` and open `gh-issue` nodes; the git loader writes `repo`, `directory`, and `file`. A timeline anchored on a repository shows its issues today. Pull requests and commits — the timeline's best content — are the next change (`github-prs-and-commits`), which writes `occurred_at` under this contract without touching it.
- **No Asana or Notion loader.** An agent that reads either can write such nodes with `occurred_at` through the MCP write tool the day this lands; a loader is a separate change.
- **No unanchored timeline.** "Everything, in order" needs the store's listing to order by `occurred_at`, which is a second sort key and a second cursor shape on a read every view shares. `/timeline` with no anchor is an empty state that says to choose a node.
- **No multi-hop descent.** The read is one hop from the anchor along any edge, either direction. An epic's timeline shows its children, not its grandchildren; a repository's shows its issues, not the issues' mentions. Walking `child_of` downward is a bounded extension once the one-hop view has been used.
- **No second time per node.** A pull request opens, merges, and closes; a node carries one `occurred_at`, chosen by its writer under the principle above. Fan-out into several timeline entries per node is a later shape if the one-time-per-node view proves too coarse.
- **No view editor.** As with the feed and the code view, a timeline view is written over MCP.

## Capabilities

### New Capabilities

- `timeline-view`: what the timeline view shows and how it is addressed — the anchor, the type chips and their persistence in the address, the rows and their order, the untimed count, load-more, the empty states.

### Modified Capabilities

- `knowledge-store`: two added requirements — nodes may carry a validated event time, and the store answers an anchored, time-ordered read of a node's timed neighbours.
- `node-views`: the view contract's renderer set gains `timeline`; the detail panel's offer is defined for the `timeline` renderer and carries the selected node.
- `local-web-api`: the read surface gains the anchored timeline read.
- `brain-mcp`: the write tool normalizes `occurred_at` on every written node and its view validation accepts `timeline`.

## Impact

- `packages/core`: new `event-time.ts` (the contract and its normalizer) and `timeline.ts` (`getTimeline` and its query builder); `views.ts` renderer set; `beads.ts` and `ingest-github.ts` map source times; `work-items.ts`'s patch path applies the normalizer; `errors.ts` gains the contract's error; `index.ts` exports. Tests for the normalizer, each loader's mapping, and the read's ordering, paging, folding, filtering, and untimed count.
- `apps/mcp`: `tools/write.ts` applies the normalizer to every item and its description names `timeline`; `errors.ts` maps the new error and renames the renderer list. Tests: server and error fixtures move from `timeline` to `kanban`.
- `apps/web`: `server/routers/read.ts` gains `timeline`; `server/errors.ts` maps the new error; `src/lib/route.ts` gains `TimelineRoute`; `src/App.tsx` gains a case; new `src/components/TimelineView.tsx` with pure helpers in `src/lib/timelineRow.ts`; `DetailPanel.tsx` and `GraphView.tsx` extend the affordance.
- `openspec/changes/node-views` specs: the two scenarios that use `timeline` as the rejected renderer are restated by this change's deltas with `kanban`.
- `packages/db`: untouched.
- Rejected alternatives: a `nodes.event_at` column (touches every read DTO, the `resolved_nodes` view, and the revision snapshot, for a sort key the neighbour set can sort without an index); ordering the existing neighbour read by time (its order is edge weight, its rows carry no metadata, and it computes a store-wide degree per row the timeline never draws); a global listing order by `occurred_at` (a second cursor on the listing every view shares, for a view that is anchored anyway).
