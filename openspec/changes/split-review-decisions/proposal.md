## Why

Sessions bundle several decisions into one review and render the bundle to an image. Of the shlo reviews on 2026-11-11, every one was a markdown note rendered to `01-card.png` and filed through the image form, often with a composited contact sheet beside it. `shlo-btp.1.1`, "Launch a new city: 4 decisions", put four option tables in one PNG behind one Accept. The person can't read it on a phone, copy from it, or answer one of the four without the others.

Two things push agents there:
- **One open review per item.** `review-request` reuses the newest open review under an item (`bin/review-request-lib.mjs`, `chooseReview`), so a second decision filed for the same item replaces the first. The only way to ask four things is to ask them at once.
- **A card holds one decision.** Its 140-character question and 300-word evidence budget are right for one decision and too small for four. The image form has no budget, so the bundle goes there.

The prompt that caused the PNGs has been fixed. The shlo brief and `~/.claude/skills/context/visual-review.md` now say one decision per card and never render text to an image, and `decision-card.mjs` is retired. The tool still makes the right thing awkward, though: two decisions for one epic need two hand-made parent beads.

## What Changes

- **One call, several cards.** `review-request <item-id> a.md b.md …` files one review per card under the item. Each review gets its own Accept, its own pane prompt, and its own blocking edge on the item.
  - Every card is validated, and every image staged, before any bead is created.
  - One notification and one board link cover the call.
- **A review is identified by its key, not by being newest.**
  - Each card has a `key`: from its frontmatter, else its filename stem. The key is stored in the review's metadata.
  - Re-running replaces the open review under the item with the same key.
  - A keyless open review (every review filed before this change, and every image-form review) is still reused by a single-card or image-form call, exactly as today. A multi-card call leaves it alone and says so.
- **Card titles name the question.** A card review's bead title becomes `Review: <question>`, so sibling reviews are distinct on the board and in bd. Image-form titles are unchanged.
- **Split decisions show together.**
  - The pending review queue carries each review's parent work item (`child_of`, one hop, as the board item read already resolves it).
  - The inbox's Needs me groups review rows by that parent, the same way it groups inbox items `about` a work item. A review and an inbox item about the same work item land in one group.
- **The CLI leads with cards.**
  - `USAGE` and `--help` show the multi-card form first and say: one decision per card, several decisions are several cards, never an image of text.
  - The refusals for an over-long question or an evidence body over budget suggest splitting into several cards, with the command line to do it.
  - Steering is structural only. Nothing scans the summary's wording or image filenames.

Rejected:
- **One card holding several questions** (a `decisions:` list with one Accept each). It needs a new card shape, a new decision endpoint, and new layouts in the drawer and the Review all run. Several ordinary reviews reuse all of that unchanged.
- **Agents create a child decision bead per question by hand, then one review each** (what the shlo brief now says). It works today but costs an extra bead and an extra command per decision, and agents skip it. This change makes it one command.
- **Inbox batches** (a parent inbox item with candidate children). That is the inbox's own model, for triaged signals. Reviews belong to beads, the work of record, and notify the requesting pane. Grouping by parent work item gives the same "seen together, answered separately" result while keeping each store's model.
- **Warning on phrases ("Decide", "Rec:") or image names (`*card*.png`).** unify-review-queues rejected prose heuristics for the digestion gate: they're brittle and teach agents to stop admitting it. The structural limits already exist (the image form has no options, and the card has budgets); this change makes the way out of them obvious.

## Capabilities

### New Capabilities
- `review-decision-sets`: several reviews under one item, filed in one call and identified by key. It covers the multi-card `review-request` form, key-based reuse with today's behavior for keyless reviews, the question as a card review's title, the parent on pending review rows, Needs me grouping of reviews by parent, and the card-first usage and split-suggesting refusals.

  It builds on `board-reviews` (board-visual-reviews), `decision-cards` (decision-card-reviews), `review-queue`, and `decision-queue` (unify-review-queues). None of these is archived.

### Modified Capabilities
None in `openspec/specs/`. The review requirements this change builds on still live in unarchived changes.

## Impact

- **Core:**
  - `packages/core/src/reviews.ts`: optional `key` in the review contract, validated, absent when missing, idempotent.
  - `packages/core/src/review-queue.ts`: `parent` on `PendingReview`.
- **CLI:** `bin/review-request-lib.mjs` handles the multi-card form, key matching in place of `chooseReview`, and a key in the validator that mirrors the core normalizer. Its usage text and refusal messages change too. Fixtures are added under `fixtures/review-cards/`.
- **Server:** the review queue DTO carries `parent`.
- **Web:**
  - `apps/web/src/lib/inboxRows.ts`: `QueueReviewRow.parent`, and `groupByWork` groups review rows by it.
  - `InboxView.tsx` passes the parent through.
  - The board, drawer, pill, and Review all are unchanged. Siblings filed in one call are already adjacent in the run, because the queue is ordered by request time.
- **Docs:** README "Visual reviews". After apply, `~/.claude/skills/context/visual-review.md` drops its "one item holds one open review" workaround (outside the repo).
- **No** migration, environment variable, model call, or new dependency. `node_type` is unchanged.
