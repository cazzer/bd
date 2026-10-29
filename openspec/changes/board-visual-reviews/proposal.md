## Why

Parallel agent sessions finish epics with screenshots that need a person's acceptance, and today that means copying paths out of a terminal and opening images by hand, then typing the verdict back into the right pane. The board already shows every registered tracker live; it is the natural place to look at the screenshots and answer. This is step 2 of bd-98d: the board's first write, made through `bd` in the owning checkout so beads stays the record.

## What Changes

- **A review bead convention** (epic bd-ker): a `task` labelled `review`, child of the item under review, whose beads metadata key `review` holds `{ images, pane, summary }`. bd refuses to close an epic with an open child, so the parent link alone gates the epic; bd forbids task↔epic `blocks`, so a `blocks` dependency is added only when the item under review is not an epic. Accept = `bd comments add` + `bd close`; request changes = `bd comments add` + label `review:changes`, bead stays open.
- **`review-request` CLI** (`bin/review-request`, symlinked onto PATH): from any registered checkout or one of its worktrees, files or refreshes the review bead for an item, copies the screenshots under `~/.local/share/breakdown/reviews/<project>/<bead-id>/`, opens Chrome on the board's drawer for it, and fires a herdr notification. Refuses an unregistered checkout or a missing image.
- **The beads loader carries reviews.** A review bead's `metadata.review` and its comment thread land on its work-item node; a new board item read returns an item's details, review, and comments for the drawer. Cards are marked when they are reviews.
- **A board drawer.** `/board?project=<key>&item=<bead-id>` opens a drawer on that item; closing it drops `item`. A board with no `view` shows every registered project instead of an empty state, so the CLI's link needs no view id. Cards open the drawer instead of jumping to the graph; the drawer links to the graph. Review items show the summary, a gallery (click to enlarge), the comment thread, and Accept / Request changes with a message. The layout is picked by the user from 2–3 screenshot options before it is built.
- **A review image route** on the API server, serving only files under `~/.local/share/breakdown/reviews`; anything else is refused.
- **Write-back.** A `reviewDecision` mutation runs `bd` (argv only, no shell) with `cwd` = the registered checkout, then wakes the watcher so the board moves without a reload. Failures surface in the drawer. Refused under `BRAIN_READ_ONLY`.
- **Push to the requester.** After the write, `herdr agent prompt <pane> "Review <id> accepted|changes requested: <message>"`; a missing or dead pane is logged and reported in the drawer, never failing the decision.
- No schema change, no migration, no new environment variable, no model call.

## Non-Goals

- No general board write-back (drag to change status). Only review decisions write.
- No image upload from the browser; images come from the CLI.
- Beads stays the system of record; the store never holds a decision beads does not.
- No polling for the decision: the requester is woken by herdr, or reads the bd comment.

## Capabilities

### New Capabilities

- `board-reviews`: the review bead convention, the `review-request` CLI, review data on work items, the review drawer, the image route, write-back through bd, and the push to the requesting pane.

### Modified Capabilities

- `work-board`: a board with no view shows every registered project; the address gains `item`; activating a card opens the drawer rather than the graph; "the board SHALL NOT change any item" gains the review-decision exception.
- `local-web-api`: gains the board item read, the review image route, and the review decision mutation.

## Impact

- `packages/core`: `beads.ts` (map `metadata.review` and comments; `BeadsIssue` gains `metadata`, `comment_count`), `beads-ingest.ts` (fetch comments for review beads through the injectable runner), `board.ts` (`review` flag on cards, `getBoardItem`), new `reviews.ts` (review metadata contract, image root, path containment).
- `apps/web/server`: `index.ts` (image route beside the tRPC handler), `routers/board.ts` (`boardItem`), new `routers/review.ts` (`reviewDecision`), new `review-writer.ts` (bd + herdr runners, injectable), `beads-watcher.ts` (`wake(project)`).
- `apps/web/src`: `lib/route.ts` (`item` on `BoardRoute`), `BoardView.tsx` (view-less board, drawer), new `components/ReviewDrawer.tsx`; `vite.config.ts` proxies `/review-images`.
- `bin/review-request` (new, Node ESM, no dependencies).
- Rejected alternatives: storing decisions in the store and syncing to beads later (two records, and bd-98d says beads leads until absorbed); a browser upload endpoint for screenshots (agents already have files on disk; a copy under a fixed root is simpler and keeps the server's file surface to one directory); the board polling an agent-written file for decisions (herdr already delivers prompts to panes); serving images straight from their original paths (the server would read anywhere an agent pointed it).
