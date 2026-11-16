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

2. **`project` on every route.** `lib/route.ts` gives `GraphRoute`, `FeedRoute`, `CodeRoute`, `TimelineRoute`, `InboxRoute` a `projects: string[]`, parsed and formatted with the existing `projectsFrom`. Board, roadmap and search already have it. One helper, `withProjects(route, projects)`, builds every header link; `chooseProject` (workViewNav.ts) generalizes to any route. It still drops `item` on board and roadmap, and on other routes it changes only `projects`. Views that ignore `projects` keep it in the address untouched: their own address writes carry the address's projects (`addressProjects()` in lib/navigate.ts, read at write time), and so do the links a view draws to another view (`withAddressProjects`), so the project follows the reader everywhere, not only through the header.

3. **The switcher moves into the header.** It is the same `ProjectSwitcher` and `switcherOffer`. Its offered projects are the view filter's projects on a board with a view, else every registered project. The shell reads `beadsProjects` once (agentProcedure, so human-readable) and shares it through context. Board and roadmap stop reading it themselves, and their switcher state moves up unchanged. On an unscoped view the switcher gets a "not filtered here" hint: a `title`, `aria-description` text, a dashed and muted box, and a visible "not filtered" marker beside it from `sm` up (below `sm`, the first line of the Menu panel says it). A lone project, drawn as text, is focusable while it carries the hint. A failed registry read is retried when the reader next focuses the switcher. While the registry is empty the switcher's width is held, so the nav does not shift when it loads.

4. **The WorkViewToggle is removed.** The nav's Board and Roadmap links replace it, carrying `project` and dropping `item`, which matches the old toggle. The roadmap-milestones requirement "Board and Roadmap are sibling views" still holds through the header. `WorkViewToggle.tsx` and its test go; `boardToRoadmap`/`roadmapToBoard` fold into `withProjects`, and their view-carrying rule (`viewCarriedProjects`) is kept for the Board→Roadmap link.

5. **Views menu.**
   - **Read:** `trpc.list` with `{ nodeTypes: ["view"], limit: 200 }`, read once when the menu opens and cached for the session; when `hasMore`, the menu says more views exist than it lists. Rows are grouped by `metadata.renderer` in the order feed, code, timeline, board (headed Feeds, Code views, Timelines, Boards), and titled by node title.
   - **No graph group:** the graph route has no `view` parameter, so no address opens a saved graph view; DetailPanel's "Open as" leaves graph out for the same reason. Graph views are not listed until the graph route can open one.
   - **Opening a view:** choosing one formats that renderer's route with `viewId`, carrying `project`.
   - **Current:** on a saved view (feed, code, timeline, or a board with `view`) the Views trigger is styled current and that view's row carries `aria-current="page"`; no nav link is current there, and Board always opens the plain board (`/board` with `project`).
   - **Failure:** a failed read shows a one-line error inside the menu.
   - *Alternative:* a new `views` procedure. Rejected; `list` already validates the filter.

6. **Review control = `ReviewQueuePill` plus inbox.**
   - **Inbox count:** the shell header polls `trpc.inbox` (pending items only) on InboxView's own 15 s cadence (`INBOX_POLL_MS`, shared); the poll stops while the tab is hidden and reads at once when it shows again. It counts pending top-level items with the same predicate InboxView uses for Needs me (`needsMeItem`), extracted into `lib/inboxRows.ts` so both count by one rule. They can still differ for a moment (each polls on its own) and when InboxView's single all-status read reaches its 500-item cap, which the header's pending-only read does not; the inbox calls `inboxChanged()` after a decision, release, or hand-off, so the header re-reads at once instead of on its next poll.
   - **Counting rule:** the review count is the queue's pending reviews; the inbox count is the inbox items of Needs me and never the reviews Needs me merges from the queue. The two add up to Needs me's count, and no row is counted twice.
   - **Display:** the pill shows `reviews` and, when greater than 0, an inbox count beside a tray icon, each with its own sr-only label ("2 reviews pending", "3 inbox items need you") that together form the control's name; the visible numbers are hidden from assistive technology. The pill follows the status pills: worded ("Live", "2 reviews") on wide while they fit; without the state word on mid, or on wide once the status words were clipped; bare numbers on narrow and phone, or on mid and wide once even the compact status pills were clipped. Whenever the state word is gone the name is also the tooltip.
   - **Popover:** the existing list and "Review all", plus a "Go to inbox" link beside "Open the board". Both links carry the header links' `project`, kept current while the popover is open; the inbox link opens `/inbox` (Needs me is the inbox's first tab, so no tab parameter is needed), and either link closes the popover. Like the board link on the board, it is not offered on the inbox itself.
   - **Anchor:** the popover anchors under, and returns focus to, the pill that opened it; when that pill leaves the document the popover moves to the first registered pill (the header's), which then shows it as expanded and supplies its links. The provider's fallback pill is gone: the header's pill is on every view.
   - **Failure:** an inbox read failure hides only the inbox count.
   - **Already true:** reviews decided in the queue leave Needs me because both read `useReviewQueue`. A test pins it.
   - *Alternative:* a separate Inbox pill. Rejected: two adjacent counters for overlapping lists make the duplication more visible, not less.

7. **Graph keeps its floating search as the entry point** (graph-explorer "Search is the entry point"). Its top-right pill/type-panel column moves below the header; the canvas fills the space under the header. The header uses the `glass` utility on every view, so the popover stays portalled.

8. **Width tiers.** The inline row needs about 1,250px with both status pills worded, so the header has four tiers, chosen in script so each control mounts once:
   - **wide (80rem and up):** everything inline; search is a box; status pills are worded.
   - **mid (56–80rem):** nav links and Views stay inline. Search becomes a 28px magnifier button (`aria-label` "Search everything") opening a small popover with the box focused. The hangar and relay pills render compact (dot and count, via a `compact` prop, not the viewport's `sm`), and the review pill drops the "Live" word.
   - **narrow (40–56rem):** nav links, Views and search collapse into one Menu disclosure, labelled with the current place ("Roadmap", or the saved view's title; accessible name "Views and navigation, current: Roadmap"), sized like the other controls (`h-7`, 44px where the pointer is coarse). Compact status pills stay inline.
   - **phone (below 40rem):** the same Menu, which also holds the status pills; the Menu button shows a warning dot while hangar or the relay is offline, so status is never hidden in a closed disclosure unflagged.
   - The Menu is a disclosure with `aria-expanded` showing a vertical list; ArrowDown opens it on its first link; it closes on a choice, on Escape (focus returns to the button), on a press outside, and when focus leaves it. The switcher and review control stay inline in every tier. Within a row, the search box gives up width first, then the status pills are clipped, so the review control is never pushed out.
   - The header is `inert` while a drawer is a modal sheet, which generalizes the board and roadmap rule and is driven by the shell drawer state (`useShellDrawer`) and the board's or roadmap's `item`. Otherwise it stacks above the drawers (z 45, under the portalled queue popover's 50), so its menus are never covered by one.

9. **Height token.** Add `--header-h` in index.css. The header is a normal-flow bar of that height at the top of the shell, not a `position: fixed` one; the view fills the rest of the viewport below it, so each view's own scrolling and sticky offsets stay relative to its own box. Only fixed-position layers offset against the token (the graph canvas, its floating search and right column, its keyboard node list, the review drawer), replacing per-view magic numbers.

## Risks / Trade-offs

- [Moving eight headers at once regresses one view's layout] → one task group per view family, a live check of every route at 1440 and 390 px, and a single visual review at the close.
- [Polling `inbox` on every view adds load] → a 15 s poll of a bounded read, the cadence InboxView already uses; the poll pauses when the tab is hidden.
- [The switcher on unscoped views reads as broken] → the explicit "not filtered here" hint, and the spec scenario pins it.
- [Removing the toggle breaks the roadmap-milestones requirement] → it is satisfied by the nav links; the design note above records that.

## Migration Plan

No data migration. Ship with the next bd image, through the same release path as roadmap-milestones.
