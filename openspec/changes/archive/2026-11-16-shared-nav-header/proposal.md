## Why

Every view draws its own header, and none of them links to the others. The inbox, the roadmap, and every saved feed, code, or timeline view are reachable only by typing a URL. Choosing a project only works on the board and roadmap, and the choice is lost as soon as you leave them. The review queue pill in the top right counts board reviews only, so pending inbox items are invisible outside `/inbox`, and nothing on the pill leads there.

## What Changes

- **One shared header on every view** (graph, board, roadmap, feed, code, timeline, inbox, search). It is drawn once by the app shell, outside the memoized view, and holds, left to right:
  - the project switcher;
  - nav links Graph · Board · Roadmap · Inbox · Search, with the current one marked;
  - a **Views** menu listing saved view nodes grouped by renderer (feed, code, timeline, board, graph);
  - search, the hangar and relay status pills, and the review control.
  
  Each view keeps its own toolbar beneath the header for its own controls: board Refresh, graph "New note" and type panel, inbox tabs, view titles. On a phone the nav and Views menu collapse into one menu button.
- **The project follows you.** Every route accepts `?project=<key>`, and the header's links carry it. Board, roadmap and search are scoped by it as today. On graph, feed, code, timeline and inbox the switcher works and the choice is kept, but it scopes nothing yet, and the switcher says so.
- **The review control gains an inbox entry.** It keeps today's behaviour: it counts pending reviews live, and opens the queue popover with "Review all" and the drawer. It also shows the number of inbox items needing you, and its popover gets a **Go to inbox** link. Deciding a review from the queue clears it from the inbox's Needs me. That already holds, because both read the same review state, and the spec now pins it.
- The board's Board/Roadmap toggle and per-view search and pill placements are removed. The header's nav replaces them. **BREAKING (UI only):** the board's toggle goes away; `/board` and `/roadmap` addresses are unchanged.

Not in this change: deduplicating the inbox and the review queue (filed as a follow-up), filtering graph/feed/code/timeline/inbox by project, mapping beads project keys to git or GitHub repos, and the graph's floating search, which stays as its entry point.

Rejected alternatives:
- **Remember the project per browser** (localStorage) instead of carrying it in the address. It would make the same link mean different things on two devices; the address is the state everywhere else in the app.
- **Flat Feed / Code / Timeline nav links** that open the most recent saved view. A view node, not the renderer, is what a reader picks, and a flat link would hide every view but one.
- **Merging the review queue into the inbox now.** The user wants the queue's quick review-all flow kept. The inbox was built for a different source mix (email, Slack, hangar outcomes) and statuses, so merging them is its own change.

## Capabilities

### New Capabilities
- `app-navigation`: the shared header and its parts (nav, Views menu, project switcher, review and inbox control), project carried across routes, and phone behaviour.

### Modified Capabilities
_None._ The board and roadmap requirements still hold: they are addressed by project through a compact switcher, and reach each other in one step, now through the header. The review queue's decision behaviour is unchanged.

## Impact

- `apps/web/src/App.tsx`: renders the shell header outside the memoized view.
- New components: `AppHeader`, `ViewsMenu`, `ReviewControl` (extends `ReviewQueuePill`).
- `lib/route.ts`: `project` on every route.
- Every view component loses its own search, pills, and toggle and keeps a view toolbar.
- `GraphView` moves its top-right column under the header.
- Reads: the existing `list` procedure (view nodes) and `inbox` procedure (pending count). No server or core changes expected.
