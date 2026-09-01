## Why

breakdown has no storage and no way for Claude to reach it. Every other planned piece — repo/Slack/Notion loading, the editor, self-hosting breakdown's own work state — depends on a node/edge store and a retrieval contract that returns a *relevant subgraph*, not a list of documents. Building that spine first means everything else plugs into something already proven by daily use.

## What Changes

- Add a Postgres 16 schema for nodes and edges, with provenance (source system, ingest run) and a confidence weight on every edge.
- Index node content for full-text search: a generated `tsvector` column with a GIN index, plus trigram matching as a fuzzy fallback.
- Add batch upsert as the primary write path (bulk-first, not row-at-a-time), keyed on a deterministic dedup key per source system.
- Add retrieval that combines both modes in a single query: text search selects seed nodes, then bounded recursive traversal expands a scored subgraph around them.
- Add an MCP server exposing search, read, navigation, batch write, link, and merge tools, so an agent on a model subscription can both load content into the brain and query it.
- Node typing is a generic discriminator from day one so work items, specs, and conversations can be represented later without a migration. No work-tracking behavior ships in this change.

## Non-Goals

- **No embeddings and no vector search.** The read path makes no model calls and requires no API credential. Semantic judgment happens at write time, performed by the agent loading content, and is captured as explicit edges. Adding pgvector later is additive — a new table and index, not a redesign.
- No standalone ingestor. The agent writing through MCP tools *is* the loading mechanism for now; dedicated repo/Slack/Notion adapters are later changes.
- No authentication. Single-user, local, trusted.

## Capabilities

### New Capabilities

- `knowledge-store`: the node/edge data model, provenance, full-text indexing, batch write path, and deterministic dedup and merge handling.
- `retrieval`: the query contract that turns query text into a scored, bounded subgraph via text search plus graph traversal.
- `brain-mcp`: the MCP tool surface an agent uses to search, read, navigate, write, link, and merge brain content.

### Modified Capabilities

None — this is the first change in the project.

## Impact

- New: `packages/db` (schema + migrations), `packages/core` (write + retrieval), `apps/mcp` (MCP server).
- New dependencies: Postgres 16, the MCP TypeScript SDK. No model or embedding provider.
- New local requirement: Docker, for the Postgres container.
- No existing code or data is affected.
