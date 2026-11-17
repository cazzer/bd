## Context

- **Deciding.** `DecisionCard.tsx` renders the message `<textarea>`; `ReviewItemPanel.tsx` sends `trpc.reviewDecision.mutate({ project, item, decision, message, option?, seen? })`. `routers/review.ts` validates (`reviewDecisionInputSchema`), then either runs the review writer (server has `bd`) or queues a `review_decision` relay action (`enqueueRelayAction`, payload schema in `packages/core/src/relay.ts`).
- **Writing.** `review-writer.ts` runs `bd comments add <id> <text>` with a fixed prefix (`Changes requested: ` / `Accepted: <option> — `) and the message (at most `MAX_REVIEW_DECISION_MESSAGE_LENGTH`, 4000 − 32), then labels or closes, then `herdr agent prompt <pane> "Review <id> …"`.
- **Media.** `PUT /review-uploads/<project>/<item>/<run>/<name>` (`human` and `agent`, run owners, 409 on an existing name, 413/415/507 refusals) writes under the media root; `DELETE /review-uploads/<project>/<item>/<run>` removes a run; `GET /review-images/<rel>` is `human`-only. The board's browser authenticates with the HttpOnly cookie, so same-origin `fetch` carries it.
- **Relay.** The relay (`apps/web/server/relay/`) claims actions over `/relay/v1/`, re-parses the payload, and runs the same review writer locally. Its `client.send` speaks JSON only.

## Goals / Non-Goals

**Goals:**
- Paste and drop on a plain-HTTP board, on desktop browsers.
- Nothing is recorded when an upload or a relay download fails.
- A decision without images behaves exactly as today.

**Non-Goals:**
- Cleaning up runs left behind by a closed tab between upload and send.
- Image editing, cropping, or annotation.
- A phone-specific attach button (iOS paste into the box still works where the OS offers it).

## Decisions

### 1. Upload from the browser, then send paths

The board PUTs each image to `/review-uploads/` and sends only the relative paths in `reviewDecision`. The run is `d-<UTC yyyymmddHHMMss>-<4 random base36>` (matches the route's segment rule), names are `NN-<slug>.<ext>` with the slug from the file name or `screenshot`. On any failure the board DELETEs the run (best effort) and does not mutate.

Alternative rejected: base64 images in the tRPC mutation. It would bypass the upload route's disk, type, and owner checks and blow the relay's 64 KiB payload limit.

### 2. The server re-checks every path

`reviewDecisionInputSchema` gains `images: z.array(path).max(6).optional()`. A path must match `^<project>/<item>/[A-Za-z0-9][A-Za-z0-9._-]{0,254}/[A-Za-z0-9][A-Za-z0-9._-]{0,254}\.(png|jpe?g|gif|webp)$` with the request's own project and item, and the handler `lstat`s each segment under the media root (no symlink, a regular file at the end) before writing anything. The pattern and the 6 / 10 MB limits live in `packages/core/src/reviews.ts` so the client, the router, and the relay payload schema share them. The 10 MB cap is the client's; the server trusts the upload route's own 200 MiB cap.

### 3. Comment and prompt text

The comment is the existing prefix and message, then `\n\nImages:\n` and one relative path per line. The whole comment stays within `MAX_REVIEW_COMMENT_LENGTH` (4000): with images, the router refuses a message that, with the images block, would exceed it, saying how many characters to cut. Real paths are ~60 characters, so six images cost ~400 and the limit only bites on a near-4000-character message. Alternative rejected: raising the comment limit, which every reader of review comments assumes. The prompt is the existing text, then ` Images: ` and the absolute paths separated by spaces. The writer takes an `imageFiles` list of absolute paths from its caller (the router: media root + relative path; the relay: its downloads), so it never resolves paths itself.

### 4. A relay-scoped media endpoint

`GET /relay/v1/actions/:id/media/:n` is added to `relay-api.ts`: `relay` scope; it loads the action, and answers only when `kind = review_decision`, `state = claimed`, `claimed_by` is this token's client, and `n` indexes `payload.images`. It then opens the file with the same checks as decision 2 and streams it with the extension's content type and `Cache-Control: no-store`. Anything else is a bare 404.

Alternatives rejected: letting `relay` tokens read `/review-images/` (any review's media, not just held decisions'); embedding the bytes in the claim response (64 KiB JSON limit, and every claim would carry them).

### 5. The relay downloads before it writes

`execute.ts`'s `reviewDecision` downloads each image to `<media-dir>/<action id>/<name>` (a new `--media-dir` flag on `bin/relay.mjs`, default `~/.local/share/breakdown/relay-media`, created 0700) through a new binary `client.get`, writing to a temp name and renaming. Any failure deletes `<action id>/` and reports `failed: could not fetch image <n>: <reason>`. Only then does it run the writer with the downloaded paths. A re-claim (a lost report) overwrites the same directory.

## Risks / Trade-offs

- [Orphaned runs when the tab closes mid-send] → the run stays on disk, owned by the person; acceptable at this volume, same as `remote-review-media`'s non-goal.
- [A long message plus images exceeds the comment limit] → refused with how much to cut; the board checks it before uploading and says the same.
- [Relay media dir grows without bound] → files are small and per decision; a sweep is a follow-up, not this change.
- [Clipboard paste of images varies by browser] → spec only promises what `ClipboardEvent.clipboardData.files` gives; Chrome, Safari, and Firefox all expose pasted screenshots there.

## Migration Plan

No migration. The payload's `images` is optional, so an older relay that re-parses with `strictObject` would refuse a payload carrying it: ship the relay (the Mac) before the server (the Jetson), and an older relay keeps working for decisions without images.
