## 1. Relative stored paths in the contract and the DTO

- [x] 1.1 `packages/core/src/reviews.ts`: `isReviewImagePath` also accepts a relative path of safe segments (at most 512 characters, no control characters); header and path/poster doc comments (design.md decision 4)
- [x] 1.2 `reviews.test.ts`: the old relative rows become invalid `..`, `./`, `a/../b`, backslash, and `a//b` rows; a remote path normalizes to itself
- [x] 1.3 `apps/web/server/review-images.ts`: `reviewImageUrl` joins a relative path onto the root and checks containment, never rebasing it; `CONTENT_TYPES` exported; tests for an encoded relative URL and `../x.png` → null; a dto test for a remote review's image, video, and poster URLs

## 2. The upload route

- [x] 2.1 `apps/web/server/review-uploads.ts`: `parseUploadTarget`, `createReviewUploadHandler` (PUT and DELETE, the checks and refusals in design.md decision 3, atomic write), `MAX_REVIEW_UPLOAD_BYTES`; header comment listing the check order
- [x] 2.2 `dispatch.ts`: the `reviewUploads` route, `routeFor` prefix, `human`/`agent` policy, handler option and case, header; `index.ts` wires it on the media root
- [x] 2.3 `review-uploads.test.ts` over real HTTP: the `parseUploadTarget` table; PUT 204 with modes and no tmp; re-PUT replaces; Content-Length and chunked over the cap 413; Content-Type 415; symlinked project 403; file in the way 409; DELETE removes, missing 204, file 409, symlinked parent 403; 503 past `maxConcurrent`; 507; GET 405; the cap pinned to the CLI's `MAX_VIDEO_BYTES`
- [x] 2.4 `dispatch.test.ts`: an agent token reaches uploads and is 403 on `/review-images/`; a hangar token 403; tokenless loopback admitted; foreign Origin 403

## 3. Uploading from review-request

- [x] 3.1 `bin/review-request-lib.mjs`: `uploadFiles` after `check()` and before any `bd create`, `deleteRun`, `previousRuns`, `MEDIA_TYPES`, `UPLOAD_TIMEOUT_MS`; the remote branch in `fileOne` (commit after `bd update`, then remove earlier runs); best-effort cleanup of uncommitted runs; header paragraph (design.md decision 5)
- [x] 3.2 Tests: a remote image form (PUT URLs, headers, and bodies before `bd create`; relative paths; nothing local; no token in output); a failed second upload (refusal, no bd writes, one DELETE); a failed `bd create` (DELETE); reuse removes only this item's earlier run, and a failed removal warns with exit 0; a card's video and poster types and paths; the `previousRuns` table

## 4. Docs

- [x] 4.1 README: the agent scope reaches `/review-uploads/` and never `/review-images/`; remote filing uploads instead of copying; the media volume needs seeding only for older reviews, and a Mac-local board can't show remote-filed ones
- [x] 4.2 CLAUDE.md: an agent token's reach includes review media uploads

## 5. Live check (bd-d38.10, under the hardware lock)

- [ ] 5.1 `pnpm smoke:app`, extended: an agent-token PUT gets 204, then a human GET of it gets 200 (uid 1000 writes under the read-only root)
- [ ] 5.2 From the Mac, file `fixtures/review-cards/reel-cuts.md` against the Jetson; the board plays both cuts with Range; a re-run removes the old run; an old Mac-path review still renders; a near-200 MB upload over the tailnet finishes within 300 s
