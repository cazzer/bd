## 1. Key in the review contract

- [x] 1.1 `packages/core/src/reviews.ts`: optional `key` (`REVIEW_KEY_PATTERN` = `^[a-z0-9][a-z0-9_-]{0,39}$`, `MAX_REVIEW_KEY_LENGTH` = 40). Absent when missing, null, or empty; a bad key makes the review invalid; the module header and `ReviewMetadata` type updated (design.md decision 2)
- [x] 1.2 Fixtures under `fixtures/review-cards/`: a keyed valid card with its `expected.json`, and `invalid-key.md` (`key: "Has Spaces"`)
- [x] 1.3 Tests: a keyed expected.json normalizes to itself; a bad key is invalid; a keyless legacy review normalizes byte-identical to before; the beads loader carries a key through a load and reports a reload unchanged
- [x] 1.4 `pnpm check` passes, apart from the known `bd-a0r` failure and the 5-second DB timeouts

## 2. review-request: several cards, matched by key

- [x] 2.1 `parseArgs`: `cardPaths: string[]` (1–6, all `.md`); mixing card files and image paths is an argument error; the image form is unchanged (design.md decision 1)
- [x] 2.2 Key per card: a frontmatter `key` is validated as given; otherwise the filename stem is slugged under the spec rule and refused when empty. Keys must be unique within a call (the refusal names both files). The validator mirrors the core pattern, and `key` is written into `metadata.review`
- [x] 2.3 Split the flow into validate-and-stage for all cards (any failure removes every staging dir; nothing filed), then file per card in order. `prepare` (one `bd show`, one `bd list`) runs once; the notification, Chrome, and closing lines run once after the loop and list every review id, key, and question
- [x] 2.4 `chooseReview(children, key, { single })` per design.md decision 3: match on key, else keyless-newest for a single card or the image form, else create. A multi-card call warns naming the keyless reviews it left. The image form never takes a keyed review. A duplicate key reuses the newest and warns with the count
- [x] 2.5 Partial failure: a failed bead write names the filed reviews and the card it stopped at, exits 1, and says a re-run reuses them by key
- [x] 2.6 Card review title `Review: <question>`, cut to 120 characters; on reuse, `bd update --title` when the title differs. Image-form title unchanged (design.md decision 4)
- [x] 2.7 Tests with the injected runner:
  - four cards filed in one call (one `bd show`, one `bd list`, four creates, one notification);
  - a bad second card files nothing;
  - a repeated key refuses;
  - re-running one card of four updates only that review;
  - a keyless legacy review is reused by a single card and left alone by a multi-card call (with the warning);
  - the image form skips keyed reviews;
  - a failure partway, then a re-run, finishes without duplicates;
  - titles for both forms.

  The existing single-card and image-form tests pass with only the title expectation changed
- [x] 2.8 `pnpm check` passes

## 3. review-request: card-first usage and split hints

- [x] 3.1 `USAGE` shows the card form with several cards first; `--help` adds: one decision per card; several decisions are several cards in one call; text, tables, and code go in the card, never in an image; keep a card's filename or `key` across revisions (design.md decision 7)
- [x] 3.2 The question-length and body-budget refusals append the split hint, keeping their current wording; the image form's 280-character warning names the multi-card form
- [x] 3.3 Tests: the first `--help` line is the card form; both refusals carry the hint; no refusal or warning depends on summary wording or image filenames
- [x] 3.4 `pnpm check` passes

## 4. Parent on pending reviews

- [x] 4.1 Extract `getBoardItem`'s parent lateral into a shared SQL fragment builder in `packages/core/src/board.ts` (design.md decision 5); `getBoardItem` uses it, and its tests pass unchanged
- [x] 4.2 `listPendingReviews` joins the same fragment per row, scoped to the row's project; `PendingReview.parent` is `{ id, externalId, title } | null`, still one statement; `PendingReviewDto` passes it through
- [x] 4.3 Tests in `review-queue.test.ts`, with fixtures scoped to their own project key: a review under an epic carries the epic; no parent gives null; a merged-away parent folds to its survivor; a parent in another project is ignored
- [x] 4.4 `pnpm check` passes

## 5. Needs me groups reviews by parent

- [x] 5.1 `apps/web/src/lib/inboxRows.ts`: `QueueReviewRow.parent`; `groupByWork` takes a review row's work from `review.parent` and an inbox row's from `item.about` (design.md decision 6); `InboxView` passes the parent through
- [x] 5.2 Tests in `inboxRows.test.ts`: three reviews under one parent group together at the first one's place; a review and an inbox item with the same work id group together; a lone review keeps its place; the source filter applies before grouping
- [x] 5.3 `pnpm check` passes

## 6. Docs and live check

- [ ] 6.1 README "Visual reviews": the multi-card form, keys, keyless reuse, and grouping in Needs me
- [ ] 6.2 Live: file a two-card review for a bead in this repo through `review-request <id> a.md b.md`. Confirm two reviews with distinct titles on the board, grouped in Needs me; accept one and send the other back; re-run the sent-back card alone and confirm only it updates
- [ ] 6.3 Outside the repo: update `~/.claude/skills/context/visual-review.md` rule 2 to the one-call form, replacing the child-bead-per-question workaround; same for the shlo brief, step 1 (`~/.local/share/shlo-perf/BRIEF.md`)
