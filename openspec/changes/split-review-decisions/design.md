## Context

See proposal.md for why. The current state this design changes:

- **`bin/review-request-lib.mjs`** has two forms, image and single card.
  - `parseArgs` treats exactly one `.md` positional with no `--summary` as the card form.
  - After validating, it stages images, then calls `prepare` (`bd show` the item, then `bd list --parent <item> --label review --status open,…`). `chooseReview` picks the newest open child, and `write` creates or reuses one bead.
  - `write` is idempotent on re-run because it reuses the bead it created.
  - The card validator mirrors `normalizeReviewMetadata` strictly: every card it accepts normalizes to itself (`fixtures/review-cards/*.expected.json`).
- **`packages/core/src/reviews.ts`** normalizes the `review` metadata key. A structural break (a bad option id) makes the review `{ invalid: true }`, and over-long text is fitted.
- **`packages/core/src/review-queue.ts`** `listPendingReviews` is one statement over `resolved_nodes`, with no parent.
- **`packages/core/src/board.ts`** `getBoardItem` already resolves an item's parent with a `LEFT JOIN LATERAL` over `child_of` edges: folded through `merged_into`, same project, not itself, heavier edge then `beads` then lesser id.
- **`apps/web/src/lib/inboxRows.ts`** `groupByWork` groups inbox rows by `item.about.id`, which is the canonical `work_item` node id, and leaves review rows alone. `InboxView` builds review rows from the shell's `ReviewQueueContext`, whose rows are `PendingReviewDto` (`apps/web/server/dto.ts`).

## Goals / Non-Goals

**Goals:**
- Turn the single-card path into an N-card loop without a second code path. One card is the case N = 1.
- Converge with the inbox at the grouping level: a review and an inbox item about the same work item group by the same node id.

**Non-Goals:**
- Grouping in the board's review pill popover or the Review all run. Siblings filed in one call are already adjacent there, because the queue is ordered by request time. Grouping the popover is a follow-up if dogfooding shows a need.
- A key on image-form reviews. The image form stays as it is.
- Closing or replacing keyless reviews automatically.
- Any change to decisions, the pane prompt, or `reviewDecision`.

## Decisions

### 1. The card form is a list; the single-card path is N = 1

`parseArgs` returns `{ itemId, cardPaths: string[], boardUrl }` when there is no `--summary` and every positional after the item id ends in `.md`. Mixing `.md` and other paths is an argument error.

The run is split into two phases:
- **Validate and stage (all cards):** parse, validate, compute keys, check that keys are unique, and stage each card's images into its own staging directory. Any failure removes every staging directory and refuses with nothing filed.
- **File (per card, in order):** pick or create the bead, place the images, update, comment, add the dep.

`prepare` runs once: one `bd show`, and one `bd list` of the open review children with their metadata. The notification, Chrome, and the closing instructions run once after the loop. They are moved out of `write` into the caller.

*Alternative:* invoke the existing single-card flow N times (a loop around `requestReview`). Rejected: N notifications, N Chrome probes, N "end your turn" lines, and no up-front validation of the whole set.

### 2. Keys: frontmatter `key`, else the filename stem; matched in JavaScript

`key` joins the card's top-level keys in the CLI validator and is written into `metadata.review.key`.
- A frontmatter key is validated, not slugged, so the agent sees exactly what it set.
- A stem is slugged under the spec's rule, and refused if nothing valid is left.

`chooseReview(children)` becomes `chooseReview(children, key, { single })`, which returns `{ review, count, keylessLeft }`. `keylessLeft` names the keyless open children a multi-card call didn't take, for the warning. Matching reads `child.metadata.review.key` from the `bd list --json` output, which already carries metadata, so no extra bd call is needed.

The core normalizer gains `key` under the same pattern. A bad key is a structural break, so the review is invalid, as for option ids. The CLI mirrors it, and fixtures gain keyed variants and an invalid-key variant.

*Alternative:* identify a review by its question. Rejected: rewording a question during "changes requested" would orphan the old review and file a new one.

*Alternative:* bd's own external ref or a label per key. Rejected: labels are a shared namespace the board reads (`review`, `review:changes`), and metadata already holds everything about a review.

### 3. Keyless reuse only when it can't be ambiguous

A single-card call, or the image form, with no key match reuses the newest keyless open review. That is today's behavior, and every review filed before this change is keyless. A multi-card call never takes a keyless review, because it can't tell which card the old review was for. It warns instead, naming the review so the agent can close it or re-file it with a key.

The image form also skips keyed children. Its reuse set is "keyless open children", so it can't overwrite a card review.

### 4. Card review title = question; reuse updates the title

`bd create --title "Review: <question>"`, cut to 120 characters. On reuse, `bd update --title` is sent when the stored title differs. The image form keeps `Review: <item title>`.

This changes how a single card review is titled. Nothing reads the title as identity: the board keys on bead id, and the pane prompt names the id.

### 5. Parent on pending reviews: the board's lateral join, copied into the queue statement

`listPendingReviews` adds the same `LEFT JOIN LATERAL` parent resolution `getBoardItem` uses. It is scoped per row to the row's own project (`p.metadata->>'project' = n.metadata->>'project'`), and returns `parent_id`, `parent_external_id`, `parent_title`. `PendingReview.parent` is `{ id, externalId, title } | null`, and `PendingReviewDto` passes it through.

The join probes `edges_src_id_edge_type_idx` once per row, and the queue is capped at 100 rows.

Extract the lateral's body into one SQL fragment builder in `board.ts`, `childOfParentLateral(itemRef, projectExpr)`, shared by both statements. Two copies of the tie-break order would drift.

*Alternative:* the client resolves parents through `boardItem` per row. Rejected: N reads for a list that's already one statement.

### 6. `groupByWork` groups by a work id taken from either row kind

`QueueReviewRow` gains `parent: { id, title } | null`. The group key function becomes:
- `row.kind === "inbox"` → `row.item.about`;
- `row.kind === "review"` → `row.review.parent`.

Both are canonical `work_item` node ids, which is what lets a review and an inbox item about the same work group together. Everything else in `groupByWork` (place of the first member, order kept, groups of two or more) is unchanged, and `needsMeRows` passes the parent through.

### 7. Steering is text in two places

- `USAGE` puts `review-request <item-id> <card.md>... [--board-url <url>]` first. `--help` adds three lines: one decision per card; several decisions are several cards in one call; text, tables, and code go in the card, never in an image.
- The two budget refusals (question length and body words) append the split hint. The image form's 280-character warning names the multi-card form.

Nothing else inspects wording.

## Risks / Trade-offs

- **[Renamed card file files a second review]** With no frontmatter key, renaming `card.md` to `card-v2.md` gives a new key, so a re-request files a sibling instead of replacing. → Mitigation:
  - The success output lists every open review under the item with its key, so the agent sees the sibling.
  - `--help` says to keep a card's filename, or set `key`, across revisions.
  - A single-card call still takes a keyless review, so old reviews aren't stranded.
- **[Partial filing]** bd writes can't be wrapped in a transaction, so a failure partway leaves some reviews filed. → Mitigation: keys make the re-run idempotent, and the message says which were filed and to re-run.
- **[Six reviews at once is a lot of pane prompts]** Each decision prompts the pane separately. → Accepted: that is the point, each answered on its own. The cap of six bounds it.
- **[Title churn]** A card review's title now follows its question, so `bd list` output changes for reviews refiled after this lands. → Accepted, since nothing keys on titles.

## Migration Plan

No data migration. Existing reviews are keyless and keep working through decision 3. Rollback is reverting the commits: keyed reviews then read as keyless (older normalizers drop the unknown key), and the next single-card call reuses the newest open review as before.
