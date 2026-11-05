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

`listPendingReviews(db, { limit })` in core (a sibling of board.ts, sharing its `registered` CTE; the exact-label test is its own containment form, folded into the project containment for the GIN index) selects from `resolved_nodes` the `work_item` rows of registered beads projects whose labels contain `review` and not `review:changes` and whose status is not `closed`, ordered by `occurred_at` (the bead's creation instant, written by the loader; a value not in the stored `toISOString()` form falls back to the row's `created_at`) then id, with `count(*) OVER ()` for the total — computed before the LIMIT, so `truncated` is `total` exceeding the rows returned and no limit + 1 probe row is needed. The summary line is the first line of the normalized `review.summary`, cut to 200 characters; image count is the length of `review.images`; an `{ invalid: true }` review reads as no summary and zero images rather than dropping the item. `review:changes` is excluded because a sent-back review is the agent's turn, not the person's — the agent files a new request, and counting the old one would make the badge lie. Served by `nodes_metadata_gin_idx` on the label containment. Rejected: deriving the queue client-side from `board` (needs the 3,000-card board read on every view); a new table (the store already holds it).

`reviewQueue` is a query on the board router (no input; `{ reviews, total, truncated }`, dates as strings via dto.ts). It is a read, so read-only mode serves it.

### 2. The shell owns the one stream

A client module `lib/liveStream.ts` holds the tab's single `boardEvents` subscription behind a tiny listener registry: `subscribe({ onStarted, onEvent })` returns an unsubscribe, and a `useLiveState()` hook reports `connecting | live | offline`. The subscription exists while at least one listener is registered and `document.visibilityState !== "hidden"` (the 12d9e31 rule moves here verbatim, with its rationale); every (re)start calls each listener's `onStarted`, so a shown-again tab and a reconnect both re-read. A listener registered while the stream is already live gets `onStarted` immediately (it has missed nothing it could have read). BoardView replaces its own `trpc.boardEvents.subscribe` and `usePageVisible` with this module; its debounce, dirty-flag reads, highlights, and per-project error map stay as they are. The queue hook (`useReviewQueue`) is the second listener: it reads `reviewQueue` on `onStarted` and on any `changed` event (debounced like the board — any event, because a new review is an id the queue has never seen), and exposes `{ reviews, total, truncated, version, error }`.

Rejected: a React context provider holding the subscription (works, but the registry is testable as plain code and needs no provider in tests); one stream per browser via a leader tab (see proposal).

### 3. Indicator: a pill in each view's header, queue state in the shell (prototype A, accepted in review bd-etk.7)

The visual review (bd-etk.7) chose prototype A over a right-edge sheet (B) and a docked status bar (C). The indicator is a small pill — status light, the word for the live state, and the pending count — that each view places in its own top-right header cluster, with the queue opening as a popover anchored under it. A fixed top-right pill would have covered the graph's type panel and the board's Refresh / "Open the graph", which is why it lives inside each header rather than over them. Placement per view: on the board it replaces the existing "Live" text (the board's own live label is removed — the pill shows the same stream); on the graph it sits above the right column, which moves down to make room; feed, timeline, and code put it at the right end of their header. A view that does not place it gets the shell's fallback: the same pill fixed top-right, so a new view is never without one.

The state lives in the shell, not the pill: App.tsx calls `useReviewQueue` once, outside the view switch, and provides it (with the open/close actions for the popover, drawer, and run-through) through a `ReviewQueueContext`. A view change remounts the pill but never the hook, so the stream listener and the last answer survive navigation. The pill is a button whose accessible name carries the count and the live state; the light differs by shape as well as colour (filled = live, half = connecting, ring = offline). The popover lists the queue oldest first (project, title, summary line, image count, age), is keyboard-operable (arrows move, Enter opens, Escape closes and returns focus to the pill), and carries a "Review all" action (decision 6).

### 4. Picking one opens the existing ReviewDrawer over the view

The shell mounts `ReviewDrawer` itself when a queue item is picked, with `project` known from the queue row, `boardLoaded: true`, `boardVersion` = the queue hook's `version` (so the drawer re-reads after each queue read, as it does after each board read), drafts kept in a shell-level map, and `onProjectConfirmed` a no-op. The shell's drawer is state, not address: the view and its URL are untouched. On the board route the shell still opens its own drawer (not the board's `item=`), so the board's address and chips stay exactly as they were; the two drawers are never open together — opening one closes the other. Any prop the drawer needs to run outside the board is additive and defaults to today's behaviour.

### 5. The CLI probes for a tab and changes nothing

`CHROME_REUSE_TAB_SCRIPT` becomes `CHROME_APP_TAB_SCRIPT`: same guard (`if application "Google Chrome" is not running then return "none"`, so it never launches Chrome), same argv-only URL passing, but it only tests whether any tab's URL starts with `<base>/` and prints `present` or `none` — no `set URL`, no `activate`, no window reordering. `present` → print `Review queued in the open breakdown tab.` and skip `open`; `none` → `open -a "Google Chrome" <board link>`; non-zero exit → warn and open. The herdr notification and printed bead id are unchanged and run in every branch.

### 6. "Review all" walks the queue in a modal

Asked for in the layout review (bd-etk.7): a way to run through the whole queue one review at a time, answering each and moving straight to the next, in the spirit of a store's discovery queue. "Review all" in the popover opens a modal dialog over the current view (focus-trapped, Escape or Close ends it, focus returns to the pill). It takes a snapshot of the queue's order when opened and shows one review at a time — "2 of 5", project and title, summary, images (the existing Lightbox), comments, and the decision form — with "Accept & next", "Request changes & next" (message required, as in the drawer), and "Skip". A decision is the same `reviewDecision` mutation the drawer sends; only once it reports written does the modal advance, so a failed write stays on the item with the drawer's error and partial-write messages. Advancing picks the next snapshot item still pending in the live queue (one decided elsewhere meanwhile is passed over), and reviews that arrive while the modal is open are appended to the end of the run. The run ends on a summary — accepted, sent back, skipped — with "Close", or "Review skipped" when any were skipped. No state is stored; closing ends the run.

To share one decision path, the drawer's body (item read, summary, images, comments, decision form, outcome and refusal handling) is extracted from `ReviewDrawer` into a `ReviewItemPanel` that both the drawer and the modal render; the drawer keeps its frame, focus, and props, so the board's behaviour is unchanged. Drafts are kept in the shell's draft map for both. The panel's content area is not hard-wired to an image strip: it renders the review's attachments through one slot keyed by kind, with images (the existing strip and Lightbox) the only kind today, so the follow-on `bd-4zn` (rich artifacts such as Mermaid diagrams and ERDs, and separate before/recommendation parts) adds kinds without reshaping the drawer, the modal, or their props. None of `bd-4zn` is built here. Rejected: chaining the drawer (opening the next drawer on decide) — the drawer's frame is a side panel sized for a single item and offers no run position or summary; a separate route — the run is transient and must not change the address.

### 7. What the run's reviews added (groups 6 follow-ups)

- **Two-column stage.** From `lg` up the run modal widens and splits: the review's attachments fill a stage on the left (about two thirds — one screenshot fills it, a thumbnail strip picks which, the Lightbox opens on click or Enter), summary, thread and decision on the right. Below `lg`, and always in the drawer, the panel stays one stacked column. Attachment renderers take `layout: "column" | "stage"`; on the stage kinds sit side by side, in a column they stack. Before/recommendation (bd-4zn) is a future `part` field that cuts across kinds, grouped part then kind inside the panel — not a renderer entry.
- **Arming.** In a run the decision buttons ignore presses for 500 ms after each review appears, and the shortcuts ignore key repeat and need a fresh press (any key released, pointer press, or newly pressed Ctrl/Cmd) since it appeared, so a held or double-tapped Cmd+Enter decides exactly one review.
- **Leaving.** Escape and Close do nothing while a decision is being written; with at least one review answered they stop at the summary first. A dialog's cancel/close is handled only when it comes from the run's own dialog, never a Lightbox inside it.
- **Uncertain writes.** A 4xx refusal is final, as before; any other thrown error (5xx, non-JSON body, no response) reads as uncertain — "may or may not have been written, check the thread" — and re-reads the item. To name the status, the client's batch link uses a fetch wrapper that turns a non-OK, non-JSON response into `HttpStatusError` ("HTTP 500 Internal Server Error"); this applies to every query and mutation.
- **Phone graph.** Below `sm` the graph's search sits under the queue pill row and the type panel below the search, so the pill is tappable.

## Risks / Trade-offs

- [A visible graph/feed tab now holds a stream it did not before] → Visible tabs are at most one per Chrome window; the six-connection budget is exhausted by windows, not tabs. Hidden tabs hold none.
- [A hidden tab's count is stale] → It re-reads on show; herdr notifies meanwhile. Tab-title badges are a non-goal.
- [Osascript cannot see a tab in another Chrome profile or a non-Chrome browser] → It opens a new tab, which is today's no-tab behaviour; never worse than now.
- [App-level drawer and board drawer diverge] → Same component, same mutation; the shell only supplies props the board supplies today.
- [board-visual-reviews is unarchived and its `board-reviews` spec still says "open Chrome on the board's drawer"] → This change's `review-queue` requirement narrows it; archive board-visual-reviews first, then this change, and edit that clause when archiving.

## Migration Plan

No data migration. Ships as one branch; rollback is reverting it (the CLI falls back to always opening a tab).
