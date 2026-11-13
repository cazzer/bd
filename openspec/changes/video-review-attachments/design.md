## Context

- **Staging.** `bin/review-request-lib.mjs` resolves each image path against the card's directory, copies the files into `<review-root>/<project>/.staging-*` as `NN-<basename>` (NN 1-based by position), renames the directory to `<project>/<bead>/`, and writes the stored paths into the card's attachments and the legacy `images` list.
- **Serving.** `apps/web/server/review-images.ts` confines a request to the review root (lexical, then realpath), allows image extensions only, and always answers 200 with the whole file. No `Accept-Ranges`, `Range` ignored.
- **Enlarging.** `Lightbox.tsx` is a native `<dialog>` showing `<img>` items with arrow-key stepping; image slots report open overlays to `ReviewItemPanel`.
- **Decisions.** `reviewDecision` refuses control and bidi characters, trims, caps at 3,968 characters, then `bd comments add` and `herdr agent prompt` through `execFile` (argv, no shell). Nothing escapes `:`.

## Goals / Non-Goals

**Goals:** approve a reel, or pick between cuts, without leaving the board; one contract shared by both validators; Safari and Chrome both play and seek.

**Non-Goals:** transcoding or probing video content (extension only, as images); a total size cap per card; adding videos to `seen` (the stored path is stable, so it would detect nothing); timestamps on the server side (a note is plain message text).

## Decisions

1. **`option` on the attachment, not a field on the option.** See proposal. Invalid when it names no option, the card has no options, two videos name one option, or it is set with `pair`.
2. **Extensions mp4/webm, 200 MB each.** The CLI refuses past the cap naming the size in MB; `.mov` gets a remux hint. The normalizer checks only path shape, as for images; the route refuses other extensions with 403.
3. **Staging numbers count staged files.** NN is the 1-based position among every staged file in attachment order — an image path, a video path, then that video's poster. Image-only cards number exactly as before, so every existing `expected.json` stands. The legacy `images` list stays images only.
4. **Single-range support in the existing route.** `parseByteRange(header, size)` → `{start,end}` | `"unsatisfiable"` | `null`. `a-b`, `a-`, `-n` are parsed; start past the end, `-0`, or an empty file is 416 with `Content-Range: bytes */size`; malformed, reversed, or multi-range headers are ignored and the whole file is served (RFC 9110 permits this). `Accept-Ranges: bytes` always. The URL prefix keeps its name; renaming breaks open tabs and buys nothing.
5. **Click-to-play, muted, loop on, `preload="metadata"`.** A click on the video plays it; enlarging is a separate button (unlike images, where a click enlarges), so the native controls stay usable.
6. **Side by side lives in the attachments slot.** An "options" slot ahead of pairs renders one cell per option that has a video, in card order (A left), the recommended one marked but not moved. Both layouts (column and stage) get it; `DecisionCard.tsx` is unchanged.
7. **Lightbox keeps the time.** Opening pauses the inline player and starts the enlarged one at its time; closing seeks the inline player to the lightbox's time, so the Note button stays right. Arrow keys don't step items while a `<video>` has focus.
8. **A note is text.** `timestampNote` gives `"0:07 "` or `"B 0:07 "`; `appendNote` puts each note on a new line. If herdr turns a multi-line prompt into several submissions, the separator becomes `"; "` (checked live in group 4).

## Risks / Trade-offs

- **Disk:** 20 × 200 MB per card at worst; APFS clones copies on the same volume. No total cap.
- **jsdom has no media playback:** panel tests stub `play`/`pause` and define `currentTime`.
- **Fixture binaries in git:** ~55 KB total, generated with ffmpeg `testsrc` at 270×480.
