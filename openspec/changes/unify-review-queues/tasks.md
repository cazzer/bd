# Tasks

## 1. Shared card normalizer (upstreamable)

- [x] 1.1 Export the card normalizer from `packages/core/src/reviews.ts` as `normalizeDecisionCard`; `normalizeReviewMetadata` calls it unchanged
- [x] 1.2 Unit tests for `normalizeDecisionCard` directly; existing `reviews.test.ts` stays green
- [x] 1.3 `pnpm check` green

## 2. Shared card UI (upstreamable)

- [x] 2.1 Extract `DecisionCard` (card body + decision footer, option actions, Choose another, Request changes, keys, arming) from `ReviewItemPanel.tsx`, taking a `decide` callback, `extraActions`, and `sessionLinks`
- [x] 2.2 `ReviewItemPanel` renders through `DecisionCard`, passing a `reviewDecision` decider; `ReviewItemPanel.test.ts` and `ReviewRunModal.test.ts` pass unchanged
- [x] 2.3 Generalize `ReviewSessionLinks` into `SessionLinks({ canFocus, focus, open })`; the review panel passes `reviewSession` calls
- [x] 2.4 Live check: the board drawer and Review all on a card review and a legacy review (keys, Choose another, Request changes, Talk it through)

## 3. Inbox cards and option decisions

- [x] 3.1 `normalizeInboxItemMetadata` reads `question`, `options`, `recommend`, `on_accept` through `normalizeDecisionCard`; invalid → refused, naming item and field
- [x] 3.2 `InboxFeedback.option`; `decideInboxItem` requires an offered option for a card with options, refuses with the "card changed" wording otherwise
- [x] 3.3 `inboxDecision` takes `option`; the inbox dto serves the card
- [x] 3.4 Core and router tests for: batch with options, bad recommend, no card, chosen option recorded, card changed

## 4. Digestion gate

- [x] 4.1 `read` in `normalizeInboxItemMetadata` (≤20 entries, `ref` ≤500, depth full|skimmed); `undigested` status, not counted as open
- [x] 4.2 Upsert sets undigested / pending from `url` coverage; re-write releases a covered undigested item; other statuses carried forward
- [x] 4.3 `release` feedback kind and `inboxRelease` mutation (human run, row lock)
- [x] 4.4 `bin/inbox request --read`; update `~/.claude/skills/inbox-queue` to pass it
- [x] 4.5 Core tests: PR without diff read → undigested; transcript read → pending; re-write releases; no url → pending; hand release
- [x] 4.6 Undigested tab in InboxView (Release / Dismiss); Needs me count excludes it

## 5. Inbox renders the shared card

- [x] 5.1 InboxView's detail pane renders `DecisionCard` with an `inboxDecision` decider and Dismiss as an extra action; the item's content is the evidence
- [x] 5.2 Inbox session buttons go through `SessionLinks` (Go to session / Talk it through ↗)
- [x] 5.3 Live check: a card inbox item (choose the non-recommended option), a plain item, the card-changed refusal

## 6. One Needs me list

- [x] 6.1 InboxView merges the pending inbox items with the shell's review queue rows (typed rows, priority then age); count includes reviews
- [x] 6.2 Source filter chips held in `?source=`; `?item=<project>/<bead>` selects a review
- [x] 6.3 A selected review renders `ReviewItemPanel` in the detail pane (compact header), sharing the shell's draft map; j/k move across both kinds
- [x] 6.4 Live check: an email item and a review side by side; decide the review from the inbox and see the agent notified and the row leave

## 7. Skills and docs

- [x] 7.1 `inbox-ingest` digests before writing (fetch transcript, read diff, list `read`) and writes a card for batches and multi-way choices; reply drafts stay plain
- [x] 7.2 `inbox-execute` acts on the newest accepted feedback's `option`
- [x] 7.3 README: Needs me holds reviews, the source filter, inbox cards
- [x] 7.4 `pnpm check` green; `openspec validate unify-review-queues --strict`
- [x] 7.5 One-off pass: hold the open items whose context says the read was skipped (7 on 2026-11-06) as undigested, so the next `/inbox-ingest` digests them

## Workflow follow-up

- Offer groups 1–2 upstream as their own branch, after review-sessions lands.
