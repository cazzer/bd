## Why

The board is moving to the Jetson (bd-d38.10). `review-request` can already file against a remote Breakdown (`BREAKDOWN_API`, bd-d38.12), but it still copies a review's images and videos under `~/.local/share/breakdown/reviews/` on the machine that ran it. A board on another host can't serve those files, so a remote review shows its question and no media. This is bead bd-d38.6.

## What Changes

- **An upload route.** `PUT /review-uploads/<project>/<item-id>/<run>/<NN-name>` writes one file, with a raw body, into the server's media root. `DELETE /review-uploads/<project>/<item-id>/<run>` removes one run. The route checks the raw path shape, the extension and its Content-Type, a 200 MB cap, concurrency, free space and inodes, symlinks, and the run's owner. It writes atomically and never replaces a file (tmp file, fsync, link). `BRAIN_READ_ONLY` refuses it.
- **Relative stored paths.** With `BREAKDOWN_API` set, `review-request` uploads every file after its checks and before any `bd create`, and stores `<project>/<item-id>/<run>/<NN-name>`. The server resolves that path against its media root. The review contract accepts these relative paths beside absolute ones, so reviews filed before this change still render.
- **Refresh cleanup.** A run whose `bd update` never landed is deleted on the way out. When a review is refreshed, its earlier runs are deleted once the update lands. Both deletes are best-effort, and a failure only warns.
- **Agent scope.** `agent` tokens reach `/review-uploads/`, because a worker files its own media. Reading media at `/review-images/` stays `human`-only.

Without `BREAKDOWN_API`, nothing changes: files are copied locally and absolute paths are stored.

Rejected alternatives:
- **Media in Postgres.** This puts up to 200 MB rows in the graph store, makes backups heavy, and needs a Range-capable reader over a bytea. The filesystem already serves byte ranges.
- **A per-bead-id directory plus a commit step.** The review id doesn't exist until `bd create`, and uploading after it means a filed review can briefly lack media. A rename-to-commit step on the server would add a second endpoint and a staging state to clean up.
- **Content addressing.** It dedupes nothing that matters here (one review's cuts differ), and it needs reference counting before anything can be deleted.
- **PUT on `/review-images/`.** Admission scopes are per route, and `routeFor` is path-only. Sharing the prefix would either let `agent` tokens read every review's media or keep workers from uploading.

## Capabilities

### Modified Capabilities

- `board-reviews`: a review's image paths may be relative to the server's media root.
- `review-videos`: video and poster files are uploaded when filing remotely, under the same cap.
- `local-web-api`: adds the review media upload route.
- `client-access`: `agent` tokens also reach `/review-uploads/`, and never `/review-images/`.

## Impact

- `packages/core/src/reviews.ts`: the image path rule.
- `apps/web/server/review-uploads.ts` (new), `review-images.ts` (`reviewImageUrl` relative branch, exported `CONTENT_TYPES`), `dispatch.ts`, `index.ts`.
- `bin/review-request-lib.mjs`: uploads, run cleanup, `previousRuns`.
- README (token scopes, remote filing, the media volume), CLAUDE.md (agent reach).
