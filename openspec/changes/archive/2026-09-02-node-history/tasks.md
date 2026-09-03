## 1. Schema, trigger, and backfill

- [x] 1.1 Add `actor` (nullable text) to `ingestRuns` and a `nodeRevisions` table to `packages/db/src/schema.ts`: id, node_id (FK nodes, cascade on delete like edges), ingest_run_id (FK ingest_runs, no action), revision_no, node_type, title, content, content_hash, metadata, merged_into (plain snapshot, no FK), recorded_at; `UNIQUE (node_id, revision_no)` doubles as the index. Extend the file header's list of hand-written constructs
- [x] 1.2 Generate the additive migration with `pnpm db:generate` and confirm it contains only the column and the table
- [x] 1.3 Hand-write into that migration the `nodes_record_revision()` function, an `AFTER INSERT` trigger with no condition, and an `AFTER UPDATE` trigger whose `WHEN` compares only node_type, title, content, metadata, and merged_into — with a comment saying why not `OLD.* IS DISTINCT FROM NEW.*`
- [x] 1.4 Hand-write the backfill: revision one for every existing node from its current row, attributed to its `ingest_run_id`, with `recorded_at = updated_at`
- [x] 1.5 Write schema tests for the knowledge-store scenarios: insert yields revision one; content change yields revision two with the old content still in one; metadata-only change yields a revision; an identical re-write under a new run yields none; setting `merged_into` yields a revision; two concurrent updates get distinct consecutive numbers; a duplicate `(node_id, revision_no)` is rejected
- [x] 1.6 Run `pnpm db:migrate` against a store with existing nodes and verify every node has exactly one revision; then `pnpm check` green

## 2. Attribution and history in core

- [x] 2.1 Give `openIngestRun` an optional options argument carrying `actor`, surface `actor` on `ClosedIngestRun`, and leave every existing call site compiling unchanged
- [x] 2.2 Make `mergeNodes` take a required `IngestRunHandle` and set `ingest_run_id` in the same `UPDATE` that sets `merged_into`; update its tests and the one MCP caller so `pnpm typecheck` stays green
- [x] 2.3 Pass actors: `human` from the human write path, and the script name from `seed.ts` and `ingest-github.ts`
- [x] 2.4 Add `packages/core/src/history.ts` with `buildNodeHistoryQuery` and `getNodeHistory`: revisions newest-first, `limit` with a default and a maximum, a `before` cursor on revision number, `includeContent` defaulting to false, `changedFields` via `LAG`, and `metadataChanges` as `{ key: { before, after } }` over the union of top-level keys; the first revision reports every present field as changed; an unknown id raises `NodeNotFoundError`
- [x] 2.5 Write tests for the readable-history scenarios: a `status` flip reports the key with both values and title/content unchanged; content omitted by default and present on request; paging past the limit continues without repeat or gap; a merged-away node returns its own history including the merge revision; unknown id errors naming it; a merge under a run is attributed to that run
- [x] 2.6 Export the new function, types, and any new error from `packages/core/src/index.ts`, and confirm `pnpm check` is green

## 3. brain_history and client attribution in the MCP server

- [x] 3.1 Add an actor resolver to `ToolContext`, populated from the server's client info at call time, and have `withAgentIngestRun` pass it as the run's actor
- [x] 3.2 Wrap `brain_merge` in `withAgentIngestRun`, pass the run to `mergeNodes`, and include `ingestRunId` in its response
- [x] 3.3 Add the `brain_history` tool in `apps/mcp/src/tools/read.ts`: id, optional `limit`, `before`, and `includeContent`; `isWrite: false`; wrapped in `boundResponse` with a truncation note that says how to fetch older revisions
- [x] 3.4 Register the tool, and update the server instructions string and the entrypoint comment from seven tools to eight
- [x] 3.5 Write server tests: the tool is advertised and callable in read-only mode; a write from a client that introduced itself as `claude-code 2.1.0` records that actor on its run; write, re-write, and merge produce a history whose newest revision reports the right changed fields and actor; an oversized history is truncated with the note
- [x] 3.6 Add the history invariant and the merge-needs-a-run rule to the Conventions section of `CLAUDE.md` (AGENTS.md carries no Conventions section), add the missing `InvalidLookupOptionError` branch to the MCP error mapper, and confirm `pnpm check` is green
