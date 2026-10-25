## Context

See proposal.md — Why. Four facts measured on the live schema shape everything below.

**The cascades are already set up to destroy history.**

```
edges_src_id_nodes_id_fk       FOREIGN KEY (src_id) REFERENCES nodes(id) ON DELETE CASCADE
edges_dst_id_nodes_id_fk       FOREIGN KEY (dst_id) REFERENCES nodes(id) ON DELETE CASCADE
node_revisions_node_id_..._fk  FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
nodes_merged_into_nodes_id_fk  FOREIGN KEY (merged_into) REFERENCES nodes(id)   -- no cascade
```

A `DELETE FROM nodes` takes the node's edges and its whole revision history. The fourth line matters too: with no cascade, hard-deleting a node that others were merged *into* fails outright on the constraint.

**`resolved_nodes` is a frozen column list, and it is the one chokepoint.**

```sql
SELECT id, node_type, source_system, external_id, title, content, content_hash,
       metadata, merged_into, ingest_run_id, created_at, updated_at, search
  FROM nodes WHERE merged_into IS NULL;
```

Every canonical-row read goes through it. That is why `merged_into` needed no change at any call site, and it is why a tombstone needs none either.

**The revision trigger has an explicit column list and an explicit WHEN clause.**

```sql
AFTER UPDATE ON nodes FOR EACH ROW WHEN (
  old.node_type IS DISTINCT FROM new.node_type OR old.title IS DISTINCT FROM new.title OR
  old.content IS DISTINCT FROM new.content OR old.metadata IS DISTINCT FROM new.metadata OR
  old.merged_into IS DISTINCT FROM new.merged_into)
```

A new column is invisible to it unless the WHEN clause and the `INSERT INTO node_revisions (...)` list both learn about it. This is the same "frozen list" hazard as the view, in a second place.

**Retrieval deliberately does not use the view.** Seed search scans `nodes` directly and folds through `coalesce(merged_into, id)`, because a text match on a merged-away row must return its survivor rather than vanish. It is the one read that a view predicate will not cover.

## Goals / Non-Goals

**Goals:**

- Deleting a node removes it from every read, in one place, without editing every reader.
- History survives deletion — the store's append-only guarantee holds for the one operation most likely to break it.
- The delete is reversible while the row exists.
- An agent cannot delete more than it meant to.

**Non-Goals:**

- Reclaiming disk. Nothing here is about space, and pretending otherwise would argue for hard deletes.
- A permanent suppression list. Deletion is one-shot; re-ingestion revives (proposal.md, and the requirement that states it).
- Deleting edges independently. `retractEdge` already exists for that.
- Any web affordance.

## Decisions

### 1. Tombstone, not row removal

A nullable `deleted_at timestamptz` on `nodes`. `resolved_nodes` gains `AND deleted_at IS NULL`.

*Why not a hard delete,* which is the obvious reading of "delete": it is the only write path in this store that can remove revision rows, and `knowledge-store`'s existing requirement says revisions "SHALL NOT be modified or removed by any write to the node." A hard delete does not bend that rule, it deletes the evidence of bending it. It also fails outright against `nodes_merged_into_nodes_id_fk` for any node that was a merge survivor — so the "simple" option is not even uniformly available.

*Why not option (c), hard-delete the node but keep revisions* (nullable `node_id`, or an archive table): it buys the same history preservation as a tombstone while adding a second storage shape, orphaned revision rows pointing at nothing, and no reversibility. Strictly more machinery for strictly less.

The honest cost of the tombstone is that rows accumulate. At this store's scale — 1672 nodes — that is not a cost worth designing against. If it ever becomes one, a purge is a separate, deliberate operation, and it should stay deliberate.

### 2. The column is a predicate, not a projection

`CREATE OR REPLACE VIEW resolved_nodes` changes only the `WHERE`, keeping the existing thirteen columns in their existing order. `deleted_at` is **not** exposed through the view.

Two reasons. `CREATE OR REPLACE VIEW` may only append columns, never insert, so exposing it would pin it to the end regardless of where it sits on the table. And no read path wants it: a row visible through the view is by definition not deleted, so a `deleted_at` column there would be a constant `NULL`. Delete and restore query `nodes` directly, as the writers they are.

CLAUDE.md's rule ("adding a column to `nodes` requires a `CREATE OR REPLACE VIEW` in the same migration") is still satisfied, and for its actual reason — the view must change, here for its predicate rather than its projection.

### 3. Retrieval gets its own filter, and that is expected

The seed scan is documented in its module header as the deliberate exception to the view. It needs `AND deleted_at IS NULL` written into it by hand. Everything else — lookup, list, tree, timeline, readiness, default-view resolution — goes through `resolved_nodes` or folds through `coalesce(merged_into, id)` and needs nothing.

The fold is worth checking once during implementation rather than assuming: an edge endpoint that folds to a deleted survivor must drop out, not resolve to a tombstoned row.

### 4. Deletion is a revision, so the trigger learns one more column

`node_revisions` gains `deleted_at`; the trigger function's INSERT list gains it; the UPDATE trigger's WHEN clause gains `OR (old.deleted_at IS DISTINCT FROM new.deleted_at)`.

That last clause is what makes "deleting twice records no second revision" fall out for free rather than needing a guard in application code — `IS DISTINCT FROM` is already false when nothing changed. `getNodeHistory`, which computes what changed on read rather than storing it, gains `deleted_at` as a field it reports.

### 5. Edges stay, and stop resolving

No edge rows are touched by a delete. An edge whose endpoint is tombstoned simply has no canonical endpoint, so it drops out of every read that resolves endpoints — which is all of them. Restoring the node brings the edge back with its original type, provenance and weight, because nothing about it ever changed.

This is why the spec states edge behaviour as a requirement rather than leaving it to the foreign key: under a tombstone the FK does nothing at all, and the behaviour comes entirely from resolution. A future reader who sees `ON DELETE CASCADE` on those columns and assumes it is load-bearing would be wrong.

### 6. Re-ingestion revives

`upsertNodes` matches on `(source_system, external_id)`. When it matches a tombstoned row it clears `deleted_at` and applies the write.

*Why not skip the row, or write a second one beside it:* skipping makes a loader silently under-load with no way to tell from its output; writing a second one breaks the uniqueness that `(source_system, external_id)` exists to provide.

*Why this differs from merge,* which a re-load leaves in effect: a merge is a claim about identity, which stays true no matter how many times the source reappears. A deletion is a statement about what the store should currently hold, and a loader being run again is a statement about the same thing — the more recent one wins. Anyone wanting a type gone permanently wants a view filter, which already exists and is what the motivating case should arguably have used.

### 7. A selection-delete must state its own count

`brain_delete` takes either `ids` or the `listNodes` selection grammar — the same validated shape `brain_list` compiles to jsonb containment, so this adds no new predicate language and no SQL passthrough.

A selection additionally requires `expectedCount`, and deletes nothing unless the selection matches exactly. The motivating case ("all 78 commits") is precisely the shape that is both most useful and most dangerous, and the asymmetry is what justifies the friction: an agent that has already counted loses nothing, and an agent that has not counted is exactly the one that should not be deleting in bulk. `ids` needs no count because the list *is* the count.

*Rejected — a `dryRun` flag:* it makes the safe path optional, and the unsafe path is the one that needs to be hard to take by accident. `brain_list` with the same selection is already the dry run.

### 8. MCP-only

No tRPC procedure and no explorer affordance. The request was for the agent connection; adding a delete button to a canvas where a click already means "expand" is a gesture-design problem this change has no reason to open.

## Risks / Trade-offs

- **A reader assumes the `ON DELETE CASCADE` FKs still govern deletion** → they become vestigial under a tombstone. Noted in decision 5 and worth a comment at the schema.
- **Tombstoned rows accumulate** → accepted at this scale; a purge stays a separate deliberate operation (decision 1).
- **Someone hard-deletes anyway, via psql** → out of the store's control, and exactly what happened to produce this proposal. The tools existing is the mitigation.
- **The trigger's WHEN clause is edited by hand** → a second frozen list, like the view. Both are in one migration; a test that deletes and re-reads history catches a miss immediately.
- **`expectedCount` becomes a rubber stamp an agent fills in from a prior `brain_list`** → that is the intended workflow, not an abuse of it. The guarantee is "you deleted what you counted", not "you thought hard about it".
- **Merging into a deleted node** → currently unconstrained. The canonical-merge trigger should refuse it, or a merge could redirect live nodes into something invisible. Flagged as a task, not left to discovery.

## Migration Plan

One migration: add `nodes.deleted_at`, add `node_revisions.deleted_at`, replace the revision trigger function and its UPDATE trigger, and `CREATE OR REPLACE VIEW resolved_nodes` with the new predicate. All four in the same file — the view and the trigger are each frozen lists, and splitting them across migrations leaves a window where a delete is invisible to history or a deleted node is still returned.

Backfill is trivial: existing rows get `NULL`, which means "not deleted". No data rewrite, no downtime concern at this scale.

Rollback is dropping the column, which reverts the view and trigger with it. Any tombstoned node becomes live again, which is the correct interpretation of "this feature was removed."

## Open Questions

- **Whether a purge (hard-delete the tombstoned rows) is ever wanted, and who may run it.** Deferred deliberately: nothing needs it yet, and designing it now would mean guessing at a retention policy nobody has asked for. It does not change any interface decided here.
