## Why

A review today is images plus a free-text summary shown as plain text, and `review-request` refuses without an image — so agents asking for a decision that is not visual screenshot a markdown card (shlo-k54.4.1.1's `01-card.png`: a question, two tables, options A/B/C with risk, a migration diff, "On accept I will"). The reviewer then reads a picture of text, the recommendation is a row in a table, and Accept carries no record of which option was chosen. Epic `bd-4zn`; the contract below was picked on 2026-11-05 over sectioned markdown and a plain markdown body, with the goal of high-quality decisions made quickly.

## What Changes

- A **decision card**: the review metadata gains a typed, decision-shaped `question` (at most 140 characters), optional `options` (`id`, `label`, `what`, `risk`), a `recommend` option id, an `on_accept` list, and `attachments` of kind `image`, `mermaid`, or `diff`, each optionally marked `before` or `after` so a pair renders side by side. Normalized at every writer like the work-item contract, never by the database; a malformed card never fails a tracker's load. The existing `{ images, summary }` review keeps normalizing and reads as a question-only card.
- **Markdown evidence**: the bead description is the card's evidence body, rendered by the app's read-only Tiptap renderer, which gains GFM tables and `mermaid` / `diff` fenced blocks. Mermaid (ERDs included) is a lazily loaded chunk.
- **`review-request <item> <card.md>`**: one markdown file whose YAML frontmatter holds the card and whose body is the evidence; validated before anything is filed, refused naming the field; images become optional. The `--summary <text> <image>...` form is unchanged.
- **Decisions name an option**: the drawer and the Review all run show the question first, the recommendation without scrolling, evidence collapsed, and offer "Accept <recommended>", "Choose <other>" for each other option, and "Request changes". The chosen option id is written into the tracker comment and the agent's prompt (`Review <id> accepted: B — <message>`).
- The card layout is chosen from 2–3 prototypes through a visual review under `bd-4zn` before the card UI is built.
- `~/.claude/skills/context/visual-review.md` (outside the repo) is updated: architecture and other human-in-the-loop decisions use the card; images only for what must be seen; never screenshot text.

Rejected: sectioned markdown parsed by headings (the recommendation and options stay prose the drawer cannot act on); a plain markdown body (no typed recommendation, so Accept still means nothing specific); rendering mermaid server-side to images (a headless browser in the write path, and the source stops being reviewable text); JSON frontmatter (correct but hostile to write by hand; YAML is what agents already emit).

## Capabilities

### New Capabilities
- `decision-cards`: the decision-card review contract, its markdown evidence, the `review-request` card form, how the drawer and the run present a card, and how a decision names the chosen option. It narrows `board-reviews` (board-visual-reviews) and `review-queue` (review-queue), both unarchived; archive those first.

### Modified Capabilities
None in `openspec/specs/` — the review requirements this change extends still live in unarchived changes.

## Impact

- `packages/core/src/reviews.ts` (contract, normalizer, tests), `beads.ts` (mapper), `review-queue.ts` (queue line reads the question).
- `bin/review-request-lib.mjs` and tests: card form, frontmatter validation; the root `package.json` gains the `yaml` package, imported only by the card form so the legacy form never loads it.
- `apps/web/server/routers/review.ts`, `review-writer.ts`: optional `option` on `reviewDecision`, checked against the tracker's record.
- `apps/web/src/components/MarkdownEditor.tsx` (+ table extension, mermaid/diff blocks), `ReviewItemPanel.tsx`, `ReviewAttachments.tsx`, `ReviewRunModal.tsx`, `ReviewQueue.tsx`; new `@tiptap/extension-table` and `mermaid` dependencies in `apps/web`, mermaid in its own chunk.
- No migration, environment variable, or model call; `node_type` unchanged.
