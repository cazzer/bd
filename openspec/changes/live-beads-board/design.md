## Context

See proposal.md — Why. Constraints that shape the approach:

- The beads loader is a script (`ingest-beads.ts`) whose `main()` runs at import and owns its own pool; the server cannot call it as is. It shells out to `bd list --status=all --limit=0 --json` (~0.45 s for 238 issues) and writes through `upsertNodes`/`upsertEdges` in one ingest run. `upsertNodes` already returns per-row `action` (`created` | `updated` | `unchanged`, decided by `content_hash`), so changed ids need no diffing.
- Bead identity is `(source_system 'beads', external_id = bead id)`; prefixes differ per tracker today (`bd`, `tides`, `strides`, `sky`, `collective`) but nothing enforces it.
- `getWorkItemReadiness` answers only `open`/unblocked and blocked buckets, capped at 500, scoped by `spec_id`; the board needs every status. `resolveDefaultViews` has the cycle-safe `child_of` walk (depth cap 32, alias probe ids, self-loop guard) to copy, but takes at most 200 ids.
- The web server is tRPC 11.18 on the standalone adapter, one `httpBatchLink`, no subscriptions, no polling. Client code must never import runtime values from `@breakdown/core` (it drags `pg` into the bundle).
- Spike (2026-10-24, recorded on bd-w5o): `bd list`/`bd ready` bump mtimes under `.beads/embeddeddolt/<db>/.dolt/noms/` but leave `manifest` content and `journal.idx` size unchanged; `bd create` and `bd update` change both. `.beads/last-touched` is rewritten by local writes and by `bd show`, not by pulls.

## Goals / Non-Goals

**Goals:** a change in any registered tracker on this machine shows on an open board within ~2 s; reads never trigger work; one project's failure never stalls another; every store invariant (ingest-run attribution, bulk upserts, content-hash classification, all-or-nothing batches) holds for the server's loads exactly as for the script's.

**Non-Goals:** patching cards in place on the client (the board re-reads; ~700 cards is cheap); cross-machine freshness beyond what a pull delivers; removing stale edges or nodes.

## Decisions

### 1. `project` is a contract key, not a pass-through

Unknown keys already pass through `normalizeWorkItemMetadata`, so `project` would survive without a contract change. It joins the contract anyway — validated form (`[a-z0-9._-]{1,64}`, trimmed, empty → absent) — because it becomes a selection key for views and the board, and a typo'd project silently forms its own board. It is not in `WorkItemPatch`: the loader that owns an item is its only writer. Caveat kept, not fixed: a node upsert replaces metadata wholesale, so an agent re-writing a beads item through `brain_write` without `project` drops it until the next load restores it.

### 2. The ingest becomes a library function; the script parses arguments

New `beads-ingest.ts` exports `ingestBeadsCheckout(db, { dir, project?, runBd? })` → `{ project, path, nodes: { created, updated, unchanged }, edges: { created, updated }, changedNodeIds, ingestRunId }`. `changedNodeIds` is `rows.filter(r => r.action !== 'unchanged')`. `runBd` is injectable so tests feed fixture JSON with no `bd` binary. The function takes `db` and never creates or ends a pool. `ingest-beads.ts` keeps only `<dir> [--project <key>]` parsing, pool lifecycle, and printing; the root script resolves a relative `<dir>` against `INIT_CWD`, as `ingest:repo` does. Without `--project` the load behaves as today (no project, no registration), so the existing dogfood command keeps working.

### 3. Registration is a node; collisions refuse the load

A registered project is a node `{ source_system: 'beads', node_type: 'beads_project', external_id: 'project:<key>', title: <key>, metadata: { project, path } }`, written in the same `upsertNodes` batch as the items, so registration and load commit together. The metadata holds no timestamps or outcomes, so a re-load leaves it `unchanged` and writes no revision. Before writing, the function reads the export's external ids (`getNodesByExternalId`) and the existing registry node: an item owned by another project, or the key registered at another path, refuses the load with a typed error naming both sides. An item with no `project` is adopted (that is how bd's own already-loaded items gain `project: bd`). The guard read and the upsert are not one transaction; two loads of the same project racing is ruled out on the server by the per-project queue (decision 5), and a racing CLI load can at worst both pass the guard for the same project, which is harmless.

Rejected: namespacing external ids as `<project>:<id>` — re-keys every existing beads node and every `blocks`/`child_of` edge for a collision no tracker has; a per-project `source_system` — splits one loader into N source systems the explorer's provenance colours would treat as unrelated.

### 4. One board statement, sharing the blocking fragment with readiness

New `board.ts` `getWorkBoard(db, { projects? })` is one SQL statement:

- `items`: canonical `work_item` nodes whose `metadata @> {"project": …}` for the selected keys (GIN-served), or with any `project` when none are named.
- `blocks` / `open_blocks` / cycle membership: the same CTEs readiness uses, extracted from `buildWorkItemReadinessQuery` into one fragment builder both queries call, so the two can never disagree about what blocks. Blockers are evaluated store-wide, so a cross-project `blocks` edge counts.
- `ancestors`: a recursive `child_of` walk seeded from `items` (a subquery, not an id array, so the 200-id cap does not apply), with `resolveDefaultViews`'s alias probing, `merged_into` folding, self-loop guard, and depth cap 32; `DISTINCT ON (start_id) … ORDER BY start_id, depth, node_id` picks the nearest ancestor whose `issue_type` is `epic`.
- `column`: `CASE` per the work-board spec; closed items ranked by `closed_at DESC` per project, `rank <= 25` kept, the rest counted into `omittedClosed[project]`.

It returns cards (no content), the epics that head lanes (title, status, project), and `omittedClosed`. Item count is capped at 3,000 with a `truncated` flag — five trackers hold ~700 today. `listBeadsProjects(db)` lists the registry nodes.

Rejected: reusing `getWorkItemReadiness` — it hides `in_progress`, `closed`, `deferred`, and status-`blocked`-without-edge items and caps at 500.

### 5. Watcher: events wake it, the fingerprint decides, a per-project queue serializes

`apps/web/server/beads-watcher.ts`, built so everything but `fs.watch` is pure and clock-injectable:

- **Events.** Per project, non-recursive `fs.watch` on `<dir>/.beads/` (local writes touch `last-touched`) and on `<dir>/.beads/embeddeddolt/<db>/.dolt/noms/` (writes and pulls), `<db>` discovered as the single directory under `embeddeddolt/`. Plus a 30 s safety tick, because macOS `fs.watch` can drop events and a missed wake should cost latency, not correctness.
- **Fingerprint.** sha-256 of `noms/manifest` plus `journal.idx` size. A wake whose fingerprint equals the last loaded one is a read and does nothing — this is what stops the watcher triggering itself through its own `bd list`. A missing manifest (a beads layout change) yields a null fingerprint, which always loads: noisier, never wrong; logged once per project.
- **Debounce and queue.** Wakes debounce 300 ms per project. A project is idle, loading, or loading-with-follow-up; a wake during a load sets the follow-up flag, so a burst costs at most two loads. Projects load independently.
- **Lifecycle.** Created in `index.ts` after the pool, before the HTTP server; reads the registry and loads every project once at start. `refreshBoard` re-reads the registry (picking up projects the CLI registered since start) and loads all. Shutdown order: stop watchers and ticks → end subscriptions → await in-flight loads → `server.close()` + `closeAllConnections()` → `pool.end()`.

Rejected: hooks posting to an endpoint (no beads write hook exists; a `bd` shim or agent hook covers one writer path); polling `bd list` on an interval (≥0.4 s of process spawn per project per tick, and it still needs the fingerprint to avoid writing an ingest run per tick).

### 6. Changes reach the browser over SSE; the board re-reads

The watcher emits on an in-process `EventEmitter`: `{ kind: 'changed', project, changedNodeIds, at }` when a load created or updated any node or edge (edges matter: a new dependency moves a card without changing any node), and `{ kind: 'error', project, message, at }` when a load fails. `routers/board.ts`'s `boardEvents` is an async-generator subscription reading those events until its signal aborts. The client's `trpc.ts` routes subscriptions through `httpSubscriptionLink` via `splitLink`; queries stay batched. The board debounces events 150 ms, re-reads `board` behind a generation counter (the graph's stale-answer discipline), and highlights `changedNodeIds` briefly. On reconnect it re-reads once, so a missed event costs nothing.

Rejected: client-side card patching from event payloads — duplicates the column and lane rules in the browser for a payload the server answers in one statement.

### 7. Board view follows the timeline's shape

`/board?view=<id>&project=<k>…`, lazy-loaded like the timeline. Project chips come from the view filter's `where` predicate on `project` (`equals` or `oneOf`) — no new listing option key — or from `beadsProjects` when the filter names none. Column and status constants are duplicated in `lib/boardRow.ts` (type-only imports from core), with grouping, ordering, and chip logic as pure tested helpers. A card navigates to `/graph?node=<id>` like a feed row, where the existing detail panel opens; the detail panel is not extracted from the graph. The renderer-keyed offer gains `board` → `/board?view=<id>`.

## Risks / Trade-offs

- [`fs.watch` drops or coalesces events on macOS] → 30 s fingerprint tick; worst case a change shows in 30 s, not never.
- [Beads changes its on-disk layout] → null fingerprint loads on every wake and tick; correct, noisier; logged once.
- [`bd list` runs while an agent writes] → Dolt serves a consistent snapshot (inference); if `bd` fails, the project shows its error, keeps its last items, and the next wake retries.
- [First load after this change marks every beads node `updated`] → expected once (`project` added); writes one revision per item.
- [Every real change writes an ingest run and revisions] → that is the store's contract for loaders; the fingerprint gate keeps reads from doing it.
- [Ghost items] → issues deleted from a tracker stay at their last status (bd-aow.3 owns the sweep); rare in practice.
- [Vite dev proxy buffers SSE] → verified in task 3; if it buffers, the proxy entry gets an explicit no-buffer option.

## Migration Plan

No migration. After group 1 lands, run `pnpm ingest:beads <dir> --project <key>` for strides, tides, skyos, bd, collective (never `collective-worktrees/*`); write an all-projects board view and one per project over MCP. Rollback is reverting the code: the `project` keys and registry nodes are inert data to the previous version.
