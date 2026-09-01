# breakdown

A personal knowledge system — a "personal brain" that Claude can write into and query for progressive context discovery.

Content is stored as typed **nodes** joined by **edges** that carry provenance and a confidence weight. Retrieval combines two modes in a single Postgres query: full-text search picks the entry points, graph traversal supplies the surrounding context.

There are no embeddings and no model calls in the read path. An agent on a model subscription is the *loading* mechanism — it reads source material, decides what matters, and writes nodes and explicit edges through MCP tools. Serving a query afterwards is pure Postgres, needing no credential beyond a connection string.

## Status

Nothing is implemented yet. The first change is fully specced.

- Background and decisions: [`docs/architecture-handoff.md`](docs/architecture-handoff.md)
- Current change: [`openspec/changes/add-knowledge-graph-core/`](openspec/changes/add-knowledge-graph-core/)
- Work queue: `bd ready`

## Stack

Postgres 16 (plain Docker container, not the Supabase CLI stack) · TypeScript, Node 22, ESM · pnpm monorepo · Model Context Protocol server · React editor, later.

```
packages/db     schema + migrations
packages/core   batch writes, full-text + graph retrieval
apps/mcp        MCP server (stdio)
apps/web        later
```

## Working on it

Specs live in OpenSpec, work lives in beads.

```bash
openspec list                      # active changes
openspec show add-knowledge-graph-core
bd ready                           # what can be worked on now
bd show bd-vt2                     # the core epic
```
