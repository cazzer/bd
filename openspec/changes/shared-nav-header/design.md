## Context

See proposal.md for why. Current state (from a read of `apps/web` at de2bd71):

- There is no shell header. `App.tsx` renders `ReviewQueueProvider` around a view memoized on the route (App.tsx:125-131). Each view draws its own header:
  - **Graph:** floating search plus a top-right pill/type-panel column.
  - **Feed, code, timeline, search, inbox:** a title, HeaderSearch, and the pill.
  - **Board:** the switcher, WorkViewToggle, search, the hangar, relay and queue pills, Refresh, and a graph link.
  - **Roadmap:** the switcher, toggle, and pill.
  
  The provider draws a fallback pill when a view places none.
- **Review queue:** `useReviewQueue` (live SSE, `trpc.reviewQueue`) feeds the pill, the popover, "Review all", and the board's `ReviewDrawer`. The inbox's Needs me merges the same `useReviewQueue()` rows on the client (InboxView.tsx:144), so a review decided anywhere leaves both on the next live read. Inbox items poll `trpc.inbox` every 15 s inside InboxView only.
- **Projects and views:** `beadsProjects` lists registered projects. The `list` procedure (`listNodes`) can select `node_type = 'view'`. Feed, code and timeline need a `view` id.
- **Glass headers:** they become the containing block for fixed children, which is why the popover is portalled (ReviewQueue.tsx:33-36). Board and roadmap set `inert` on their header while a narrow drawer is open.

## Goals / Non-Goals

**Goals:**
- One header component owning navigation, project, status, and the review/inbox entry, so a view only adds its own toolbar.
- No server or core change. Everything reads existing procedures.

**Non-Goals:**
- Inbox and review-queue dedup (follow-up bead).
- Project filtering for graph, feed, code, timeline, or inbox.
- A configurable nav.

## Decisions

1. **The header lives in the shell, outside the memoized view.** `App.tsx` renders `<AppHeader route={route} />` above `renderView(route)`. The header re-renders on queue reads; the view does not, which keeps App.tsx:125's guarantee. Views drop their own HeaderSearch, pills, toggle, and fallback-pill placement, and render a `ViewToolbar` row for their own controls.
   - *Alternative:* a `<Header>` each view includes. Rejected: it is today's drift, eight copies that can disagree.

2. **`project` on every route.** `lib/route.ts` gives `GraphRoute`, `FeedRoute`, `CodeRoute`, `TimelineRoute`, `InboxRoute` a `projects: string[]`, parsed and formatted with the existing `projectsFrom`. Board, roadmap and search already have it. One helper, `withProjects(route, projects)`, builds every header link; `chooseProject` (workViewNav.ts) generalizes to any route. It still drops `item` on board and roadmap, and on other routes it changes only `projects`. Views that ignore `projects` keep it in the address untouched.

3. **The switcher moves into the header.** It is the same `ProjectSwitcher` and `switcherOffer`. Its offered projects are the view filter's projects on a board with a view, else every registered project. The shell reads `beadsProjects` once (agentProcedure, so human-readable) and shares it through context. Board and roadmap stop reading it themselves, and their switcher state moves up unchanged. On an unscoped view the switcher gets a small "not filtered here" hint: a `title`, plus `aria-description` text.

4. **The WorkViewToggle is removed.** The nav's Board and Roadmap links replace it, carrying `project` and dropping `item`, which matches the old toggle. The roadmap-milestones requirement "Board and Roadmap are sibling views" still holds through the header. `WorkViewToggle.tsx` and its test go; `boardToRoadmap`/`roadmapToBoard` fold into `withProjects`, and their view-carrying rule (`viewCarriedProjects`) is kept for the Board→Roadmap link.

5. **Views menu.**
   - **Read:** `trpc.list` with `{ nodeType: "view", limit: 200 }`, read once when the menu opens and cached for the session. Rows are grouped by `metadata.renderer` in the order graph, feed, code, timeline, board, and titled by node title.
   - **Opening a view:** choosing one formats that renderer's route with `viewId`.
   - **Failure:** a failed read shows a one-line error inside the menu.
   - *Alternative:* a new `views` procedure. Rejected; `list` already validates the filter.

6. **Review control = `ReviewQueuePill` plus inbox.**
   - **Inbox count:** the shell polls `trpc.inbox` on InboxView's own 15 s cadence. It counts pending top-level items with the same predicate InboxView uses for Needs me, extracted into `lib/inboxRows.ts` so the two can't disagree.
   - **Display:** the pill shows `reviews` and, when greater than 0, an inbox count with an sr-only label for each.
   - **Popover:** the existing list and "Review all", plus a "Go to inbox" link. That link carries `project`, opens Needs me, and closes the popover.
   - **Failure:** an inbox read failure hides only the inbox count.
   - **Already true:** reviews decided in the queue leave Needs me because both read `useReviewQueue`. A test pins it.
   - *Alternative:* a separate Inbox pill. Rejected: two adjacent counters for overlapping lists make the duplication more visible, not less.

7. **Graph keeps its floating search as the entry point** (graph-explorer "Search is the entry point"). Its top-right pill/type-panel column moves below the header; the canvas fills the space under the header. The header uses the `glass` utility on every view, so the popover stays portalled.

8. **Phone.** Below `sm`, nav links and the Views menu collapse into one "Menu" button. It is a disclosure with `aria-expanded` that shows a vertical list, closes on choice and on Escape, and returns focus. The switcher and review control stay inline. The header is `inert` while a narrow drawer is open, which generalizes the board and roadmap rule and is driven by the shell drawer state (`useShellDrawer`).

9. **Height token.** Add `--header-h` in index.css. Views pad and offset sticky elements against it (roadmap axis header, board columns, graph canvas), replacing per-view magic numbers.

## Risks / Trade-offs

- [Moving eight headers at once regresses one view's layout] → one task group per view family, a live check of every route at 1440 and 390 px, and a single visual review at the close.
- [Polling `inbox` on every view adds load] → a 15 s poll of a bounded read, the cadence InboxView already uses; the poll pauses when the tab is hidden.
- [The switcher on unscoped views reads as broken] → the explicit "not filtered here" hint, and the spec scenario pins it.
- [Removing the toggle breaks the roadmap-milestones requirement] → it is satisfied by the nav links; the design note above records that.

## Migration Plan

No data migration. Ship with the next bd image, through the same release path as roadmap-milestones.
