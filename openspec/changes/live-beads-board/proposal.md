## Why

Work across five repositories is tracked in beads (strides, tides, skyos, bd, collective — about 700 issues), and the only way to see it is `bd list` in each checkout, one at a time. There is no view of what is in progress, what is ready, and what is blocked across projects, and no way to watch agents move work while they do it. The store already models work items, blocking, and parent relationships, and already loads beads — so the missing pieces are knowing which project an item came from, a board that draws columns and epics, and a way to keep it current as the trackers change.

## What Changes

- **Work items may name their project.** A validated optional `project` key joins the work-item contract. The beads loader writes it; a field patch never changes it.
- **Registering a beads checkout.** `pnpm ingest:beads <dir> --project <key>` loads a checkout under a key and records it as a registered project (a `beads_project` node holding the key and absolute path). The registered projects are the set of nodes, so there is no config file and no new environment variable. A load is refused, with nothing persisted, when an issue id is already owned by another project or a key is reused for another path. The ingest becomes a library function the web server can call, with the script as a thin caller.
- **A board read.** One core read places every item of the selected projects in exactly one column — Ready, Blocked, In progress, Deferred, Closed (the 25 most recent per project) — with its nearest epic along `child_of`, in one statement that tolerates parent cycles.
- **The renderer set gains `board`**, and a board view at `/board?view=<id>&project=<key>…` draws columns with epic lanes and project chips. Cards open the graph on the item. Read-only.
- **Live updates.** The web server watches each registered checkout's `.beads/` directory, ignores events whose Dolt manifest fingerprint did not change (reads touch files but never change their content), re-loads a changed project serially, and pushes a change event over a server-sent-events subscription; the board re-reads on each event. A refresh request re-loads every project by hand.
- **No schema change, no migration.** Project lives in metadata; registration is a node.

## Non-Goals

- **No write-back.** Dragging a card does not change beads. Changing status from the board is the next step toward bd-98d and needs `bd update` in the owning checkout, not a store write.
- **No automatic tracker pull.** Items written in a cloud session appear when this machine's checkout pulls them; the watcher sees the pull. A periodic `bd dolt pull` writes to the user's trackers and stays opt-in, later.
- **No deletion sweep.** An issue deleted from its tracker keeps its node and its last status, as every loader's removed items do until the stale-node sweep (bd-aow.3).
- **Breakdown is not the system of record.** Beads stays authoritative; see bd-98d.
- **No view editor.** As with the feed and timeline, a board view is written over MCP.

## Capabilities

### New Capabilities

- `work-board`: registering beads checkouts under project keys, the board's columns and epic lanes, its address and project chips, and live updates as trackers change.

### Modified Capabilities

- `work-items`: the contract gains an optional, validated `project` key that patches never change.
- `node-views`: the renderer set gains `board`, and the detail panel's offer is defined for it.
- `local-web-api`: the read surface gains the board read, the registered-project list, a change subscription, and a refresh request.
- `brain-mcp`: view validation accepts `board`.

## Impact

- `packages/core`: `work-items.ts` (`project` key); `beads.ts` (mapping takes a project); new `beads-ingest.ts` (`ingestBeadsCheckout(db, { dir, project })`, registry node, collision guard) with `ingest-beads.ts` reduced to argument parsing; new `board.ts` (`getWorkBoard`, `listBeadsProjects`); `views.ts` renderer set; `errors.ts`; `index.ts` exports.
- `apps/web/server`: new watcher service (fingerprint, debounce, per-project serial queue) started in `index.ts` and stopped before the pool closes; `context.ts` carries it; new `routers/board.ts` (`board`, `beadsProjects`, `boardEvents` subscription, `refreshBoard`); `errors.ts` hint names five renderers.
- `apps/web/src`: `trpc.ts` splits subscriptions onto `httpSubscriptionLink`; `lib/route.ts` gains `BoardRoute`; `App.tsx` gains a lazy case; new `components/BoardView.tsx` with pure helpers in `lib/boardRow.ts`; `DetailPanel.tsx` and `GraphView.tsx` extend the renderer-keyed offer.
- `apps/mcp`: `tools/write.ts` description and `errors.ts` hint name `board`.
- `packages/db`: untouched.
- Rejected alternatives: hooks posting to an endpoint (beads has no write hook; a `bd` wrapper or agent hook sees one writer path and a cloud VM cannot reach localhost); one shared Dolt server for all trackers (Dolt has no change notification, so it still polls, and every repo and session would depend on the server); reading `bd list` live without the store (always fresh, but drops readiness and epic walks the store already computes, and works against bd-98d); namespacing external ids by project (breaks the identity of every existing beads node for a collision no current tracker has — refusing the load is enough).
