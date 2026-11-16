## 1. Shell header, routes, project and nav

- [x] 1.1 `lib/route.ts`: `projects` on graph, feed, code, timeline, inbox routes (parse/format via `projectsFrom`); `withProjects(route, projects)`; generalize `chooseProject` to any route (drops `item` only on board/roadmap); tests incl. round-trips and unknown-path redirect carrying `project`
- [x] 1.2 Shell context reading `beadsProjects` once; `switcherOffer` fed from it (board with a view still offers the view's projects)
- [x] 1.3 `AppHeader` in `App.tsx` outside the memoized view: ProjectSwitcher (with "not filtered here" hint on unscoped routes), nav links Graph · Board · Roadmap · Inbox · Search with `aria-current`, HeaderSearch, Hangar/Relay pills, review control slot; `--header-h` token; `inert` while a narrow shell drawer is open
- [x] 1.4 `ViewsMenu`: `trpc.list` of view nodes on open, grouped by renderer, opens the renderer route with `viewId` and current `project`; error line on failure; tests on the pure grouping
- [x] 1.5 Width tiers (design.md decision 8): wide ≥80rem inline; mid 56–80rem nav inline, search behind a magnifier, compact pills; below 56rem nav + Views + search collapse into a Menu disclosure named for the current place (aria-expanded, ArrowDown, Escape, focus return); below 40rem the status pills move into the Menu with a warning dot when one is offline; jsdom tests
- [x] 1.6 `pnpm check` passes (bd-lev aside)

## 2. Review control with inbox entry

- [x] 2.1 Extract the Needs-me pending predicate from InboxView into `lib/inboxRows.ts`; InboxView uses it unchanged (tests pass)
- [x] 2.2 Shell polls `trpc.inbox` every 15 s (paused when hidden) for the pending inbox count; failures hide only that count
- [x] 2.3 `ReviewQueuePill` → review control: review count (live, as today) + inbox count with sr-only labels; popover keeps queue rows and Review all, adds "Go to inbox" (carries `project`, closes popover); remove the provider's fallback-pill placement
- [x] 2.4 Test: a review decided through the queue leaves Needs me without a reload (shared `useReviewQueue` state); test the control with inbox read failing
- [x] 2.5 `pnpm check` passes

## 3. Views adopt the shell

- [x] 3.1 Board and roadmap: drop own switcher, WorkViewToggle (delete component + test), search, pills; keep Refresh/error list in a view toolbar; sticky offsets use `--header-h`; their existing tests pass
- [x] 3.2 Feed, code, timeline, search, inbox: drop own HeaderSearch/pill; titles and tabs in a view toolbar
- [x] 3.3 Graph: floating search stays; top-right column and canvas sit below the header
- [x] 3.4 Live check (second stack, headless Playwright) of every route at 1440 and 390 px: header position identical across views, nav current marking, project carried graph→roadmap, Views menu opens a saved timeline, Go to inbox, deciding a review clears Needs me, phone Menu; screenshots
- [x] 3.5 File a follow-up bead for inbox/review-queue dedup with the overlap table from design context; README's board/roadmap section mentions the header
- [x] 3.6 Screenshots of every view assembled at close; the user waived a blocking visual review for this change (2026-11-16) unless a hard decision came up — none did.
