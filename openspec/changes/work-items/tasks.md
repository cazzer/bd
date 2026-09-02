## 1. Index and cycle trigger

- [x] 1.1 Add a GIN `jsonb_path_ops` index on `nodes.metadata` to `packages/db/src/schema.ts` and generate migration `0003` with `pnpm db:generate`; if drizzle-kit does not round-trip the opclass, hand-write the index like the trigram ones
- [x] 1.2 Hand-write `edges_blocks_must_be_acyclic()` and its `BEFORE INSERT OR UPDATE OF src_id, dst_id, edge_type` trigger on `edges` (`WHEN NEW.edge_type = 'blocks'`): advisory transaction lock, endpoints folded through `merged_into`, self-block rejected, recursive walk with a bounded path, `check_violation` with the path in `DETAIL`; extend the schema header's list of hand-written constructs
- [x] 1.3 Schema tests: direct cycle rejected naming the path, self-block rejected, indirect cycle rejected leaving existing edges intact, an edge into a merged-away alias is folded when checking, a non-cyclic chain of three is accepted, a `mentions` edge between the same nodes is unaffected, and `EXPLAIN` on a containment query over a seeded batch uses the GIN index
- [x] 1.4 `pnpm db:migrate` on the dev store, then `pnpm check` green

## 2. Listing and work items in core

- [ ] 2.1 Add `packages/core/src/list.ts`: `buildListNodesQuery` and `listNodes` over `resolved_nodes` with nodeTypes, sourceSystems, updatedSince, metadata predicates (`equals` merged into one containment, `oneOf` as a disjunction), keyset cursor `{updatedAt, id}`, `limit` default 50 max 500, one-row-past-limit `hasMore`; `InvalidListOptionError` for bad options and predicates, validated before any SQL
- [ ] 2.2 Add `packages/core/src/work-items.ts`: `WORK_ITEM_NODE_TYPE`, `WORK_ITEM_STATUSES`, `BLOCKS_EDGE_TYPE`, `CHILD_OF_EDGE_TYPE`, `normalizeWorkItemMetadata` (defaults, validation, closing rules, pass-through keys) with `InvalidWorkItemError`
- [ ] 2.3 Add `patchWorkItem(db, run, id, patch)`: transaction, canonical resolution, `SELECT ... FOR UPDATE`, `NotAWorkItemError`, merge with `null` removing a key, normalize, write through the unsafe upsert kit, return action and before/after fields
- [ ] 2.4 Add `buildWorkItemReadinessQuery` and `getWorkItemReadiness(db, options)`: folded `blocks` endpoints, open-blocker definition, `CYCLE`-clause cycle members, ready ordered by priority then recency, blocked with open blocker ids, optional `specId` filter, limits with defaults and maxima
- [ ] 2.5 Tests for every scenario in the three delta specs that core can exercise: listing by type and value, membership, paging without repeat or skip, merged-away nodes absent, malformed predicate rejected before SQL; contract defaults, invalid status, closing stamps time, reopening clears; status patch leaves hash unchanged and records one revision, not-a-work-item, merged-away target patches the survivor, two concurrent patches both land; readiness with all blockers closed, one open blocker, non-work-item blocker, blocker on a merged alias, deferred and closed items, cycle through a merge
- [ ] 2.6 Export everything from `packages/core/src/index.ts`; `pnpm check` green

## 3. MCP tools

- [ ] 3.1 Add `brain_list` (read) in `apps/mcp/src/tools/read.ts`: nodeTypes, sourceSystems, updatedSince, `where` predicates, limit, cursor; bounded with a truncation note that says how to continue
- [ ] 3.2 Add `brain_ready` (read): optional specId and limits; bounded over the ready list
- [ ] 3.3 Add `brain_update_work_item` (write) in `apps/mcp/src/tools/write.ts`: id plus a patch of status, priority, assignee, closedReason, specId (null clears), attributed via `withAgentIngestRun`, returning action, before, after, ingestRunId
- [ ] 3.4 Make `brain_write` normalize every `work_item` item through `normalizeWorkItemMetadata` before `upsertNodes`, so a bad item rejects the whole batch naming the item and field
- [ ] 3.5 Map `InvalidWorkItemError`, `NotAWorkItemError`, `InvalidListOptionError`, and an `EdgeUpsertFailedError` whose cause is a `check_violation` from the cycle trigger to actionable messages in `apps/mcp/src/errors.ts`; update the instructions string and comments from eight tools to eleven
- [ ] 3.6 Server tests: three tools advertised, `brain_list` and `brain_ready` work read-only and `brain_update_work_item` is refused; list with predicate and cursor; write of a bad work item rejects the batch; link closing a cycle is refused naming the path; close a work item and see it in `brain_history` attributed to the run; readiness after a merge-created cycle
- [ ] 3.7 Add the work-item and dependency conventions to `CLAUDE.md`; `pnpm check` green

## 4. Beads importer and dogfood

- [ ] 4.1 Add `packages/core/src/beads.ts` (pure mapping: issue → `NodeInput`, dependency → `EdgeInput`, status/priority/owner/close fields, `parent-child` → `child_of`) and `packages/core/src/ingest-beads.ts` (shells out to `bd list --status=all --json`, one ingest run with actor `ingest:beads`, batch upsert, summary log), wired as `pnpm ingest:beads`
- [ ] 4.2 Unit tests for the mapping, including a row with an unknown status rejected by the contract and a dependency naming an issue outside the export skipped with a count
- [ ] 4.3 Run the importer against this project's tracker, then compare `brain_ready` with `bd ready` and record the result in the bead; `pnpm check` green
