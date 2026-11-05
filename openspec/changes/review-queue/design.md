## Context

See proposal.md for why. What exists today:

- Reviews are beads labelled `review`, loaded by the beads loader with a validated `review` object (summary, images, pane) on the work item's metadata (board-visual-reviews, decision 1). `BoardCard.review` flags them; `getBoardItem` is the drawer's one-item read. A decision is the `reviewDecision` mutation (routers/review.ts); the writer wakes the watcher after any write, so the change event follows within the watcher's debounce.
- `boardEvents` (routers/board-live.ts) streams the watcher's `changed`/`error` events. BoardView owns the only subscriber: subscribe first, read in `onStarted`, debounce 150 ms (max 1 s), never overlap reads, and since 12d9e31 drop the stream while the page is hidden.
- The shell (App.tsx) switches on `route.view` and renders one view; nothing is shared across views. Each view draws its own `glass` header, so there is no common control bar to put an indicator in.
- `review-request` (bin/review-request-lib.mjs) files the bead, then `showInChrome`: an AppleScript finds the first Chrome tab under the board base URL and navigates it to the link, else `open -a "Google Chrome" <link>`; then a herdr notification.

## Goals / Non-Goals

**Goals:** a queue visible from every view, decided in place; at most one stream per tab; the CLI never disturbs an open tab.

**Non-Goals:** cross-tab stream sharing; desktop or tab-title notifications (herdr already notifies); listing sent-back (`review:changes`) reviews; any change to how a decision is written; making the app-level drawer addressable by URL (the CLI's board link remains the addressable form).

## Decisions

### 1. Pending = labelled `review`, open, not `review:changes`, one statement

`listPendingReviews(db, { limit })` in core (a sibling of board.ts, sharing its `registered` CTE and label predicate) selects from `resolved_nodes` the `work_item` rows of registered beads projects whose labels contain `review` and not `review:changes` and whose status is not `closed`, ordered by `occurred_at` (the bead's creation instant, written by the loader) then id, limit + 1, plus `count(*) OVER ()` for the total. The summary line is the first line of the normalized `review.summary`, cut to 200 characters; image count is the length of `review.images`; an `{ invalid: true }` review reads as no summary and zero images rather than dropping the item. `review:changes` is excluded because a sent-back review is the agent's turn, not the person's — the agent files a new request, and counting the old one would make the badge lie. Served by `nodes_metadata_gin_idx` on the label containment. Rejected: deriving the queue client-side from `board` (needs the 3,000-card board read on every view); a new table (the store already holds it).

`reviewQueue` is a query on the board router (no input; `{ reviews, total, truncated }`, dates as strings via dto.ts). It is a read, so read-only mode serves it.

### 2. The shell owns the one stream

A client module `lib/liveStream.ts` holds the tab's single `boardEvents` subscription behind a tiny listener registry: `subscribe({ onStarted, onEvent })` returns an unsubscribe, and a `useLiveState()` hook reports `connecting | live | offline`. The subscription exists while at least one listener is registered and `document.visibilityState !== "hidden"` (the 12d9e31 rule moves here verbatim, with its rationale); every (re)start calls each listener's `onStarted`, so a shown-again tab and a reconnect both re-read. A listener registered while the stream is already live gets `onStarted` immediately (it has missed nothing it could have read). BoardView replaces its own `trpc.boardEvents.subscribe` and `usePageVisible` with this module; its debounce, dirty-flag reads, highlights, and per-project error map stay as they are. The queue hook (`useReviewQueue`) is the second listener: it reads `reviewQueue` on `onStarted` and on any `changed` event (debounced like the board — any event, because a new review is an id the queue has never seen), and exposes `{ reviews, total, truncated, version, error }`.

Rejected: a React context provider holding the subscription (works, but the registry is testable as plain code and needs no provider in tests); one stream per browser via a leader tab (see proposal).

### 3. Indicator and panel live in the shell, drawn from the chosen prototype

App.tsx renders the current view plus a `ReviewQueue` component fixed to the viewport, outside the view switch, so a view change never remounts it or drops the stream. Its exact placement and panel form (popover, side sheet, or docked strip) is decided by the prototype review (tasks group 1) and recorded here before group 5 builds it. Fixed constraints whichever wins: the indicator is a button with the count in its accessible name and the live state as text; it must not cover any view's own header controls at 1280 px or wider; the panel is keyboard-operable and closes on Escape.

### 4. Picking opens the existing ReviewDrawer over the view

The shell mounts `ReviewDrawer` itself when a queue item is picked, with `project` known from the queue row, `boardLoaded: true`, `boardVersion` = the queue hook's `version` (so the drawer re-reads after each queue read, as it does after each board read), drafts kept in a shell-level map, and `onProjectConfirmed` a no-op. The shell's drawer is state, not address: the view and its URL are untouched. On the board route the shell still opens its own drawer (not the board's `item=`), so the board's address and chips stay exactly as they were; the two drawers are never open together — opening one closes the other. Any prop the drawer needs to run outside the board is additive and defaults to today's behaviour.

### 5. The CLI probes for a tab and changes nothing

`CHROME_REUSE_TAB_SCRIPT` becomes `CHROME_APP_TAB_SCRIPT`: same guard (`if application "Google Chrome" is not running then return "none"`, so it never launches Chrome), same argv-only URL passing, but it only tests whether any tab's URL starts with `<base>/` and prints `present` or `none` — no `set URL`, no `activate`, no window reordering. `present` → print `Review queued in the open breakdown tab.` and skip `open`; `none` → `open -a "Google Chrome" <board link>`; non-zero exit → warn and open. The herdr notification and printed bead id are unchanged and run in every branch.

## Risks / Trade-offs

- [A visible graph/feed tab now holds a stream it did not before] → Visible tabs are at most one per Chrome window; the six-connection budget is exhausted by windows, not tabs. Hidden tabs hold none.
- [A hidden tab's count is stale] → It re-reads on show; herdr notifies meanwhile. Tab-title badges are a non-goal.
- [Osascript cannot see a tab in another Chrome profile or a non-Chrome browser] → It opens a new tab, which is today's no-tab behaviour; never worse than now.
- [App-level drawer and board drawer diverge] → Same component, same mutation; the shell only supplies props the board supplies today.
- [board-visual-reviews is unarchived and its `board-reviews` spec still says "open Chrome on the board's drawer"] → This change's `review-queue` requirement narrows it; archive board-visual-reviews first, then this change, and edit that clause when archiving.

## Migration Plan

No data migration. Ships as one branch; rollback is reverting it (the CLI falls back to always opening a tab).
