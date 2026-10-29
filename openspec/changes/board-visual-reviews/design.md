## Context

See proposal.md — Why. Facts from a spike against bd 1.2.2 (2026-10-28):

- `bd list --status=all --limit=0 --json` already returns each issue's `metadata` object and a `comment_count`, but not comments. `bd comments <id> --json` returns `[{ id, issue_id, author, text, created_at }]`.
- `bd dep add` refuses a `blocks` dependency between a task and an epic in either direction ("epics can only block other epics, not tasks"). `bd close <epic>` refuses while the epic has an open child unless `--force`.
- `bd create --parent <id> --labels review --metadata '<json>'` and `bd update --metadata/--add-label/--remove-label` exist.
- The web server is tRPC's standalone adapter at `/trpc/`; Vite proxies only `/trpc`. The beads watcher already re-loads a project when its tracker changes.

## Goals / Non-Goals

**Goals:** every write the board makes goes through `bd` in the owning checkout; the server's file surface is one directory; a dead pane never costs a decision.

**Non-Goals:** a generic `bd` passthrough from the browser; image upload; authentication beyond loopback (the server is loopback-only already).

## Decisions

### 1. Review data lives on the work item's metadata, comments only for reviews

`mapBeadsIssueToNode` copies a validated `review` object (`images` ≤ 20 absolute paths, `pane` matching `^[A-Za-z0-9:_.-]{1,64}$` or null, `summary` fitted to 2,000) and, for an item labelled `review`, `review_comments` (last 100, text fitted to 4,000, oldest first). Malformed `review` metadata is stored as `{ invalid: true }`, never refusing the load. Comments are fetched with `bd comments <id> --json` only for issues labelled `review` with `comment_count > 0`, through the loader's existing injectable runner, so a tracker with no reviews costs nothing extra. Metadata feeds `content_hash`, so a new comment marks the item updated and the watcher emits a change. Rejected: switching the loader to `bd export` (carries comments, but it is a different row shape on a hot path another change is editing); fetching comments for every item (one process per item, ~700 per refresh).

### 2. Cards carry a flag; the drawer reads one item

`BoardCard` gains `review: boolean` (label `review` present). A new `getBoardItem(db, { project, externalId })` returns the drawer's detail — content, labels, review, comments — so 700 cards stay light. The board address names the bead id (`item=<external id>`), because the CLI knows nothing else.

### 3. A board with no view shows every registered project

The CLI cannot know a view id, and a per-project view may not exist. `/board` without `view` behaves as an all-projects board view does (chips from `beadsProjects`). An unknown or wrong-renderer view keeps its empty state.

### 4. Image route: one root, resolved and contained

`GET /review-images/<relative path>` is handled by a small Node handler placed before the tRPC handler on the same loopback server; Vite proxies `/review-images`. The root is fixed (`os.homedir()/.local/share/breakdown/reviews`, no environment variable). The handler `realpath`s both root and target, refuses unless the target is inside the root, and serves only `png|jpg|jpeg|gif|webp` with the matching type, `Cache-Control: no-store`, and `X-Content-Type-Options: nosniff`. The drawer turns an absolute path into a URL by stripping the root; a path outside it renders as missing without a request. Rejected: base64 images in the item read (megabytes through the response budget); serving original paths (reads wherever an agent points).

### 5. Write-back: a mutation over an injectable runner

`reviewDecision({ project, item, decision, message })` in `routers/review.ts` resolves the checkout from `listBeadsProjects`, checks the item is a `review`-labelled work item of that project in the store, refuses under `BRAIN_READ_ONLY`, then runs through `review-writer.ts` with `execFile` (argv, no shell, 30 s timeout, `cwd` = checkout): `bd comments add <id> <text>`, then `bd close <id> --reason "Review accepted"` or `bd update <id> --add-label review:changes`. Comment text is `Accepted: <message>` / `Changes requested: <message>` (`Accepted.` when empty). Accept also removes `review:changes`. A comment that lands before a failing second command is reported as a partial write naming what ran. On success it calls `watcher.wake(project)` so the load starts now rather than on the next fs event. Rejected: `patchWorkItem` on the store (beads would overwrite it on the next load — beads is the record).

### 6. Notify after the write, never instead of it

`review-writer.ts` then runs `herdr agent prompt <pane> <text>` (execFile, 10 s timeout) with the pane read from the store, not from the request. No pane, a refused pane id, a non-zero exit, or a timeout yields `notified: { ok: false, reason }`, logged with the bead id; the mutation still succeeds. `herdr` is found on `PATH`.

### 7. CLI: plain Node, talks to the running server

`bin/review-request` is a dependency-free Node ESM script (symlinked into `~/.local/bin`). It maps the caller's checkout to its main working tree (`git rev-parse --git-common-dir`, parent), reads registered projects from the running server's `beadsProjects` (it needs the server to show the board anyway), and refuses when no path matches. It validates every image before any write, creates or reuses the open `review` child of the item, copies images as `NN-<basename>`, writes `metadata.review` with `bd update --metadata`, adds the `blocks` dependency when the item is not an epic, opens `open -a "Google Chrome" <board-url>/board?project=<key>&item=<id>` (`--board-url`, default `http://localhost:5173`), and runs `herdr notification show`. A failure after the bead exists names the bead so the caller can retry. Rejected: a TypeScript script under `packages/` (needs the workspace's toolchain and `DATABASE_URL` from any checkout; reading the server avoids both).

### 8. Drawer layout is chosen before it is built

Group 3 begins with 2–3 layout prototypes on fixture data, screenshotted side by side with build cost; the user picks; only then is the drawer built.

## Risks / Trade-offs

- [The server is down when an agent requests] → the CLI refuses with "start `pnpm dev`"; nothing is half-filed.
- [Comments fetched serially per review bead] → reviews are few; bounded by the label filter.
- [`bd` succeeds but the watcher misses it] → `wake(project)` after every write plus the 30 s tick.
- [A pane id is reused by another agent later] → the prompt names the bead id, so a wrong recipient can tell; accepted.
- [Images accumulate under the root] → small and local; cleanup is a follow-up, not this change.

## Migration Plan

No migration. After group 1 lands, the next load of each tracker marks only review beads updated. Symlink `bin/review-request` into `~/.local/bin`. Rollback is reverting the code; review metadata is inert to the previous version.
