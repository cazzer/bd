One task group, one bead. Group 1 is bd-ker.2 (the store learns reviews); group 2 is bd-ker.1 (the CLI) and can run beside group 1; group 3 is bd-ker.4 (write-back, server side) after group 1; group 4 is bd-ker.3 (the drawer, starting with the layout checkpoint) after groups 1 and 3; group 5 is bd-ker.5 (the push to the pane) after groups 3 and 4. Every group ends with `pnpm check` green. DB-touching worktrees get their own database (`bd memories worktree-agent-setup`); fixtures are scoped, never store-wide counts.

## 1. Review data on work items and the board item read (bd-ker.2)

- [x] 1.1 New `packages/core/src/reviews.ts`: review image root, `normalizeReviewMetadata` per design decision 1 (malformed → `{ invalid: true }`), comment shape and caps, `isInsideReviewRoot(path)` (pure, used by the server in group 4).
- [x] 1.2 `beads.ts`: `BeadsIssue` gains `metadata` and `comment_count`; `mapBeadsIssueToNode(issue, index, { project?, comments? })` writes `review` and `review_comments` for review items only. `beads.test.ts`: review bead with images and comments, malformed review, plain bead metadata byte-identical to before.
- [x] 1.3 `beads-ingest.ts`: after `bd list`, fetch `bd comments <id> --json` through the injectable runner for `review`-labelled issues with `comment_count > 0`. Keep the edit local to the fetch/map step (another change is editing the edge step of this file). DB-backed tests with a fixture runner: comments land; a new comment reports the item updated; no runner call for non-review items.
- [x] 1.4 `board.ts`: `BoardCard.review`; new `getBoardItem(db, { project, externalId })` (canonical row, project-scoped, not found → null). Tests in `board.test.ts`. Export from `index.ts`.
- [x] 1.5 `routers/board.ts`: `boardItem` query (zod: project key form, item ≤ 200 chars), DTO in `dto.ts`; caller tests.
- [x] 1.6 `pnpm check` green; reload the bd tracker on the dev store and confirm only review items are updated.

## 2. review-request CLI (bd-ker.1)

- [x] 2.1 `bin/review-request` (Node ESM, no dependencies, executable) per design decision 7: argument parsing (`<item-id> --summary <text> [--board-url <url>] <image>...`), checkout → main working tree, registered-project lookup over the server's `beadsProjects`, image validation, create-or-reuse the review bead, copy images, `bd update --metadata`, `blocks` dependency for non-epics, Chrome, herdr notification, final message.
- [x] 2.2 Pure helpers split into `bin/review-request-lib.mjs` with `node:test` tests run by `pnpm check` (argument parsing, checkout matching, image naming, reuse decision, refusal messages); `bd`, `git`, `open`, `herdr`, and `fetch` injected.
- [x] 2.3 Symlink into `~/.local/bin`; "Visual reviews" section in the root README; dry run against a scratch beads repo registered on a scratch database: unregistered refusal, missing-image refusal, first request, re-request reuse.
- [x] 2.4 `pnpm check` green.

## 3. Review decision write-back (bd-ker.4)

- [x] 3.1 New `apps/web/server/review-writer.ts`: injectable `runBd`/`runHerdr` (`execFile`, argv only, timeouts, `cwd`), `writeReviewDecision` per design decision 5 returning `{ written, partial?, error? }`.
- [x] 3.2 New `routers/review.ts`: `reviewDecision` mutation with the refusals in the local-web-api delta, then the writer, then `watcher.wake(project)` (new on the watcher; schedules a load like an fs event). Merged in `router.ts`.
- [x] 3.3 Tests: accept runs comment then close with `cwd` = checkout; changes runs comment then add-label; empty message refused for changes; unregistered project and non-review item refused with no command run; shell characters reach argv verbatim; a failing close reports a partial write; read-only refuses.
- [x] 3.4 `pnpm check` green.

## 4. Board deep link and review drawer (bd-ker.3)

- [x] 4.1 Checkpoint: 2–3 drawer layouts on fixture data (e.g. right side panel, wide overlay with filmstrip, split board), screenshotted side by side at 1440 and 390 px with a cost note each. Stop; the user picks.
- [x] 4.2 `lib/route.ts`: `BoardRoute.item`, parse/format/round-trip tests. Board with no `view` uses every registered project (work-board delta).
- [x] 4.3 Image route per design decision 4 in `server/index.ts` (handler module with tests: inside root served, `..` and symlink escape refused, non-image refused, missing 404); Vite proxies `/review-images`.
- [x] 4.4 `components/ReviewDrawer.tsx` in the chosen layout: details for any item with "Open in graph"; for reviews, summary, gallery with enlarge, thread, Accept / Request changes wired to `reviewDecision` with error and partial states; waiting state for an item not loaded yet; card activation opens the drawer; review cards marked.
- [x] 4.5 Live check in a browser (Playwright): deep link opens the drawer; close drops `item`; accept moves the card without reload against a scratch tracker.
- [x] 4.6 `pnpm check` green.

## 5. Push the decision to the requesting pane (bd-ker.5)

- [x] 5.1 `review-writer.ts`: after a successful write, `herdr agent prompt <pane> 'Review <id> accepted|changes requested: <message>'` per design decision 6; result `notified: { ok, reason? }`; logged on failure.
- [x] 5.2 Tests: live pane receives the exact text; no pane, bad pane id, non-zero exit, and timeout each leave the decision written and report why.
- [x] 5.3 Drawer shows notified / not notified with the reason.
- [ ] 5.4 End-to-end once against a scratch tracker and a real herdr pane; `pnpm check` green. The real-pane run is the orchestrator's dogfood from a tides session. Verified so far (bd-ker.5): against a scratch tracker, a PATH stub `herdr` received the exact argv and `HERDR_SOCKET_PATH`, and the real herdr 0.9.1 against a nonexistent pane (`w99:p99`) returned `agent_not_found` while the decision still closed the bead; no live agent pane was prompted.
