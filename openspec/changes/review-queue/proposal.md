## Why

Every `review-request` an agent runs ends in Chrome: a new tab, or (since commit 12d9e31) an existing board tab navigated away from whatever the person had open. New tabs each cost a live stream, and Chrome allows six HTTP/1.1 connections per host, so they starve the review decision's own POST; retargeting a tab loses the person's place. The reviews are already in the store — the beads loader carries every bead labelled `review` (board-visual-reviews, decision 1) — so the app can show them as a queue and the CLI can stop touching tabs. Epic `bd-etk`.

## What Changes

- A **pending review queue**: the open beads labelled `review` (and not sent back with `review:changes`) across every registered project, read in one statement from the store. No new storage, no migration.
- A **queue indicator on every view**: a status light (the live stream's state) and the pending count, mounted once by the app shell, plus a queue panel listing the pending reviews. Picking one opens the existing review drawer over the current view; a decision removes it from the queue live. The layout is chosen from 2–3 prototypes through a visual review before it is built.
- **One live stream per tab**: the shell owns the single `boardEvents` subscription, held only while the tab is visible, and both the indicator and the board consume it. The board stops opening its own (it keeps its debounce, no-overlap reads, and re-read on reconnect).
- **BREAKING (CLI behaviour)**: `review-request` no longer opens or navigates a tab when a breakdown tab is already open in Chrome — the queue picks the review up live and the herdr notification still fires. It opens a new tab on the review's board link only when no breakdown tab exists. This replaces 12d9e31's reuse-and-navigate, and narrows board-visual-reviews' "open Chrome on the board's drawer" clause.

Rejected: a cross-tab leader (BroadcastChannel / SharedWorker) holding one stream per browser — more moving parts, and the visibility rule already bounds streams to shown tabs. Polling the queue on a timer — the watcher's change events already say when to read. Navigating to the board when a queued item is picked — that is the place-losing behaviour this change removes.

## Capabilities

### New Capabilities
- `review-queue`: the pending review queue as a reader sees it — the indicator on every view, the queue panel, deciding from it, the one-stream-per-tab rule, and `review-request`'s tab behaviour.

### Modified Capabilities
- `local-web-api`: a pending-review queue read is added to the server's procedures.

## Impact

- `packages/core/src/board.ts` (or a sibling `review-queue.ts`): `listPendingReviews`, exported from the index.
- `apps/web/server/routers/board.ts`, `dto.ts`: `reviewQueue` procedure.
- `apps/web/src/App.tsx`: the shell mounts the live-stream owner, the indicator, the queue panel, and an app-level `ReviewDrawer`.
- `apps/web/src/components/BoardView.tsx`: consumes the shared stream; its own subscription and visibility hook move to the shell.
- `apps/web/src/components/ReviewDrawer.tsx`: reused unchanged where possible; any prop it needs to run outside the board is additive.
- `bin/review-request-lib.mjs` and its tests: the Chrome probe replaces the reuse script.
- No new dependency, environment variable, model call, or migration.
