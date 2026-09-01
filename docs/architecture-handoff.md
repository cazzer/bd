# Personal Brain — Architecture Handoff

> Source: chat session handoff, 2026-08-31. Reproduced verbatim below, followed by
> decisions made after the handoff. This file is the historical record; live specs
> live in `openspec/`, live work lives in beads (`bd`).

Side-project scope. Web-based build. Goal: a personal knowledge system that Claude can write into (via ingestion of repos, Slack, Notion, etc.) and query for progressive context discovery.

## Core decisions

**Database: Postgres + pgvector**
- Not a dedicated graph DB (Neo4j, Kùzu) — too heavy ops-wise for side-project scope, and traversal depth here is shallow (few hops), which recursive CTEs handle fine.
- Not SurrealDB — promising multi-model fit (native graph + vector), but younger and less proven at combined vector+graph workloads. Worth revisiting if Postgres CTEs start feeling limiting.
- Chosen because ingestion (repo/Slack/Notion) produces relationships that are mostly *discovered* via semantic similarity, not manually declared. Need vector search (pgvector, HNSW index) and graph traversal (edges + recursive CTEs) joinable in a single query — this is the standard hybrid RAG + knowledge graph pattern.

**Local dev: plain Postgres container, not Supabase CLI**
- Supabase CLI local dev spins up ~10+ containers (auth, storage, realtime, imgproxy, Studio, etc.) — unnecessary overhead when only Postgres+pgvector is needed.
- Run instead:
  ```
  docker run -d --name pg -p 5432:5432 -e POSTGRES_PASSWORD=x pgvector/pgvector:pg16
  ```
- Migration path to cloud: point connection string at Supabase Cloud (or Neon/RDS) later — schema and SQL are unchanged since it's just Postgres. Not locked into Supabase specifically; only locked into Postgres+pgvector, which any managed provider supports.
- Adopt the rest of the Supabase stack (auth, storage, realtime, Studio) only if/when those specific features are actually needed.

**Editor: skip Obsidian, build/use a lightweight markdown-serializing React editor**
- Obsidian's graph view is a visualization, not a query engine — no edge types, properties, or traversal API. Doesn't fit "Claude queries relationships programmatically."
- Since the graph DB does relationship work, Obsidian's remaining value is polished editing UX + mobile app + plugin ecosystem — not essential for this build.
- Options: tiptap or Plate, writing directly to the DB/files rather than through Obsidian's markdown/link conventions. Cuts a translation layer.

## Schema notes

- **Edges need provenance**, not just adjacency: `edges(source_id, target_id, type, weight, source_system, created_at)` — track which ingestion run/system created each link (repo vs Slack vs Notion), plus a confidence/weight score since many edges will be LLM-inferred.
- **Entity resolution/dedup** (same entity mentioned across repo + Slack + Notion) is an application-layer concern, not something the DB solves — plan for a merge step in the ingestion pipeline.
- **Bulk writes**: design ingestion jobs around batch inserts/upserts (`COPY`, batch upsert), not row-at-a-time, given expected scale of 10s of thousands of interrelated items.

## Query pattern for Claude/MCP access

Progressive discovery = hybrid query: vector similarity search to find candidate nodes, then graph traversal (recursive CTE) to expand context from those candidates — ideally combinable in one SQL query. Claude's tool should query the DB directly (SQL), not the filesystem — this is what makes progressive discovery actually work rather than relying on grep/regex heuristics over markdown.

## Open items (not yet decided)
- Whether Claude queries live during conversations (needs a running query service) vs. periodic pre-fetch/context loading.
- Editor library choice (tiptap vs Plate) and markdown serialization approach.
- Entity resolution strategy across ingestion sources.

---

# Decisions after the handoff (2026-08-31)

These were settled when the repo was scaffolded.

| # | Decision | Rationale |
|---|---|---|
| 1 | **Project name: breakdown.** Repo at `~/dev/bd`. | Beads issue prefix `bd`. |
| 2 | **First slice: schema + MCP query/write server.** | Claude is the first client. The hybrid query engine is the novel part; UI and ingestors plug into a proven core. Editor and repo/Slack/Notion ingestors come after. |
| 3 | **pnpm monorepo, TypeScript.** `packages/db`, `packages/core`, `apps/mcp`; `apps/web` added when editor work starts. | Keeps the MCP server deployable without dragging the UI along. |
| 4 | **Self-hosting: design for it, don't build it yet.** Generic `node_type` discriminator that can later represent work items, specs, and conversations. | breakdown is meant to eventually absorb the work/context state currently held by beads and OpenSpec. Modeling the discriminator now avoids a migration; building work-tracking features now is premature. |
| 5 | **Process: OpenSpec drives specs, beads tracks work — initially.** | Both are stepping stones. `openspec/changes/*` is the spec of record; `bd` issues are the work of record. Migrating both into breakdown is an explicit long-term goal, not a near-term task. |
| 6 | **No embeddings. No model calls in the read path.** Retrieval seeds come from Postgres full-text search (`tsvector` + GIN, `websearch_to_tsquery`, `ts_rank_cd`, `ts_headline`), with `pg_trgm` as a fuzzy fallback. | This reverses the handoff's pgvector assumption. The agent is the *loading* mechanism, not a runtime dependency: Claude reads source material on a model subscription, decides what matters, and writes nodes and explicit edges through MCP. The database stores that judgment and serves it deterministically — no API credential, no per-token cost, no re-embedding when models change. Semantic relationships become typed, weighted, attributable edges instead of cosine distance. |
| 7 | **pgvector image kept, no vector column created.** | Adding embeddings later is `CREATE EXTENSION vector`, a new table, and an extra seeds CTE — additive, no data migration, no container swap. Tracked as `bd-55t`, with the decision gated on real dogfooding evidence. |

| 8 | **No model call anywhere in the codebase — generalised from "not in the read path".** The app holds no model credential and takes no model dependency; its only env vars are `DATABASE_URL`, `BRAIN_READ_ONLY`, `WEB_SERVER_PORT`. | The earlier wording permitted a background job or write-path service with an API key, which would reintroduce exactly the per-token cost and credential dependency the design exists to avoid. Intelligence arrives only through MCP from a subscription-billed session. Ingestion splits accordingly: **extraction** is deterministic and scripted (loaders produce nodes and structural edges, idempotently, for free), **interpretation** is an agent asking itself what relates to what — invoked by a person saying "run a linking pass on this", never scheduled by the app (`bd-k7z`). |

## Still open

- Live query during conversations vs. periodic pre-fetch (leaning live, via MCP).
- Editor library (tiptap vs Plate) — deferred until the web app slice.
- Entity resolution strategy — deterministic dedup keys plus a `brain_merge` tool the loading agent calls when it notices a duplicate. Automatic candidate detection is deferred (`bd-8fu`).
- Whether lexical recall is enough in practice, or embeddings need to come back (`bd-55t`).
