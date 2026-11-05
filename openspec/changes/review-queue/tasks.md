## 1. Layout prototypes (visual review gate)

- [ ] 1.1 Build 2–3 static prototypes of the indicator + queue panel (e.g. header-corner pill with popover; edge tab with side sheet; docked bottom strip), each drawn over a real screenshot of the graph and board views at 1440 px, in the session scratchpad — no app code
- [ ] 1.2 For each, note its cost: components touched, how it coexists with each view's own header, keyboard/focus model
- [ ] 1.3 Screenshot them side by side and request the pick through `review-request bd-etk`; record the chosen layout in design.md decision 3

## 2. Pending review queue read

- [x] 2.1 Core `listPendingReviews(db, { limit })`: one statement per design.md decision 1 (registered beads projects, label `review` and not `review:changes`, not closed, oldest `occurred_at` first, total + truncated, summary line ≤ 200, image count, invalid review tolerated); export from the index
- [x] 2.2 Core tests against fixtures scoped to their own project keys (never global counts): pending, sent back, closed, near-miss labels, unregistered project, invalid review metadata, cap and truncation, merged-away item folds to its survivor
- [x] 2.3 `reviewQueue` query on the board router with a DTO in dto.ts; router tests including read-only mode
- [x] 2.4 `pnpm check` passes

## 3. One live stream per tab

- [x] 3.1 `lib/liveStream.ts`: listener registry owning the single `boardEvents` subscription, gated on listeners > 0 and page visibility, `onStarted` fan-out on every (re)start and to late joiners, `useLiveState()`; move 12d9e31's header rationale here
- [x] 3.2 BoardView consumes the registry instead of its own subscription and `usePageVisible`; debounce, no-overlap reads, highlights, and error map unchanged
- [x] 3.3 `useReviewQueue()` hook: reads `reviewQueue` on start and on every `changed` event (debounced), exposes reviews/total/truncated/version/error
- [x] 3.4 Unit tests for the registry (one subscription for N listeners, none while hidden, re-start on show calls every `onStarted`, late joiner, last unsubscribe closes) and the hook's debounce; live check: board still updates from a tracker write, and with the board open the tab shows one `boardEvents` request

## 4. review-request leaves open tabs alone

- [ ] 4.1 Replace `CHROME_REUSE_TAB_SCRIPT` with `CHROME_APP_TAB_SCRIPT` (probe only: `present`/`none`, never launches, navigates, or activates) and the `present`/`none`/failure branches per design.md decision 5
- [ ] 4.2 Update review-request-lib tests: present → no `open`, notification still sent; none → `open` on the board link; failure → warning + `open`; the script text contains no `set URL`/`activate`
- [ ] 4.3 `node --test bin/` passes

## 5. Indicator, queue panel, and app-level drawer

- [ ] 5.1 `ReviewQueue` component in the chosen layout, mounted by App.tsx outside the view switch: status light (with text), pending count, empty state, truncation note
- [ ] 5.2 Queue panel listing project, title, summary line, image count, age; keyboard-operable, Escape closes
- [ ] 5.3 Picking opens `ReviewDrawer` from the shell per design.md decision 4 (queue version as `boardVersion`, shell draft map, focus return); any drawer prop added is additive; shell and board drawers never open together
- [ ] 5.4 Pure helpers (row formatting, focus-return target) unit-tested; `pnpm check` passes

## 6. End-to-end check and epic visual review

- [ ] 6.1 Live check (headless Playwright, worktree servers on 4311/5174): file a review in a registered fixture project with the graph view open → count rises without reload; pick it → drawer over the graph, URL unchanged; accept → leaves the queue; with board open, one `boardEvents` request; hide/show tab re-reads
- [ ] 6.2 Run `review-request` against the worktree server with an app tab open → no tab opened or navigated (verified via osascript tab list before/after)
- [ ] 6.3 Screenshots of indicator (zero, some, offline), panel, and drawer over two views; request the epic visual review under bd-etk
