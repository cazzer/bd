## Why

ShopLocal's Reels tooling (shlo `shlo-jil`) generates vertical 1080×1920 MP4s, 10–60 s and typically 5–40 MB, that Caleb must approve before they post. Decisions go through the board's decision cards. Cards carry `image`, `mermaid`, and `diff` attachments and nothing that moves, so a reel review today means opening files by hand outside the board. The common decision is "which cut": two or three alternates of the same reel, one per option.

## What Changes

- **A `video` attachment kind.** `{ kind: video, path, poster?, caption?, pair?, option? }`, with `path` and `poster` relative to the card. mp4 and webm only, at most 200 MB each. `review-request` stages videos and posters exactly as it stages images, and both validators (the CLI's strict one and `normalizeReviewMetadata`) agree on the contract, pinned by a fixture.
- **Per-option cuts.** A video may name an option (`option: A`). The board lays every option's video out side by side, in card order, headed by the option's badge and label. Options keep their shape (`id`, `label`, `what`, `risk`), so the inbox card contract and `seen` are untouched.
- **A vertical player.** Inline 9:16, muted, click-to-play with native controls, a Loop toggle (on by default, as Reels play), the poster when given, and an Enlarge button opening the existing lightbox, which keeps the playback position both ways.
- **Byte ranges.** `/review-images/` serves `.mp4`/`.webm` with their content types and answers `Range` with 206 / 416 under the same confinement guard. Safari will not play a `<video>` without it.
- **Timestamped notes.** A "Note 0:07" button beside each player, while the decision is open, appends the player's time (and the option id, for a per-option cut) to the changes-requested message. The message already travels intact (`:` is not escaped; the 3,968-character cap refuses rather than truncates).

Rejected:
- **A `video:` field on an option.** Options feed `seen`, the `option-changed` check, and the inbox card contract; attachments already own staging, stored paths, URL mapping, and rendering. A grouping key on the attachment follows `pair`.
- **Autoplay on hover.** It fights the native scrubber, does nothing on touch, and starts both cuts as the pointer crosses them.
- **`.mov`.** Chrome is unreliable with `video/quicktime`; the refusal prints the lossless remux command.

## Capabilities

### New Capabilities

- `review-videos`: video attachments on decision cards — the contract, staging, serving with byte ranges, the board's player and side-by-side cuts, and timestamped notes.

## Impact

- `packages/core/src/reviews.ts` (+ `index.ts` export), `bin/review-request-lib.mjs`.
- `apps/web/server/review-images.ts`, `apps/web/server/dto.ts`.
- `apps/web/src/lib/reviewAttachments.ts`, `components/ReviewAttachments.tsx`, `Lightbox.tsx`, `ReviewItemPanel.tsx`.
- `fixtures/review-cards/` (a `reel-cuts` card with ~55 KB of sample video; `invalid-unknown-kind.md` moves from `video` to `pdf`), repo README.
- Outside the repo: `~/.claude/skills/context/visual-review.md` documents `kind: video`.
