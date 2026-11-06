# Tasks

## 1. Shared card normalizer (upstreamable)

- [ ] 1.1 Export the card normalizer from `packages/core/src/reviews.ts` as `normalizeDecisionCard`; `normalizeReviewMetadata` calls it unchanged
- [ ] 1.2 Unit tests for `normalizeDecisionCard` directly; existing `reviews.test.ts` stays green
- [ ] 1.3 `pnpm check` green

## 2. Shared card UI (upstreamable)

- [ ] 2.1 Extract `DecisionCard` (card body + decision footer, option actions, Choose another, Request changes, keys, arming) from `ReviewItemPanel.tsx`, taking a `decide` callback, `extraActions`, and `sessionLinks`
- [ ] 2.2 `ReviewItemPanel` renders through `DecisionCard`, passing a `reviewDecision` decider; `ReviewItemPanel.test.ts` and `ReviewRunModal.test.ts` pass unchanged
- [ ] 2.3 Generalize `ReviewSessionLinks` into `SessionLinks({ canFocus, focus, open })`; the review panel passes `reviewSession` calls
- [ ] 2.4 Live check: the board drawer and Review all on a card review and a legacy review (keys, Choose another, Request changes, Talk it through)

## 3. Inbox cards and option decisions

- [ ] 3.1 `normalizeInboxItemMetadata` reads `question`, `options`, `recommend`, `on_accept` through `normalizeDecisionCard`; invalid → refused, naming item and field
- [ ] 3.2 `InboxFeedback.option`; `decideInboxItem` requires an offered option for a card with options, refuses with the "card changed" wording otherwise
- [ ] 3.3 `inboxDecision` takes `option`; the inbox dto serves the card
- [ ] 3.4 Core and router tests for: batch with options, bad recommend, no card, chosen option recorded, card changed

## 4. Inbox renders the shared card

- [ ] 4.1 InboxView's detail pane renders `DecisionCard` with an `inboxDecision` decider and Dismiss as an extra action; the item's content is the evidence
- [ ] 4.2 Inbox session buttons go through `SessionLinks` (Go to session / Talk it through ↗)
- [ ] 4.3 Live check: a card inbox item (choose the non-recommended option), a plain item, the card-changed refusal

## 5. One Needs me list

- [ ] 5.1 InboxView merges the pending inbox items with the shell's review queue rows (typed rows, priority then age); count includes reviews
- [ ] 5.2 Source filter chips held in `?source=`; `?item=<project>/<bead>` selects a review
- [ ] 5.3 A selected review renders `ReviewItemPanel` in the detail pane (compact header), sharing the shell's draft map; j/k move across both kinds
- [ ] 5.4 Live check: an email item and a review side by side; decide the review from the inbox and see the agent notified and the row leave

## 6. Skills and docs

- [ ] 6.1 `inbox-ingest` writes a card for batches and multi-way choices; reply drafts stay plain
- [ ] 6.2 `inbox-execute` acts on the newest accepted feedback's `option`
- [ ] 6.3 README: Needs me holds reviews, the source filter, inbox cards
- [ ] 6.4 `pnpm check` green; `openspec validate unify-review-queues --strict`

## Workflow follow-up

- Offer groups 1–2 upstream as their own branch, after review-sessions lands.
