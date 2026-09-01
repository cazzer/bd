## 1. Workspace and database

- [x] 1.1 Create the pnpm workspace: root `package.json`, `pnpm-workspace.yaml`, shared `tsconfig.base.json` (ESM, Node 22, strict), vitest config, and `packages/db`, `packages/core`, `apps/mcp` stubs
- [x] 1.2 Add `docker-compose.yml` running `pgvector/pgvector:pg16` (no vector column yet — keeps embeddings additive later), plus `.env.example` with `DATABASE_URL`, and `db:up` / `db:down` scripts
- [x] 1.3 Add drizzle-orm + drizzle-kit to `packages/db` with a `db:migrate` script that applies generated SQL migrations against `DATABASE_URL`
- [x] 1.4 Add a root `check` script (typecheck + test) and confirm `pnpm db:up && pnpm db:migrate` succeeds on an empty database

## 2. Schema

- [x] 2.1 Define `ingest_runs` and `nodes` (unique on `source_system, external_id`; `node_type` as open text; `title`, `content`, `content_hash`, `metadata`, `merged_into` self-reference)
- [x] 2.2 Hand-add the generated `search` tsvector column to the migration — `setweight(to_tsvector('english', title),'A') || setweight(to_tsvector('english', content),'B')` — with its GIN index
- [x] 2.3 Enable `pg_trgm` and add trigram indexes on `title` and `content` for the fuzzy fallback path
- [x] 2.4 Define `edges` with the unique constraint on `(src_id, dst_id, edge_type, source_system)`, the `weight BETWEEN 0 AND 1` check, and both directional lookup indexes
- [x] 2.5 Add the `resolved_nodes` view that follows `merged_into` and excludes merged-away rows, so every read path resolves merges in one place
- [x] 2.6 Write schema tests: duplicate edge from one source collapses, same edge from two sources is retained, out-of-range weight is rejected, generated tsvector updates on content change, title match outranks body match

## 3. Write path

- [ ] 3.1 Implement batched node upsert over `unnest(...)` arrays, chunked at ~1,000 rows in one transaction, returning created/updated/unchanged counts derived from `content_hash`
- [ ] 3.2 Implement batched edge upsert with weight validation that names the offending edge on rejection
- [ ] 3.3 Make batch failure all-or-nothing: a constraint violation rolls back the entire batch and identifies the offending row
- [ ] 3.4 Implement ingest run open/close with node and edge counts, and a query returning everything a run produced
- [ ] 3.5 Implement `mergeNodes(loser, survivor)`: set `merged_into`, keep the loser's rows and edge provenance intact, idempotent when re-applied
- [ ] 3.6 Write write-path tests: re-running an unchanged batch creates no duplicates and advances no timestamps; a changed node reports as updated; a bad row rejects the whole batch; merged-away nodes stop appearing in `resolved_nodes`

## 4. Retrieval

- [ ] 4.1 Write the seeds CTE: `websearch_to_tsquery` parsing, `ts_rank_cd` scoring, `ts_headline` snippets, relevance floor, seed limit, and the type/source/updated-since filters
- [ ] 4.2 Write the recursive expansion: bidirectional edge following, depth bound, `CYCLE` clause, `parent_score * edge_weight * decay^depth` scoring, per-hop `LATERAL` fanout cap ordered by edge weight
- [ ] 4.3 Assemble both into one statement returning seed nodes, expanded nodes, connecting edges, and each node's inclusion provenance (seed relevance or path from seed)
- [ ] 4.4 Implement the trigram fallback: issued only when the seeds CTE returns empty, results flagged as fuzzy
- [ ] 4.5 Implement the store summary query: node types, source systems, and edge types with counts, plus recently updated nodes
- [ ] 4.6 Write retrieval tests over a fixture graph: phrase and exclusion syntax, depth bound, node budget keeps top scorers, cycle visited once, hub fanout cap, byte-identical repeated results, source filter excluded, fuzzy fallback on a misspelling, empty result when both modes fail

## 5. MCP server

- [ ] 5.1 Scaffold the stdio MCP server with startup validation that exits with an actionable message when the database is unreachable, requiring no credential beyond `DATABASE_URL`
- [ ] 5.2 Implement `brain_search`, `brain_get`, `brain_neighbors`, and `brain_map` with Zod-validated arguments and documented defaults echoed in the response
- [ ] 5.3 Implement `brain_write` and `brain_link` accepting either a single item or a batch, attributing writes to an ingest run with `source_system = 'agent'` and reporting created/updated/unchanged counts
- [ ] 5.4 Implement `brain_merge`, idempotent when the merge already holds
- [ ] 5.5 Implement read-only mode: write, link, and merge tools unadvertised and refused with an explanatory error
- [ ] 5.6 Implement response budgeting: keep highest-scoring items, state that truncation occurred, and return the means to fetch the remainder
- [ ] 5.7 Register the server in the repo's `.mcp.json` and smoke-test every tool from a Claude Code session

## 6. Dogfood

- [ ] 6.1 Write a `db:seed` script loading `docs/` and `openspec/` markdown as nodes with `mentions` edges, so the brain has real content before any agent writes to it
- [ ] 6.2 Write the README quickstart: clone, `db:up`, `db:migrate`, `db:seed`, register MCP, first query
- [ ] 6.3 Have a Claude session load a real source through `brain_write`/`brain_link`, then query it back, and file follow-up beads for what retrieval gets wrong
