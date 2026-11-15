## 1. Planning dates and milestones in the store

- [x] 1.1 Factor a single-key instant normalizer out of `normalizeOccurredAt` in `packages/core/src/event-time.ts`; `normalizeOccurredAt` uses it unchanged (existing tests pass)
- [x] 1.2 `normalizeWorkItemMetadata` normalizes optional `due_at` and `started_at` with it; refusal names item, field, value; tests for date-only, zoned, zoneless-refused, null-deletes
- [x] 1.3 `BeadsIssue` gains `due_at`/`started_at`; `mapBeadsIssueToNode` carries them; an unreadable value fails the load naming issue and field; tests in `beads.test.ts`
- [x] 1.4 Ingest test: a fixture with a milestone (due), an epic under it, a claimed task under the epic loads with `child_of` milestone←epic←task and the dates; a second load reports all unchanged
- [x] 1.5 Extract the board's upward `child_of` walk into a shared CTE builder in `board.ts`; board tests pass unchanged
- [x] 1.6 Board excludes `milestone` items from cards and lane epics, and returns each lane epic's nearest milestone (`id`, `title`); tests: milestone not a card, epic lane names its milestone, task directly under a milestone is in "No epic"
- [x] 1.7 `pnpm check` passes

## 2. Roadmap read

- [x] 2.1 `packages/core/src/roadmap.ts`: option validation shared with the board (`projects`), one-statement read per design decision 2, `MAX_ROADMAP_ROWS` cap with `truncated`; export from `index.ts`
- [x] 2.2 Tests on a fixture: two milestones + nested epics + direct-under-milestone task + deferred task + a `child_of` cycle → spec's rollup numbers (75/25/50, deferred excluded, cycle counted once, empty epic has no share), epic start = earliest item `started_at`, milestone ordering inputs, project isolation, cap/truncated, malformed stored date read as absent
- [x] 2.3 Consistency test: board and roadmap agree on each epic's ancestry for the same fixture
- [x] 2.4 tRPC `roadmap` procedure with the board's scopes; `procedure-scopes.test.ts` and a router test (refuses a bad project key naming `projects`)
- [x] 2.5 `pnpm check` passes

## 3. Board switcher and Board/Roadmap toggle

- [x] 3.1 `lib/route.ts`: `RoadmapRoute` (`/roadmap?project=&item=`) parse/format with tests; unknown-path redirect unchanged
- [x] 3.2 Project switcher component (menu button: "All projects", each offered project, "N projects" label for a multi-project address) replacing the chip row in `BoardView`; choosing replaces/drops `project`; keyboard-operable; tests on the pure choose→route logic
- [x] 3.3 Board/Roadmap toggle in the board header, carrying projects and dropping `item`
- [x] 3.4 Lane header shows the epic's milestone title
- [x] 3.5 Live check against a local stack (headless Playwright per the `headless-live-check` memory): switch project, toggle, reload reproduces; screenshots go to the epic-close review request (filed at the end of group 4)

## 4. Roadmap view

- [ ] 4.1 `RoadmapView.tsx` routed from `App.tsx`: per-project sections, milestone groups ordered by due (undated last, then title), "No milestone" group, the shared switcher and toggle
- [ ] 4.2 Pure layout module (axis span, week ticks, bar/target positions, overdue, UTC date labels) with unit tests, incl. date-only due never shifting a day and not-started epics having no bar
- [ ] 4.3 Rows: title, status, progress bar + share + in-progress/deferred counts, "no items" state; activating a row opens the board item drawer and sets `item`
- [ ] 4.4 Live update: re-read on the board change stream for the shown projects
- [ ] 4.5 Live check with a seeded scratch beads project (milestones, epics, dated and claimed tasks): screenshots of one project and all projects; review request filed
- [ ] 4.6 README "Working on it"/board section documents milestones (`bd create -t milestone --due …`, `bd update <epic> --parent <milestone>`) and `/roadmap`
