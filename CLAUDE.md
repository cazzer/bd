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
```

_Nothing is implemented yet — the first change (`add-knowledge-graph-core`) defines these scripts._

## Architecture Overview

pnpm monorepo, TypeScript, ESM, Node 22.

- `packages/db` — schema (drizzle) and SQL migrations. Postgres 16; the pgvector image is used only to keep embeddings additive later.
- `packages/core` — batch write path, full-text + graph retrieval.
- `apps/mcp` — MCP server over stdio; the first client of the brain.
- `apps/web` — later; React editor writing to the node store.

Data model: typed `nodes` joined by `edges` that carry provenance (source system, ingest run) and a confidence weight, because most edges are agent-asserted. Node title and content are indexed by a generated `tsvector` column. Retrieval is one SQL statement: full-text search picks seeds, a recursive CTE expands a bounded, score-decayed subgraph.

**No model call anywhere in this codebase — not in the read path, not in the write path, not in a background job.** The app holds no model credential and takes no model dependency. The only environment variables it reads are `DATABASE_URL`, `BRAIN_READ_ONLY`, and `WEB_SERVER_PORT`; adding an API key of any kind is an architecture change, not a feature.

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
