## 1. The contract: limits, paths, and the decision input

- [x] 1.1 `packages/core/src/reviews.ts`: `MAX_DECISION_IMAGES` (6), `MAX_DECISION_IMAGE_BYTES` (10 MB), `DECISION_IMAGE_TYPES` (png/jpg/jpeg/gif/webp), `decisionImagePathPattern(project, item)`, and `decisionCommentImagesBlock(paths)`; tests for the pattern (own item ok; another item, `..`, a video, an absolute path refused)
- [x] 1.2 `packages/core/src/relay.ts`: `reviewDecisionPayloadSchema` gains optional `images` (the same pattern, at most 6); tests for a payload with and without images, and one with another item's path refused
- [x] 1.3 `apps/web/server/routers/review.ts`: `images` in `reviewDecisionInputSchema`; before writing or queueing, check each path under the media root (no symlink on the path, a regular file) and the comment budget (design.md decisions 2 and 3); pass the paths into the relay payload; router tests for each refusal naming the path, and for a decision without images unchanged

## 2. Recording and notifying

- [x] 2.1 `apps/web/server/review-writer.ts`: the write takes `imageFiles` (absolute) and `imagePaths` (relative); the comment ends with the `Images:` block; the prompt appends ` Images: ` and the absolute paths; header comment updated; writer tests: changes and accept with images give the exact comment and prompt text, no images gives today's text byte for byte
- [x] 2.2 The local path: the router resolves media root + relative path into `imageFiles` and calls the writer; one end-to-end router test with a fake `bd` and `herdr` that sees both texts

## 3. The relay media endpoint and download

- [x] 3.1 `apps/web/server/relay-api.ts`: `GET /relay/v1/actions/:id/media/:n` (design.md decision 4): 200 with bytes, content type, and `Cache-Control: no-store` only for the holder of a claimed `review_decision` with that index; 404 for queued, finished, another relay's, a bad index, or a missing file; agent and hangar tokens 403; tests for each
- [x] 3.2 `apps/web/server/relay/client.ts`: a binary `get` (same token, timeout, and error handling as `send`); `bin/relay.mjs` and `relay-lib.mjs`: `--media-dir` (default `~/.local/share/breakdown/relay-media`, created 0700); arg tests
- [x] 3.3 `apps/web/server/relay/execute.ts`: download every image to `<media-dir>/<action id>/` (temp then rename) before the writer runs; any failure removes the directory and reports `failed: could not fetch image <n>: <reason>`; execute tests for success (writer gets the local paths), a 404 mid-way (nothing written, directory gone), and a decision without images (no fetch)
- [x] 3.4 `docs/relay.md`: the endpoint, the payload's `images`, `--media-dir`, and the deploy order (relay before server)

## 4. The board: paste, drop, upload

- [x] 4.1 `apps/web/src/components/DecisionCard.tsx`: paste (`clipboardData.files`, text paste untouched) and drop on the message box; the type, size, and count checks with a message per refused file; thumbnails (object URLs, revoked on remove and unmount) with a remove button; no character counter exists, so the panel refuses a message too long to fit beside its images before uploading, saying how many characters to cut; component tests for paste of two images, a refused PDF, the seventh image, and remove
- [x] 4.2 `apps/web/src/components/ReviewItemPanel.tsx`: on send, PUT each image to a new run (design.md decision 1), then mutate with the paths; any failed PUT deletes the run, sends nothing, and shows which image failed and why, keeping message and thumbnails; tests with a mocked fetch for success, a 507 on the second image, and no images (no PUT)
- [x] 4.3 Run the app (`pnpm dev`), paste two screenshots and drop one onto a review card, request changes, and check the bead comment and the herdr prompt; capture the card with thumbnails for the PR's Evidence

## 5. Checks

- [x] 5.1 `pnpm check` green; `openspec validate review-decision-images --strict` passes
