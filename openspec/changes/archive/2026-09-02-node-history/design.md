## Context

Every write to `nodes` already lands in one of four places: the batch upsert (`upsertNodes`, also the substrate of `updateNodeContent`), `mergeNodes`, and the two loaders that call the upsert. All of them go through an ingest run except `mergeNodes`, which issues a bare `UPDATE nodes SET merged_into` with no run at all. The upsert rewrites `ingest_run_id` on every row it touches, changed or not, and bumps `updated_at` only when type, content hash, or metadata actually differ. Those two facts decide most of what follows. See proposal.md for why history matters now.

Constraints:

- No column is added to `nodes`. The `resolved_nodes` view froze its column list at creation; a new table sidesteps that entirely.
- The schema header reserves triggers for database invariants, not write-path behaviour. History has to justify itself under that rule.
- Every response the MCP server sends is bounded by a character budget, and every read tool must keep working in read-only mode.
- The only environment variables are `DATABASE_URL`, `BRAIN_READ_ONLY`, and `WEB_SERVER_PORT`. Recording an actor may not add one.

## Goals / Non-Goals

**Goals:**

- A revision exists for every real change and for no non-change, regardless of which code path wrote it.
- Value-at-time is one indexed read. "What did this node look like at revision 3" never requires replay.
- Who did it is answerable at the granularity the store can actually know: the run, its source system, and the connected client or person driving it.

**Non-Goals:**

- Field-level diffs at write time. Postgres has no jsonb diff and the store must not grow one; comparison happens on read.
- Making history a second source of truth. `nodes` stays authoritative; revisions are a record of it, never something the write path reads back.
- Edge history, pruning, and any UI. See proposal.md Non-Goals.

## Decisions

### A trigger on `nodes`, not code in the write path

Two triggers, one function: `AFTER INSERT` with no condition, and `AFTER UPDATE` with a `WHEN` clause comparing `node_type`, `title`, `content`, `metadata`, and `merged_into` between `OLD` and `NEW`. Both call a function that inserts one `node_revisions` row snapshotting those fields plus `content_hash` from `NEW`, attributed to `NEW.ingest_run_id`.

The `WHEN` list is deliberately not `OLD.* IS DISTINCT FROM NEW.*`: the upsert rewrites `ingest_run_id` unconditionally, so a whole-row comparison would mint a revision on every no-op re-load and break the "unchanged re-load" scenario. Two triggers rather than one `INSERT OR UPDATE` trigger because a `WHEN` clause cannot reference `OLD` on insert, and branching on `TG_OP` inside the function would run the function for every unchanged row instead of letting Postgres skip it.

This is the trigger-justified case the schema header describes. Four write paths exist and more loaders are planned; a path that forgets to record a revision produces exactly the silent failure a trigger exists to prevent, and the invariant — every change leaves a record — is about the table, not about any caller. `updated_at` stays application-maintained because it is per-statement bookkeeping; a revision is not.

*Rejected:* inserting revisions from `upsertNodes`'s own CTE, which already knows which rows changed. Cleaner SQL, but it covers one path and silently exempts `mergeNodes` and any future direct update.

### Full snapshots, numbered per node

Each revision stores the node's complete mutable state after the change. `revision_no` is assigned in the trigger as one more than the node's current maximum. Under READ COMMITTED a second concurrent writer blocks on the row lock the first writer's `UPDATE` took, so by the time its trigger runs the first revision is visible; `UNIQUE (node_id, revision_no)` is the backstop that turns any remaining race into a loud failure rather than a duplicate number.

Content is duplicated per revision. At personal scale that costs nothing worth a special case, and the content hash already stops no-op writes from producing revisions at all. The unique key on `(node_id, revision_no)` is the index that makes both "latest N" and "revision N" a keyed read; a second descending index would be pure write cost.

*Rejected:* storing diffs. Cheaper on content for document-sized nodes, but every read becomes a replay and every reader has to agree on a diff format. *Rejected:* event sourcing, where events are primary and `nodes` is a projection. It inverts a working upsert design for no gain here.

### Backfill at migration time

The migration inserts revision one for every existing node from its current row, attributed to the run that last wrote it, with `recorded_at = updated_at`. Without this, history for pre-existing nodes would begin at their next change and the "first revision is creation" property would be false for most of the store.

### `actor` on `ingest_runs`, resolved lazily by the MCP server

A nullable `text` column. `openIngestRun` gains an optional options argument so existing callers are untouched. The MCP server derives the actor from the client's `initialize` handshake — name and version the SDK exposes after connect — and resolves it at call time rather than at server construction, because the handshake has not happened when `createServer` runs. Human writes record `human`; the seed and GitHub loaders record their script names.

*Rejected:* an environment variable. It would be the fourth variable in a list CLAUDE.md fixes deliberately, and it would record what someone configured rather than what actually connected.

### `mergeNodes` requires a run and marks what it touched

The signature gains a required `IngestRunHandle`, and the `UPDATE` sets `ingest_run_id` alongside `merged_into` on every row it repoints. Without this the trigger would attribute a merge revision to whichever run last happened to write the node. The MCP merge tool wraps the call in the same agent ingest run helper the write tools use and returns the run id. The spec already says every write has a run; this closes the one exception.

### Change detection on read, in SQL

The history query uses `LAG` over a node's revisions to compare each with its predecessor: a text array of changed field names, and for metadata a jsonb object of `{ key: { before, after } }` built from the union of both revisions' top-level keys where the values are distinct. Content is compared by hash and omitted from the result unless requested. This keeps the tool thin and keeps the diff logic in one place a UI can reuse later.

## Risks / Trade-offs

- [A large batch re-load that genuinely changes every node writes one revision per node.] → That is one extra insert per changed row inside the same transaction; unchanged rows cost nothing because the `WHEN` clause skips the function. Measure with the 5,000-node scenario during implementation and record the number.
- [Content duplication grows the table faster than `nodes`.] → Acceptable at personal scale; pruning is an explicit non-goal and a later, data-informed decision.
- [Deleting a node removes its history.] → `node_revisions.node_id` cascades on delete, the same rule `edges` already follows. A no-action key was the first choice, but every test suite deletes its fixture nodes in cleanup and would fail on the first revision written; no application delete path exists, so nothing real is lost. When a delete path is designed, that migration decides between keeping the cascade and switching to a no-action key with tombstones. `ingest_run_id` stays no-action, like `nodes` and `edges`.
- [The actor is whatever the client claims in its handshake.] → It is attribution, not authentication, in a single-user store. The source system remains the trust boundary.

## Migration Plan

One additive migration: the `actor` column and the `node_revisions` table via `drizzle-kit generate`, then the trigger function, both triggers, and the backfill hand-written into the same file, as `0000` does for its trigger and view. Apply with `pnpm db:migrate`. Rollback is dropping the triggers, the table, and the column; no existing read path depends on any of them.
