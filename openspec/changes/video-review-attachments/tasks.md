## 1. Media route serves video with byte ranges

- [x] 1.1 `apps/web/server/review-images.ts`: `.mp4`/`.webm` content types and served-name pattern; refusal reason "Not a review image or video"; `.mov` and other extensions 403; same guard order (design.md decision 4)
- [x] 1.2 Exported `parseByteRange(header, size)`; `Accept-Ranges: bytes` always; 206 with `Content-Range` and a ranged stream; 416 with `Content-Range: bytes */size`; HEAD gets headers only; header comment updated
- [x] 1.3 `review-images.test.ts`: the `parseByteRange` table (`0-1`, `5-`, `-3`, `-0`, past end, reversed, multi-range, garbage, size 0, over 15 digits); over HTTP 206 / 416 / 200 with `Accept-Ranges` / HEAD with range; content types; `.mov` 403; an `.mp4` symlink out of the root 403

## 2. Video in the card contract, through to the board item

- [x] 2.1 `packages/core/src/reviews.ts`: `video` kind, `ReviewVideoAttachment` (key order `kind, path, poster, caption, pair, option`), `option` checked against the card's option ids and unique across videos, `option`+`pair` invalid; `index.ts` export; module header (design.md decisions 1, 3)
- [x] 2.2 `bin/review-request-lib.mjs`: `VIDEO_EXTENSIONS`, `MAX_VIDEO_BYTES`, `videoProblem`, video and option validation with the refusal strings in specs/review-videos, staged-file numbering, `stageFiles`, closing line counts videos, header comment (design.md decisions 2, 3)
- [x] 2.3 Fixtures: `reel-cuts.md` with `reel-a.mp4` (+ `reel-a-poster.jpg`, option A), `reel-b.mp4` (option B), `reel-raw.mp4` (no option), all ffmpeg-generated 270×480 under 100 KB total; `reel-cuts.expected.json`; `invalid-unknown-kind.md` → `pdf`; `invalid-video-option-unknown.md`, `invalid-video-extension.md`; fixtures README tables and rules
- [x] 2.4 `apps/web/server/dto.ts`: video `name`, `url`, `posterUrl`; `apps/web/src/lib/reviewAttachments.ts`: `VideoAttachment` mapping with `?v=`, `optionVideos`, `formatVideoTime`, `timestampNote`, `appendNote`; a basic video renderer and the `PairAttachments` video branch so typecheck passes
- [x] 2.5 Tests: core (`reel-cuts` idempotence, each invalid case, `option`/`poster` dropped on images, legacy byte-identical), CLI (fixture loop, every stored path staged, `videoProblem`, refusal strings, NN ordering), dto, `reviewAttachments`
- [x] 2.6 `pnpm check` passes, apart from known failures (`bd-a0r`, 5-second DB timeouts)

## 3. Reviewing a reel on the board

- [ ] 3.1 `ReviewAttachments.tsx`: the `ReviewVideo` player (9:16, muted, `playsInline`, `preload="metadata"`, controls, Loop toggle default on, Enlarge button, unavailable state) and the Videos slot (design.md decision 5)
- [ ] 3.2 The options side-by-side slot ahead of pairs, in card order, with badge, label, and Recommended chip, in both layouts (design.md decision 6)
- [ ] 3.3 `Lightbox.tsx`: video items, `startAt`, `onClose(time)`, no arrow-key stepping from a `<video>`, labels; inline player syncs time both ways (design.md decision 7)
- [ ] 3.4 `ReviewItemPanel.test.ts` with `reel-cuts.expected.json`: cells A then B with labels, plain video in the Videos slot, poster, `muted`/`controls`/no `autoplay`, Loop flips `loop`, Enlarge opens a dialog with a `<video>` and reports its overlay

## 4. Timestamped notes and live check

- [ ] 4.1 `ReviewItemPanel.tsx`: pass `options`, `recommend`, `onTimestamp` into `ReviewAttachments`; Note appends via `appendNote` and focuses the message; no Note once decided (design.md decision 8)
- [ ] 4.2 Tests: Note at `currentTime = 7.4` appends `A 0:07 `, a second note goes on a new line, no button on a decided review
- [ ] 4.3 Repo README "Visual reviews": `kind: video`, `option`, `poster`, mp4/webm under 200 MB, `-movflags +faststart` recommended
- [ ] 4.4 Live check: curl a stored video with `Range: bytes=0-1` through the API and the Vite proxy (206); file `reel-cuts.md` against a bead; A and B side by side, enlarge and time sync; a two-line timestamped changes-requested message arrives in the pane intact
