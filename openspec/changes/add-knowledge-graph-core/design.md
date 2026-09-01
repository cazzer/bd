## Context

Greenfield repo. Database and local-dev choices are recorded in `docs/architecture-handoff.md`: Postgres 16 in a single Docker container, no Supabase CLI stack, cloud path is any managed Postgres. See proposal.md for why this slice comes first.

The shaping constraint, decided after the handoff: **the read path makes no model calls and holds no API credential.** Semantic work happens at write time, performed by an agent on a model subscription that reads source material, decides what matters, and writes nodes and explicit edges through MCP tools. The database's job is to store that judgment and serve it back deterministically.

Everything else follows from that:

- Side-project scope. One developer, no ops budget, no services beyond Postgres.
- Tens of thousands of nodes, shallow traversal (2–3 hops).
- Edges arrive in bulk with confidence attached and are re-asserted on every re-load.
- The first client is Claude over MCP, so results are consumed as tokens — bounded output matters more than completeness.

## Goals / Non-Goals

**Goals:**

- One SQL query from query text to scored subgraph.
- A write path that survives repeated whole-source re-loading without duplicating anything.
- Batch-shaped tools, because the agent writes dozens of nodes per turn.
- Package boundaries that let `apps/web` and future loaders reuse `packages/core` without importing MCP concerns.

**Non-Goals:**

- Embeddings and vector search. See the decision below.
- Standalone ingestors. The agent is the loader for now.
- Authentication. Single-user, local, trusted.

## Decisions

### No embeddings; full-text search plus explicit edges

Retrieval seeds come from Postgres full-text search, not vector similarity.

- `nodes.search` is a `tsvector` **generated column**, `setweight(to_tsvector('english', title), 'A') || setweight(to_tsvector('english', content), 'B')`, with a GIN index. Generated means the store maintains it — no reindex step, no way for a caller to write a node that is not searchable.
- Queries parse through `websearch_to_tsquery`, which accepts quoted phrases, `or`, and `-exclusion` — syntax an agent can use deliberately. Scoring is `ts_rank_cd`; snippets come from `ts_headline`.
- `pg_trgm` provides a similarity fallback when full-text search returns zero rows, which covers typos and partial identifiers.

The recall that embeddings would have provided is recovered two ways. First, the agent can issue several differently-worded queries per question at no marginal cost under a subscription. Second, and more important, **edges carry the discovery load**: when the loading agent notices that two things relate, it writes that as an edge instead of hoping cosine distance rediscovers it later. That is a better artifact — typed, weighted, attributable — than a similarity score.

*Trade-off accepted:* pure paraphrase with no shared vocabulary will miss. A query for "how embeddings get refreshed" does not match "vectors are recomputed when the hash changes."

*Deliberately kept open:* the container image stays `pgvector/pgvector:pg16` even though no vector column is created. Adding embeddings later is `CREATE EXTENSION vector`, a new table, and an additional seeds CTE — additive, no migration of existing data, no container swap.

### Schema: three tables plus a view

`ingest_runs`, `nodes`, `edges`, and a `resolved_nodes` view. No chunk table — `ts_headline` produces snippets from the full document, so chunking would add a write path and a join for nothing.

- `nodes` is unique on `(source_system, external_id)`, the deterministic dedup key the idempotency requirement rests on. `node_type` is plain `text`, not an enum, so adding `work_item` or `spec` later needs no migration.
- `content_hash` lets the write path report created/updated/unchanged counts back to the agent without diffing content in application code.
- `edges` is unique on `(src_id, dst_id, edge_type, source_system)`, collapsing re-assertions from one system while keeping independent assertions from different systems. `ingest_run_id` records the most recent run that asserted it.
- Merges use a `merged_into` self-reference rather than deleting rows. The merged-away row stays, so its source keeps updating it by its own external id without resurrecting a duplicate. `resolved_nodes` follows the pointer so no call site has to.

*Alternative rejected:* a separate `entities` layer above `nodes`, with nodes as "mentions". Cleaner in theory, doubles every join and write path for a problem the merge tool already handles.

### Retrieval: seeds CTE + recursive expansion, one statement

```
WITH q AS (SELECT websearch_to_tsquery('english', $1) AS tsq),
seeds AS (          -- GIN scan over nodes.search, ranked, filtered
  ... ORDER BY ts_rank_cd(search, tsq) DESC LIMIT seed_limit
), expand AS (      -- RECURSIVE, depth-bounded, per-hop fanout capped
  ...
) SELECT nodes, edges FROM expand ORDER BY score DESC LIMIT node_budget
```

- Score decays as `parent_score * edge_weight * decay^depth`; ties break on node id so repeated queries are byte-identical.
- Cycles use Postgres's `CYCLE` clause rather than a hand-rolled visited array.
- Each hop applies a per-node fanout cap (`LATERAL ... ORDER BY weight DESC LIMIT n`) before the global node budget, so one hub cannot swamp the frontier.
- Traversal follows edges in both directions — a `mentions` edge is as useful backwards as forwards.
- Filters apply inside the seeds CTE *and* the recursive step.
- The trigram fallback is a second statement issued only when seeds come back empty. This is the one documented exception to single-round-trip; it costs nothing on the common path.

*Alternative rejected:* seed query in the app, then a second traversal query. Two round trips and the app re-implements scoring.

### Writes: batched upsert, all-or-nothing per batch

Batch writes use `INSERT ... ON CONFLICT DO UPDATE` over `unnest($1::uuid[], $2::text[], ...)` arrays, chunked at ~1,000 rows per statement, inside one transaction per batch. A constraint violation rolls back the whole batch and names the offending row — an agent that half-wrote 500 nodes cannot tell what it needs to retry, so partial success is worse than failure.

*Alternative rejected:* `COPY` into a temp table then merge. Faster above roughly 100k rows/batch, which this project is not near.

### Drizzle for schema and migrations, raw SQL for retrieval

`drizzle-orm` + `drizzle-kit` define the schema and generate SQL migrations, hand-edited to add the generated `tsvector` column and the GIN and trigram indexes. The retrieval query is raw SQL, typed by hand — it is the one query that will not survive a query builder.

*Alternative rejected:* Kysely (equally good, no codegen) and plain `pg` with hand-written migrations. Drizzle wins on not maintaining a migration runner.

### MCP: stdio transport, seven tools, no SQL tool

`apps/mcp` uses the MCP TypeScript SDK over stdio. Tools: `brain_search`, `brain_get`, `brain_neighbors`, `brain_map`, `brain_write`, `brain_link`, `brain_merge`. Zod validates every argument. There is deliberately no SQL passthrough — the spec forbids it, and every retrieval need it would serve should become a real tool.

`brain_map` exists because without nearest-neighbor search the agent navigates rather than guesses; it needs to see what node types, source systems, and edge types are actually in use before it can search well.

Agent writes are attributed to an ingest run with `source_system = 'agent'`, keeping agent-authored content separable and making a bad session's writes revertible as a unit.

Stdio covers Claude Code and Claude Desktop. HTTP transport is deferred until something needs it.

## Risks / Trade-offs

- **Lexical search misses paraphrase** → the agent issues multiple phrasings per question, `brain_map` exposes the actual vocabulary, and explicit edges carry relationships that wording would not surface. If this proves insufficient in practice, pgvector is additive; a follow-up bead tracks the decision point.
- **Traversal fan-out on hub nodes** → per-hop `LATERAL` fanout cap plus a global node budget; depth capped at 3 by default.
- **Agent-authored edges are unverified** → every edge carries `source_system` and `ingest_run_id`, so a bad run is identifiable and removable as a unit.
- **Merged nodes complicate every query** → all reads go through `resolved_nodes`, never resolving at the call site.
- **Bounded MCP responses can hide the best answer** → truncation always keeps the highest-scoring items and says explicitly that it truncated.
- **English-only text search configuration** → acceptable for a personal brain; the configuration is a column-level choice that can be revisited.

## Migration Plan

No existing data. `pnpm db:up` starts the container, `pnpm db:migrate` applies migrations, `pnpm db:seed` loads a small fixture set. Rollback is dropping the container's volume.

## Open Questions

- Whether the MCP server also runs over HTTP for a hosted deployment. Stdio covers the local case that matters now.
- Whether `brain_write` should accept markdown with inline `[[wiki links]]` and resolve them to edges automatically, or require explicit `brain_link` calls. Starting explicit; the convenience layer is additive and does not change the specs.
