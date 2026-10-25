## Why

The store can create, update, and merge nodes. It cannot remove one.

This came up in practice, not in theory. The git loader had written 78 `commit` nodes; they dominated every view — the History timeline's first 50 rows were 100% commits, and they carried 693 of the store's 3248 edges. Removing them required raw SQL against Postgres, because there is no delete path in `packages/core`, in the tRPC router, or in the `brain_*` tools:

```sql
delete from edges where src_id in (...) or dst_id in (...);
delete from node_revisions where node_id in (...);
delete from nodes where id in (...);
```

An agent that can load material into the brain but cannot take anything out is only half a writer. `brain_merge` covers "these two are the same"; nothing covers "this should not be here."

The reason no delete exists yet is worth stating, because it constrains the answer: **a hard delete is the one write path that can violate the store's append-only history.** `node_revisions.node_id` is `ON DELETE CASCADE`, so `DELETE FROM nodes` destroys that node's entire revision history — and the knowledge-store spec already says revisions "SHALL NOT be modified or removed by any write to the node." Deleting rows is exactly how you'd break that rule without noticing.

## What Changes

- **Nodes can be deleted, and deletion is a tombstone rather than a row removal.** A deleted node keeps its row and its full revision history; it stops being returned by search, lookup, listing, traversal, and every other read. This reuses the machinery `merged_into` already established — `resolved_nodes` is the view every read path goes through, so one view change removes deleted nodes from all of them at once.
- **Deleting is itself a recorded change.** It happens inside an ingest run and appends a revision, exactly as a merge does, so "who removed this and when" is answerable.
- **A deleted node can be restored.** The payoff of choosing a tombstone: the delete is reversible for as long as the row exists.
- **Deletion does NOT survive re-ingestion.** A loader that finds the node's source again revives it. Delete is a one-shot cleanup of what is in the store now, not a permanent suppression list. Durable "I never want to see this type" belongs to a view's filter, which already exists.
- **A new `brain_delete` MCP tool**, and a `brain_restore` beside it. Selection is by explicit ids, or by the same validated filter grammar `brain_list` already compiles — never by free SQL. A filter-delete additionally requires the caller to state how many nodes it expects to remove, and is refused if the count does not match.
- **Edges touching a deleted node stop being drawn or traversed**, stated as a requirement rather than left as a side effect of a foreign key.

Out of scope, explicitly:

- **The web app gets no delete affordance.** The request was for the MCP/agent connection, and the explorer's existing destructive-ish action (edge retraction) is a different, narrower thing. Revisit only if a person asks for it.
- **No hard-delete escape hatch.** Adding one would re-open the exact hole this change exists to avoid, and nothing here needs the disk space back.
- **No cascading delete of a node's neighbours.** Deleting a directory does not delete the files under it; that is a bulk-selection problem, and the filter already solves it.

## Capabilities

### New Capabilities

None. Both surfaces this touches already exist.

### Modified Capabilities

- `knowledge-store`: adds deletion and restoration as write operations — attributable to an ingest run, recorded as revisions, and invisible to every read path; and states what happens to edges touching a deleted node, and what a loader does when it re-encounters one.
- `brain-mcp`: adds the `brain_delete` and `brain_restore` tools, and widens the read-only requirement, which currently names only "write, link, and merge tools", so that a read-only server refuses deletion too.

## Impact

**Schema — `packages/db`:** one migration adding a nullable `deleted_at` to `nodes`, plus — in the *same* migration — a `CREATE OR REPLACE VIEW resolved_nodes` that both excludes deleted rows and picks up the new column. Postgres froze the view's `SELECT *` into an explicit column list at creation, so skipping the replace leaves the column invisible to every read path. The revision trigger must treat the tombstone as a recordable change.

**Core — `packages/core`:** a delete/restore module beside `nodes.ts` and `merge.ts`, batch-first and taking an `IngestRunHandle`, since "no write to `nodes` happens outside an ingest run" is an existing invariant. `upsertNodes` gains one behaviour: a write that matches a tombstoned `(source_system, external_id)` clears the tombstone.

**MCP — `apps/mcp`:** two tools, gated by `BRAIN_READ_ONLY` like every other writer.

**Reads:** nothing changes at the call sites. Retrieval, lookup, listing, tree, timeline and readiness all resolve through `resolved_nodes` or fold through `coalesce(merged_into, id)`; the view change covers them. Retrieval's deliberate exception — seed search scans `nodes` directly — is the one place that needs its own filter, and it is documented in that module's header as the exception it is.

**Not affected:** no new environment variable, no model call, no API key. Still `DATABASE_URL`, `BRAIN_READ_ONLY`, `WEB_SERVER_PORT`.
