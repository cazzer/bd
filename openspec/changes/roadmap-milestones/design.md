## Context

See proposal.md for why. Current state that shapes the approach:

- Beads already models the plan: `bd types` lists a built-in `milestone`, `bd create --due` sets `due_at`, and a claim sets `started_at`. Probed in a scratch checkout: `bd list --json` reports `issue_type: "milestone"`, `due_at: "2026-12-15T00:00:00Z"`, `started_at`, and the epic→milestone link as a `parent-child` dependency, which `deriveBeadsEdges` already turns into `child_of`. `mapBeadsIssueToNode` (`packages/core/src/beads.ts`) drops `due_at` and `started_at`.
- The board read (`packages/core/src/board.ts`) is one statement with an upward `child_of` walk (`ancestors`, alias probe, `merged_into` fold, self-loop guard, `MAX_RESOLVE_DEPTH` cap) and `nearest_epic`. A milestone is a non-epic item today, so it shows up as a card.
- On the Jetson the server has no `bd`; beads changes arrive as relay pushes of raw `bd list` output that the server maps with the same `mapBeadsIssueToNode`. One mapper change covers both paths.
- `/board` takes repeated `project` params (`lib/route.ts`, `projectsFrom`) and draws one chip per offered project.

## Goals / Non-Goals

**Goals:**
- One read statement for the roadmap, sharing the board's walk shape rather than inventing a second traversal.
- No migration: dates live in metadata, milestones are `work_item` nodes.

**Non-Goals:**
- Planned-vs-actual scheduling, dependency arrows, drag-to-reschedule.
- Choosing a different `due_at` granularity than beads gives (beads stores an instant; a date-only `--due` is UTC midnight).

## Decisions

1. **Dates go in the work-item contract, normalized like `occurred_at`.** `normalizeWorkItemMetadata` gains `due_at` and `started_at`, normalized by the same function `normalizeOccurredAt` uses for one key (factor out a `normalizeInstantKey(metadata, key)` in `event-time.ts`). Text order is time order, so the roadmap compares and takes `min()` in SQL without casting — the board's rule that one malformed stored value must not fail the whole read. Readers still treat a value that doesn't match the fixed-width shape (`^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$`) as absent, for rows written before the contract. Alternative: carry them as raw pass-through keys like `source_created_at` — rejected, because a roadmap that sorts on them needs one form.

2. **The roadmap read is its own statement in `packages/core/src/roadmap.ts`**, not a mode of `getWorkBoard`. CTEs:
   - `filtered`: canonical `work_item` rows in the selected projects (the board's `metadata @> ANY(...)` containment against `registeredProjectsCte()`), with `issue_type`, `status`, dates read from metadata.
     Only these rows are counted or returned: an item of a project not selected is not counted under a selected epic or milestone (an epic's milestone is still named, with its due date, wherever it lives).
   - `ancestors`: the board's upward `child_of` walk, seeded from every filtered item, with the same alias/fold/guard/depth cap. Keep the board's version and this one in step by extracting the walk into a shared `buildAncestorWalkCte(seedSql)` in `board.ts` and using it from both — the board's `nearest_epic` and this module must not disagree about ancestry.
   - `item_epic` / `item_milestone`: per leaf (non-epic, non-milestone) item, every epic ancestor (for nested-epic rollup), and the nearest milestone ancestor (`DISTINCT ON`, nearest first, lesser id on a tie, as `nearest_epic`).
   - `epic_milestone`: nearest milestone ancestor of each epic.
   - `epic_progress`, `milestone_progress`: `count(DISTINCT leaf) FILTER (WHERE status group …)`; the `DISTINCT` is what makes a cycle count an item once.
   - `epic_start`: `min(started_at)` over the epic's leaves, so a bar starts when the first task was claimed even when the epic itself was never claimed.
   Bounded by a cap on milestones + epics (`MAX_ROADMAP_ROWS`, 500), cut with `+1` to set `truncated`, as the board does. Leaves are counted, never returned, so the cap is on rows the view draws.

3. **Status groups for progress:** `closed`; `in_progress`; `deferred`; everything else (`open`, `blocked`, unknown) is open. Share = closed / (total − deferred). Alternative: weight by priority or story size — rejected; beads has no size, and a count is what the board already teaches.

4. **The board excludes milestones like epics** and returns each lane epic's milestone (`id`, `title`) from the same `ancestors` walk. A milestone is never a lane: an item directly under a milestone lands in "No epic", which keeps the lane rule ("nearest epic") untouched.

5. **One-at-a-time switcher, multi-project links still read.** `BoardRoute.projects` stays `string[]` so old links and the review deep links (`/board?project=tides&item=…`) keep working; only the UI changes. The switcher is a native `<select>`-style menu button (keyboard and screen-reader behaviour for free) labelled with the current project, "All projects", or "N projects". Alternative: remember the last project per browser and default to it — rejected for now; the address is the state, and a remembered default would make `/board` mean different things on two devices.

6. **`/roadmap` is a route, not a view-node renderer.** `RoadmapRoute { view: "roadmap"; projects: string[]; item: string | null }`, parsed and formatted beside `BoardRoute`. `VIEW_RENDERERS` is not widened; a saved roadmap view can come later. The item drawer is the board's (`ReviewDrawer`/board item read), reused as-is.

7. **Timeline drawn with plain DOM/CSS, no chart dependency.** Rows are a CSS grid: a fixed title/progress column and a timeline column whose bars are absolutely positioned by `(date − axisStart) / axisSpan`. Axis spans from the earliest bar start or target to the latest target or today, padded a week each side, with week ticks (month labels on the first week of a month). Dates are formatted with `timeZone: "UTC"`. Alternative: a gantt library (frappe-gantt, vis-timeline) — rejected: a new dependency for a read-only view of a few dozen rows, and none matches the board's styling. The existing `TimelineView` is a node-event timeline over `occurred_at`, a different shape, so it isn't reused beyond its date-format helpers.

8. **tRPC `roadmap` uses the same procedure builder and scopes as `board`**, so a `human` token (and loopback) reads it, and `procedure-scopes.test.ts` lists it.

## Risks / Trade-offs

- [First ingest after deploy marks every claimed or dated bead updated and writes one revision each] → expected and one-time; the content hash changes because metadata gained keys. Note it in the deploy commit.
- [A `bd` version that omits `started_at`/`due_at`] → keys are optional; the roadmap shows no bar or no target rather than failing.
- [Epics spanning two milestones] → beads allows one parent, so it can't be expressed; the guidance is to split the epic. The spec says an item belongs to at most one milestone.
- [Duplicated walk drift between board and roadmap] → the shared CTE builder (decision 2) plus a test that a nested-epic, cycle-bearing fixture gives the same epic ancestry in both reads.
- [Unarchived `work-board` spec] → the MODIFIED requirement copies board-visual-reviews' text; archive `live-beads-board` and `board-visual-reviews` before this change so the delta lands on a real main spec.

## Migration Plan

No schema migration. Ship as one bd image: build, push to the Mac registry, bump the digest in skyos `apps/breakdown/manifest.json`, `release.sh publish` (docs/jetson.md "Image"). After deploy, run a beads refresh (board "Refresh", or let the relay's watcher push) so dates land. Rollback is the previous digest; extra metadata keys are harmless to the old image.
