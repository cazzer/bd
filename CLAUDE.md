# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this project.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:6cd5cc61 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->


## Project

**breakdown** — a personal knowledge system ("personal brain") that Claude writes into and queries for progressive context discovery. Background and the decision log: `docs/architecture-handoff.md`.

## Workflow

Specs are driven by **OpenSpec**, work is tracked by **beads**. Both are deliberately temporary — absorbing them into breakdown itself is an explicit goal (`bd-98d`).

- Spec of record: `openspec/changes/<change>/` — proposal, capability specs, design, tasks. Run `openspec list`, `openspec status --change <name>`, `openspec validate <name> --strict`.
- Work of record: `bd ready` to find available work, `bd show <id>`, `bd update <id> --claim`, `bd close <id>`.
- Beads carry `--spec-id <change-name>` linking them back to the OpenSpec change. A task group in `tasks.md` maps to one bead; the checkbox list inside the group is the detail.
- New feature work starts with `/opsx:propose`, not with code.

## Build & Test

```bash
pnpm install
pnpm db:up        # docker: pgvector/pgvector:pg16 on :5432
pnpm db:migrate
pnpm check        # typecheck + tests
pnpm dev          # db:up + db:migrate, then the web app (API server + Vite client)
```

_Nothing is implemented yet — the first change (`add-knowledge-graph-core`) defines these scripts._

## Architecture Overview

pnpm monorepo, TypeScript, ESM, Node 22.

- `packages/db` — schema (drizzle) and SQL migrations. Postgres 16; the pgvector image is used only to keep embeddings additive later.
- `packages/core` — batch write path, full-text + graph retrieval.
- `apps/mcp` — MCP server: one shared Streamable HTTP server (`http.ts`, `127.0.0.1:5320/mcp` by default, a launchd service via `pnpm mcp:service`) that every local session binds to and token-holding tailnet clients may reach, plus the stdio entrypoint (`index.ts`) as fallback. Both go through `bootstrap.ts`, and they differ only in transport.
- `apps/web` — later; React editor writing to the node store.

Data model: typed `nodes` joined by `edges` that carry provenance (source system, ingest run) and a confidence weight, because most edges are agent-asserted. Node title and content are indexed by a generated `tsvector` column. Retrieval is one SQL statement: full-text search picks seeds, a recursive CTE expands a bounded, score-decayed subgraph.

**No model call anywhere in this codebase — not in the read path, not in the write path, not in a background job.** The app holds no model credential and takes no model dependency. The only environment variables it reads are `DATABASE_URL`, `BRAIN_READ_ONLY`, and `WEB_SERVER_PORT`; adding an API key of any kind is an architecture change, not a feature. The container launcher (`bin/container-launch.mjs`, the image's entrypoint) is deployment glue like the launchd plist: it alone reads `BREAKDOWN_*` env and passes it to the servers as flags, so the servers still read only those three. The HTTP server's port and bind host are command-line flags (`--port`, `--host`), not environment variables. The default bind is loopback. Exposure beyond it is opt-in — `--host` plus `--allow-host <name>` per name remote clients use, flags never env — and every off-loopback request needs a per-client token (`pnpm -s client-token create <client> --scope human|agent`, `list`, `revoke`), stored hashed in `client_tokens` and never minted, listed, or revoked through MCP or tRPC. A token's scope decides what it reaches: `human` the web API and MCP, `agent` MCP only (the web refuses it with 403).

Intelligence enters exclusively through MCP, from a session the user is already paying for by subscription. The agent is the loading and linking mechanism, not a runtime dependency: it reads source material, decides what matters and what relates to what, and writes nodes and explicit edges through the `brain_*` tools. "Run a linking pass on the repo I just imported" is a request a person makes to their own Claude session — never a job this app runs on their behalf.

Serving a query, and every write the app performs itself, is pure Postgres.

## Conventions & Patterns

- Writes are bulk-first: batched upsert keyed on `(source_system, external_id)`, idempotent across re-ingestion. Never row-at-a-time in an ingest path.
- `content_hash` drives the created/updated/unchanged counts reported back to a writing agent — never diff content in application code.
- A batch write is all-or-nothing. Partial success leaves an agent unable to tell what to retry.
- `node_type` is open text, not an enum — new kinds of node must not require a migration.
- Canonical-row joins go through the `resolved_nodes` view. Retrieval is the one deliberate exception: seed search scans `nodes` directly and folds via `coalesce(merged_into, id)`, because a text match on a merged-away row must return its survivor rather than vanish, and traversal folds edge endpoints the same way. Confined to the retrieval module; documented in its header.
- **Adding a column to `nodes` requires a `CREATE OR REPLACE VIEW resolved_nodes` in the same migration.** Postgres froze the view's `SELECT *` into an explicit column list at creation, so a new column is invisible to every read path until the view is replaced. This will bite when embeddings are revisited (`bd-55t`).
- No SQL passthrough tool is ever exposed to a model. New retrieval needs become real, validated tools.
- Request admission is one function, `packages/core/src/admission.ts`, shared by both HTTP servers — the one exception to the adapters' copy-not-share rule, because a drift there is a hole in the boundary. The token client is the actor on writes it admits: `<client> via <name> <version>` over MCP, `<client>` for web human writes; a loopback request keeps today's actor.
- Every change to a node's type, title, content, metadata, or merge pointer appends a full-snapshot row to `node_revisions`, written by a trigger on `nodes` — no write path can skip it and none needs to remember it. Revisions are append-only; what changed is computed on read (`getNodeHistory`), never stored.
- `mergeNodes` requires an `IngestRunHandle` and stamps `ingest_run_id` on every row it repoints, so the revision it produces names the run that merged. No write to `nodes` happens outside an ingest run.
- Work items are ordinary nodes of type `work_item` whose metadata obeys the contract in `packages/core/src/work-items.ts` (`status`, `priority`, `assignee`, `closed_at`, `closed_reason`, `spec_id`). The contract is enforced by `normalizeWorkItemMetadata` at every writer (the MCP write tool, `patchWorkItem`, the beads importer), never by the database, so `node_type` stays open text. Change a work item's fields with `patchWorkItem` (row lock, upsert path, revision recorded), not by re-sending the node.
- Dependency edges: `blocks` (source must close before target can be worked) and `child_of` (source is a child of target). A `blocks` edge that would form a cycle is refused by a trigger on `edges`; cycles a merge creates are reported by `getWorkItemReadiness`, which folds edge endpoints through `merged_into` like `lookup.ts` does. `child_of` is the one containment relation along which node settings inherit (beginning with `default_view`): an importer whose source has a hierarchy writes it as `child_of` and nothing else. `child_of` has no acyclicity trigger — a reader that walks it must terminate on a cycle by itself.
- Structured selection goes through `listNodes` (`brain_list`): filters and metadata predicates are validated data compiled to jsonb containment, served by `nodes_metadata_gin_idx`. No predicate language beyond `equals` and `oneOf` on top-level keys; add a predicate kind when a caller needs one, never an expression string.
- Views are ordinary nodes of type `view` whose metadata obeys the contract in `packages/core/src/views.ts`: `renderer` is one of `graph`, `feed`, `code`, `timeline`, and `filter` is the `listNodes` selection minus `limit`/`cursor` (validated by `resolveListNodesOptions` itself, never a second copy). Enforced by `normalizeViewMetadata` at every writer (the MCP write tool), never by the database. A node's default view is a plain `default_view` edge to a view node, asserted through the ordinary edge paths and owned by whoever asserted it, so a re-import of the governed node never erases it; a mis-targeted edge is ignored at resolution, not refused at write. `resolveDefaultViews` answers a batch in one statement: the nearest declaration along `child_of` wins, then the heavier edge, then the lesser view id; endpoints fold through `merged_into`; a `child_of` cycle is terminated by the depth cap (`MAX_RESOLVE_DEPTH`), never by the statement timeout.
- Any node's metadata may carry `occurred_at`, the moment a person would place it at on a timeline, under the contract in `packages/core/src/event-time.ts`: stored only in the `toISOString()` form (`2026-03-04T08:00:00.000Z` — UTC, milliseconds, fixed width, so text order is time order and no reader parses), from a string that carries a zone (`Z` or `±HH:MM`) or is a date alone (UTC midnight), or from a `Date`; `null` or absent deletes the key; anything else is refused naming the item and `occurred_at`. Enforced by `normalizeOccurredAt` at every writer — the MCP write tool on every item before its type's contract, `patchWorkItem`, the web's human writes (`createNote`, `annotateNode`, `updateNodeContent`), and the beads and GitHub loaders (which write their source's creation instant) — never by the database.
- Loaders and their source systems: `pnpm db:seed` writes `docs/` and `openspec/` markdown under `repo`; `pnpm ingest:github` under `github`; `pnpm ingest:beads` under `beads`; `pnpm ingest:repo <path> [--key <k>]` mirrors a git checkout under `git` — one `file` node per loaded tracked file (generated, oversized, binary, and missing files are counted as skipped, not stored), one `directory` node per ancestor on a loaded file's path, and a `repo` root whose external id is `<key>` alone; every entry is `<key>:<path>` (`packages/core/src/git-repo.ts`). `child_of` is the containment relation for file trees exactly as for work items: source is a child of target, exactly one per non-root node, so a walk upward is one indexed probe per level. The markdown seed and the git loader both hold `docs/**/*.md` and `openspec/**/*.md`, under different source systems and node types — intended duplication across systems, the case `brain_merge` exists for, not something a loader dedupes. A file removed from the checkout keeps its `git` node until the stale-node sweep lands (`bd-aow.3`).
