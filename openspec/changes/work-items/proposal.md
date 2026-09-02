## Why

The store can hold a task but cannot run one. It has no way to ask "which open items have priority 1" without query text, no contract for what a task's status or priority even means, and no notion of one item blocking another. Those three gaps are exactly what beads provides today, and closing them is the prerequisite for `bd-98d`: representing this project's own work in breakdown and retiring the external tracker. `node-history` gave every change a record; this change gives the records something to be about.

## What Changes

- Add a **structured listing** read path: filter canonical nodes by node type, source system, updated-since, and validated predicates on top-level metadata keys (equals, one-of), ordered most-recent-first with keyset paging, and a GIN index on `nodes.metadata` so those predicates are indexed. Predicates are a validated shape, never an expression string.
- Define **work items** as a capability: node type `work_item` with a validated metadata contract (status, priority, assignee, closed_at, closed_reason, spec_id), defaults on creation, and closing rules. Add a **patch** primitive that changes specific fields in one attributed transaction through the existing upsert path, so content hashing, change counting, and revision history all hold.
- Define **dependency edges**: `blocks` (source blocks target) and `child_of` (source is a child of target). Reject any `blocks` edge that would make an item transitively block itself, naming the path. Add a **readiness** query: items that are open with no open blocker, items that are blocked and by what, and items caught in a cycle.
- Expose all of it over MCP as three tools — `brain_list`, `brain_ready`, `brain_update_work_item` — and make `brain_write` validate and default the work-item contract, and `brain_link` surface a cycle rejection as an actionable error.
- Add a **beads importer** (`pnpm ingest:beads`) that reads the tracker's JSON export into work items and `blocks`/`child_of` edges, so readiness can be checked against `bd ready` on this project's real backlog.

## Non-Goals

- **No replacement for `bd` yet.** No CLI, no short ids, no session hooks. The importer mirrors beads into the store; it does not write back.
- **No status history beyond what `node-history` already records.** A status change is a metadata revision; nothing new is stored.
- **No general query language.** Predicates are equality and membership on top-level keys. Ranges, nested paths, and full boolean logic are deliberately absent until a real query needs them.
- **No work-item UI.** The web app is untouched.
- **No enforcement of the work-item contract in the database.** `node_type` stays open text; the contract lives in the tools and the core module that the tools and the importer share.

## Capabilities

### New Capabilities

- `work-items`: what a work item is, how its fields change, what `blocks` and `child_of` mean, that blocking cannot form a cycle, and what "ready" means.

### Modified Capabilities

- `knowledge-store`: gains structured listing of canonical nodes by type, source, recency, and metadata predicates.
- `brain-mcp`: gains the listing, readiness, and work-item update tools; the write tool validates work items; the link tool refuses cycles.

## Impact

- `packages/db`: one additive migration — a GIN index on `nodes.metadata` and a trigger on `edges` rejecting `blocks` cycles. No column on `nodes`, so `resolved_nodes` is untouched.
- `packages/core`: new `list.ts` (listing), `work-items.ts` (contract, patch, readiness, edge constants), `ingest-beads.ts` (importer); new error classes; exports.
- `apps/mcp`: three new tools (eleven total), work-item validation in `brain_write`, cycle mapping in the error mapper.
- No new dependency, no new environment variable, no model call. The importer shells out to `bd`, as the GitHub importer shells out to `gh`.
