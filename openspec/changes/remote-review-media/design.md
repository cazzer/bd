## Context

- **Filing.** `bin/review-request-lib.mjs` validates every card and file, runs `check()` (the `beadsProjects` lookup, `bd show`, and `bd list`), and stages the files in `<review-root>/<project>/.staging-*`. Then, per request, it runs `bd create` (or reuses a review), renames the staging directory to `<project>/<bead-id>/`, and runs `bd update` with the stored absolute paths. bd-d38.12 points the lookup at `BREAKDOWN_API` with a Bearer token, but staging is still local.
- **Serving.** `apps/web/server/review-images.ts` serves `GET /review-images/<rel>` from the media root (`--media-dir` in the container, else `~/.local/share/breakdown/reviews`). `reviewImageUrl` maps a stored absolute path to that URL, rebasing a host path from its last `.local/share/breakdown/reviews/` marker.
- **Admission.** `dispatch.ts` names a route from the raw path (`routeFor`), and each route has its own scope policy. `/review-images/` admits `human` only.

## Goals / Non-Goals

**Goals:**
- A review filed from the Mac against the Jetson shows its images and plays its videos there.
- Nothing is filed when an upload fails.
- Old reviews keep rendering.

**Non-Goals:**
- Garbage collection of orphaned runs or tmp files.
- A byte cap on images separate from the 200 MB file cap.
- Showing remote-filed media on a Mac-local board.

## Decisions

### 1. A separate prefix, with its own scopes

`/review-uploads/` is a new route beside `/review-images/`. `routeFor` is path-only and policies are per route, so a separate prefix is the only way to let a worker upload without also letting it read. The scopes are:
- `reviewUploads`: `human` and `agent`;
- `reviewImages`: `human` only, unchanged;
- `hangar` tokens: 403 on uploads;
- relay tokens (bd-d38.11): never this policy.

Host admission and the unsafe-methods Origin check apply as on every route, and a tokenless loopback request counts as `human`.

Because agents now write the files that `/review-images/` serves, its responses also carry `Content-Security-Policy: default-src 'none'; sandbox`, beside `nosniff` and `Cross-Origin-Resource-Policy: same-origin`. A stored file opened directly never runs as a page.

### 2. Per-run directories

Files go to `<project>/<item-id>/<run>/<NN-name>`. `<run>` is `randomBytes(6)` hex, fresh per request (per card):
- the review id isn't known until `bd create`, which runs after every upload;
- a closed review keeps its media, so runs are never reused;
- a refresh writes a new run, and the old one is deleted only after `bd update` lands, so the board never points at a half-replaced directory.

Each run has an owner. The request that creates a run writes the admitted client's name to `<run>/.owner`; a tokenless loopback request writes `(loopback)`, which no client name can be. A leading dot fails the segment rule, so no request can name the file. A PUT into an existing run, or a DELETE of one, is admitted for the same client or any `human`. Anyone else gets 403, and only a human may touch a run without an owner file. A PUT never replaces a file: a name that already exists is 409. The client never needs to replace one, and without both rules any `agent` token, a hangar worker's included, could swap the evidence in someone else's open review or delete it.

Only `<project>/<item-id>/<run>` shapes can be written or deleted. Legacy media sits at `<project>/<bead-id>/<NN-name>`, files one level shallower than a run's. A PUT through one of those files, or a DELETE that names one as a run, finds a file where a directory should be and is refused with 409. So legacy media can't be overwritten or removed.

### 3. Write path, limits, and refusals

Checks run in order on the raw path, which is never decoded:

| Check | Refusal |
| --- | --- |
| PUT with 4 segments, or DELETE with 3 | 405, `Allow: PUT, DELETE` |
| each segment `^[A-Za-z0-9][A-Za-z0-9._-]*$`, ≤ 255 characters | 400 |
| extension png/jpg/jpeg/gif/webp/mp4/webm | 415 |
| not `BRAIN_READ_ONLY` | 403 `read_only` |
| Content-Type (parameters ignored) is the extension's type | 415 |
| Content-Length ≤ 200 MiB | 413, `Connection: close`, nothing read |
| at most `maxConcurrent` (2) uploads in flight | 503, `Retry-After: 1` |
| free space minus Content-Length ≥ `minFreeBytes` (1 GiB), and free inodes ≥ max(1000, 1% of the volume's) | 507 (ENOSPC or a short write later is also 507) |
| each of the three directories is created or exists, with no symlink | 403 for a symlink, 409 for a file |
| realpath of the run equals realpath(root) joined with the segments | 403 |
| the run is new, or the requester owns it or is `human` | 403 |
| streamed body ≤ 200 MiB, chunked included | 413 |
| no file of that name in the run | 409 |

The byte reserve is shared: the media volume sits on the same disk as Postgres and the OS, so the 1 GiB floor protects them too, not just the uploads. A filesystem that reports no inode count (btrfs) skips the inode floor.

The body streams into `.<name>.<random>.tmp`, which is created exclusive with mode 0644, and every write's length is checked. The server fsyncs the file, links it to the target (no-clobber: EEXIST is 409), unlinks the tmp name, fsyncs the run directory, and answers 204. Each directory the request creates has its parent fsynced too. Any failure unlinks the tmp file and removes the directories this request created, while they hold nothing but their `.owner`.

DELETE runs the same segment, realpath, and owner checks. A missing run answers 204. Anything that isn't a real directory answers 409, and nothing is removed. Otherwise the run is removed recursively and the answer is 204.

Node's default `requestTimeout` (300 s) bounds each request. Headers and bodies are never logged. `MAX_REVIEW_UPLOAD_BYTES` must equal the CLI's `MAX_VIDEO_BYTES`, and a test pins the two together.

### 4. The stored path rule, and legacy compatibility

`isReviewImagePath` accepts an absolute path, as before, or a relative one matching `^[A-Za-z0-9][A-Za-z0-9._-]*(?:/[A-Za-z0-9][A-Za-z0-9._-]*)*$`. Both are bounded at 512 characters and refused with control characters. So `..`, `./`, `a//b`, and backslashes never pass.

`reviewImageUrl` joins a relative path onto the root and checks containment. It joins first because `isInsideReviewRoot` resolves against the cwd. A relative path is never rebased. Absolute paths keep the root check and the host-path rebase, so a review filed on the Mac before this change, and seeded into the volume, still renders.

### 5. Client order, cleanup, and timeouts

The client works in this order:
1. parse;
2. validate and stat (unchanged, so a 201 MB video is refused here before any network call);
3. `check()`;
4. for each request, upload its files in sequence;
5. `fileAll`.

Every upload finishes before the first `bd create`.

A PUT sends:
- the body as `fs.openAsBlob`, so it has a known Content-Length;
- `redirect: "error"`;
- a 300 s timeout per attempt.

A PUT is retried up to 3 times on a 503 (after its `Retry-After`, capped at 5 s) or a reset connection (EPIPE, ECONNRESET). A failed PUT DELETEs its run with the 5 s timeout. It then refuses with `could not upload the attachments to <api>: <NN-name>: <HTTP 413: first line | no answer within 300 s | socket error code>. Nothing was filed.` The server's text is cut to its first line, with control characters removed.

A run is committed as soon as `bd update` is attempted: if the update wrote the metadata and then exited non-zero, the review would point at deleted media, and a stray run is cheap. If the update landed and the review was reused, `previousRuns` (this item's relative runs other than the new one) is DELETEd. On the way out, every uncommitted run is DELETEd. Every DELETE is best-effort: a failure warns and leaves the exit code alone. The token is never printed.

### 6. Deferred

- Garbage collection of orphaned runs (a crash between upload and update, a failed `bd update`, or a failed best-effort DELETE) and of stray `.tmp` files.
- An image byte cap below 200 MB.

## Risks / Trade-offs

- **Any agent can create runs in any project.** Tokens aren't bound to projects. It can't add to, replace, or delete another client's run (decision 2), and the writable shapes are limited to `<project>/<item>/<run>`, so legacy files and other paths are safe.
- **The Mac's local board can't show remote reviews.** Their media lives on the Jetson. README says so.
- **Orphans.** A failed best-effort DELETE leaves a run behind (see Deferred).
- **Check-then-act race.** Between the realpath check and the write, a directory could be swapped for a symlink. Only the host operator can create one under the root, as for the image route.
- **Slow links vs 300 s.** A near-200 MB upload over a slow tailnet path can time out. This is checked live at bd-d38.10.
- **An early refusal can look like EPIPE.** When the server refuses before reading the body (413 on Content-Length, 503, 507, 409, 403), it closes the connection, and the client may see the close mid-write instead of the status. The CLI caps only videos before uploading; images aren't size-checked on the client, so an image over 200 MB reaches the server's 413. A reset is retried, and after the retries the refusal names the socket error rather than the status.
