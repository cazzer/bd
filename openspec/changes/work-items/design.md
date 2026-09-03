## Context

`node-history` (unmerged, this branch's base) made every node change a revision attributed to a run and an actor. The store still has no way to select nodes by anything but text, no notion of what a task's fields mean, and no dependency semantics. Every read tool is bounded by a character budget; every write goes through `upsertNodes`/`upsertEdges` and an ingest run; canonical joins go through `resolved_nodes`, with `lookup.ts` and `retrieval.ts` folding edge endpoints through `merged_into` where an edge attached to a merged-away row must still count. `node_type` is open text and must stay so. See proposal.md for why now.

## Goals / Non-Goals

**Goals:**

- A structural query that is indexed, bounded, pageable, and impossible to turn into SQL by the caller.
- One place — a core module — that defines the work-item contract, used by the MCP write tool, the patch primitive, and the importer, so the three cannot disagree.
- Dependency semantics that hold at the database level where a silent failure would otherwise be possible (cycles), and on read where the database cannot see them (cycles created by merges).

**Non-Goals:**

- A predicate language beyond equality and membership on top-level keys.
- Enforcing the work-item contract with a constraint or trigger. The contract will change; the discriminator will not.
- History of edges; write-back to beads; any UI.

## Decisions

### Listing compiles predicates to containment, served by one GIN index

Every metadata predicate becomes a jsonb containment test: `equals` predicates are merged into one object and tested with `metadata @> $1`; a `oneOf` predicate becomes a disjunction of containments, one per value. A single `CREATE INDEX ... USING gin (metadata jsonb_path_ops)` serves all of them; `jsonb_path_ops` is chosen over the default opclass because only `@>` is ever issued and it is smaller and faster for that operator. Values are JSON scalars (string, number, boolean, null), bound as parameters; keys are bound too. Results come from `resolved_nodes`, ordered `updated_at DESC, id DESC`, paged by a keyset cursor `{updatedAt, id}` using a row-value comparison under the same order, one row past the limit to detect more — `lookup.ts`'s convention. Content is never returned; `brain_get` is for content.

*Rejected:* `metadata->>key = text` comparisons — lossy across types, unindexed, and an invitation to grow into expressions. *Rejected:* a small query grammar — the moment it exists it is a passthrough with extra steps.

### The work-item contract lives in core and is enforced at the tool boundary

`packages/core/src/work-items.ts` owns the constants and a `normalizeWorkItemMetadata` function: apply defaults, validate every contract key, apply the closing rules, pass other keys through, throw `InvalidWorkItemError(field, value, reason)` otherwise. `brain_write` calls it for every item whose type is `work_item` before `upsertNodes`; `patchWorkItem` calls it on the merged document; the importer calls it on what it maps. `upsertNodes` itself stays type-agnostic.

*Rejected:* validating inside `upsertNodes` by node type — it would put one type's semantics into the generic write path, and every future contract would follow. *Rejected:* a database CHECK — it freezes a contract that is expected to evolve and contradicts the open discriminator.

### Patching is read-modify-write under a row lock, written through the upsert kit

`patchWorkItem` runs one transaction: resolve the id through `COALESCE(merged_into, id)`, `SELECT ... FOR UPDATE` the canonical row, refuse if its type is not `work_item`, merge the patch into the existing metadata (a `null` in the patch removes the key), normalize, and write the result through `unsafePrepareNodes` and `unsafeBuildUpsertNodesQuery` inside the same transaction — exactly how `annotateNode` composes a write. Title and content are re-sent unchanged, so `content_hash` is unchanged and the upsert's own "metadata differs" rule bumps `updated_at`, reports `updated` or `unchanged`, and the `node-history` trigger records the revision. The lock is what makes two concurrent patches serialize instead of one overwriting the other.

*Rejected:* `UPDATE nodes SET metadata = metadata || $1` — bypasses the upsert's change detection and size limits, and would need its own `updated_at` logic. *Rejected:* `updateNodeContent`'s lockless read-then-upsert — fine for a single editor, wrong for two agents closing the same item.

### Cycle rejection is a trigger on `edges`, serialized by an advisory lock

A `BEFORE INSERT OR UPDATE OF src_id, dst_id, edge_type ON edges` trigger, `WHEN (NEW.edge_type = 'blocks')`, takes `pg_advisory_xact_lock` on a constant key, folds both endpoints through `merged_into`, rejects a self-block, then walks existing `blocks` edges from the new target with a recursive query (endpoints folded, path tracked, depth bounded) and raises `check_violation` with the path in `DETAIL` if the new source is reachable. An edge already stored for the same source, target, and type returns early before the walk: it adds no reachability, so it cannot form a cycle, and the idempotent re-import of an edge that sits on a cycle a merge created must keep succeeding (there is no tool to retract or un-merge). This is the schema header's trigger case: a cross-row rule a CHECK cannot express, with four write paths that could each forget it, and a silent failure mode (an item that can never become ready). The advisory lock closes the race two concurrent inserts would otherwise win against any check, trigger or application-side; at personal scale serializing `blocks` inserts costs nothing.

*Rejected:* checking in `upsertEdges` for `blocks` edges — the same lock is needed anyway, and a future loader writing edges another way would skip it.

### Readiness is one statement that folds endpoints and detects cycles on read

The readiness query takes work items from `resolved_nodes`, folds `blocks` edge endpoints through `merged_into` (as `lookup.ts` does, for the same reason: an edge attached to a merged-away duplicate must still count), defines an open blocker as a source that is not a closed work item, and finds cycle members with a recursive query over open blockers using Postgres's `CYCLE` clause. Ready is `status = 'open'`, no open blocker, not a cycle member; blocked is any open, in-progress, or blocked item with at least one open blocker, listing them; cycle members are reported separately. The trigger cannot see cycles a merge creates, so detection on read is required, not redundant.

### The importer shells out to `bd`, like the GitHub importer shells out to `gh`

`bd list --status=all --json` is the export. Issues become `work_item` nodes with source system `beads` and the issue id as external id; `status` maps one-to-one (beads uses the same five names), `owner` becomes `assignee`, `close_reason` becomes `closed_reason`, `spec_id` and `issue_type` pass through; dependencies of type `blocks` become `blocks` edges from the blocker to the blocked item, `parent-child` become `child_of`. Metadata goes through `normalizeWorkItemMetadata`, so a beads row that violates the contract is rejected at import rather than silently stored. Re-runs are idempotent by construction of the upsert.

## Risks / Trade-offs

- [A `blocks` insert holds an advisory lock for the length of its transaction.] → Only `blocks` edges are serialized; batches of other edges are unaffected. Acceptable at this scale; revisit if a loader ever writes thousands of `blocks` edges per run.
- [The GIN index adds write cost on every node upsert.] → `jsonb_path_ops` indexes are small; measure the 5,000-node re-load from `node-history` again and record it.
- [Containment cannot express "key is absent".] → Not needed by any current caller; add an explicit `absent` predicate when one is.
- [The importer depends on `bd`'s JSON shape.] → It parses only the fields it maps and fails loudly on a missing required one, as the GitHub importer does with `gh`.
- [Two agents patching the same item wait on each other.] → That is the point; the wait is milliseconds.

## Migration Plan

One additive migration (`0003`): the GIN index generated by `drizzle-kit` if it round-trips the opclass, otherwise hand-written like the trigram indexes; the trigger function and trigger hand-written in the same file. Apply with `pnpm db:migrate`. Rollback is dropping the trigger and the index; nothing existing depends on them.
