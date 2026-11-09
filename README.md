# breakdown

A personal knowledge system — a "personal brain" that Claude can write into and query for progressive context discovery.

Content is stored as typed **nodes** joined by **edges** that carry provenance and a confidence weight. Retrieval combines two modes in a single Postgres query: full-text search picks the entry points, graph traversal supplies the surrounding context.

There are no embeddings and no model calls in the read path. An agent on a model subscription is the *loading* mechanism — it reads source material, decides what matters, and writes nodes and explicit edges through MCP tools. Serving a query afterwards is pure Postgres, needing no credential beyond a connection string.

## Status

Schema, write path, retrieval, and the MCP server are implemented and seeded with the repo's own docs (see Quickstart below). Dogfooding the MCP tools from a live session is next.

- Background and decisions: [`docs/architecture-handoff.md`](docs/architecture-handoff.md)
- Current change: [`openspec/changes/add-knowledge-graph-core/`](openspec/changes/add-knowledge-graph-core/)
- Work queue: `bd ready`

## Stack

Postgres 16 (plain Docker container, not the Supabase CLI stack) · TypeScript, Node 22, ESM · pnpm monorepo · Model Context Protocol server · React editor, later.

```
packages/db     schema + migrations
packages/core   batch writes, full-text + graph retrieval
apps/mcp        MCP server (shared loopback HTTP + stdio)
apps/web        later
```

## Quickstart

Requires Docker, Node ≥22.23.1, and pnpm (`packageManager` in `package.json` pins the exact version — `corepack enable` will pick it up).

### 1. Install and start Postgres

```bash
pnpm install
pnpm db:up        # starts pgvector/pgvector:pg16 on localhost:5442, waits for healthy
pnpm db:migrate   # applies schema migrations
```

`pnpm db:up`/`db:migrate` read `DATABASE_URL` from `.env` (copy `.env.example` if `.env` doesn't exist yet — the default already matches `docker-compose.yml`).

### 2. Seed the brain with this repo's own docs

```bash
pnpm db:seed
```

`db:seed` loads every `*.md` file under `docs/` and `openspec/` as a node, and derives edges from real structure: a markdown link between two ingested files becomes a `links-to` edge (weight 0.9), and OpenSpec's own directory convention — a change's `proposal.md`/`design.md`/`tasks.md`/`README.md` are the same change, and each capability's `specs/*/spec.md` belongs to that change's proposal, design, and tasks — becomes `part-of-change` edges (0.6); two files sharing a plain directory with no stronger signal get a `sibling` edge (0.3). It's idempotent — re-running it reports the same nodes as `unchanged` and creates no duplicate rows. Real output from this repo:

```
[seed] found 9 markdown file(s) under docs/, openspec/
[seed] nodes: 9 created, 0 updated, 0 unchanged
[seed] edges: 16 created, 0 updated (0 markdown link target(s) found, 0 resolved to an in-corpus node)
[seed]   by type: part-of-change=15, sibling=1
[seed] ingest run 93caa584-dcc2-439c-8577-4ca6c8f5fd4d (source_system=repo) closed: 9 nodes, 16 edges attributed
[seed] store totals: 9 nodes, 16 edges
[seed]   node types: openspec-spec=3, doc=2, openspec-design=1, openspec-proposal=1, openspec-readme=1, openspec-tasks=1
[seed]   edge types: part-of-change=15, sibling=1
```

Running it again reports `nodes: 0 created, 0 updated, 9 unchanged` and the same store totals (9 nodes, 16 edges) — edges have no `unchanged` state in the write path (an existing node/edge with no change still reports `updated`), but no row count grows.

### 3. Run the shared MCP server and point clients at it

One long-running server on this machine serves every agent session, from any folder or herdr workspace, at `http://127.0.0.1:5320/mcp`. It listens on loopback only and refuses any other bind address. Each client gets its own MCP session, so writes are still attributed to the client that made them.

Install it as a login service (macOS LaunchAgent: starts at login, restarted on any exit, retried every 10s until Postgres is up):

```bash
pnpm mcp:service install [--port 5320]   # also: status, restart, uninstall
curl -s http://127.0.0.1:5320/healthz     # 200 {"ready":true,...} or 503 naming the failure
```

- **Logs:** `~/Library/Logs/breakdown/brain.err.log`.
- **Running code:** the service runs whatever is checked out in the repo it was installed from, so run `pnpm mcp:service restart` after pulling. `status` reports the running process, its node and entrypoint, and whether it's behind `HEAD`.
- **Other platforms:** off macOS, run `pnpm mcp:serve --port <n>` under any supervisor. The server reads no macOS-specific path, and the port and host are command-line flags, not environment variables.

Then register it once per client, at user scope so every session sees it:

```bash
claude mcp add -s user --transport http brain http://127.0.0.1:5320/mcp
codex mcp add brain --url http://127.0.0.1:5320/mcp
```

Sessions that were already running need one reconnect (`/mcp`, or `claude --resume <id>`). After that, a server restart costs a client at most one transparent re-initialize. If a client doesn't re-initialize, run `/mcp` to reconnect.

**Stdio fallback.** For a client that can only launch a local process (the Claude desktop app's `claude_desktop_config.json`), or when the service is down, run the stdio entrypoint with absolute paths. GUI apps don't inherit the login shell's `PATH`, so the bare `pnpm`/`node` won't be found:

```json
{
  "mcpServers": {
    "brain": {
      "command": "/absolute/path/to/node",
      "args": ["--import", "/path/to/bd/apps/mcp/node_modules/tsx/dist/loader.mjs", "/path/to/bd/apps/mcp/src/index.ts"]
    }
  }
}
```

Use `command -v node` for the first path. Stdio output carries only JSON-RPC, so never wrap it in plain `pnpm run`: its `> pkg@version` preamble breaks the connection.

Either way, the server needs only `DATABASE_URL`, read from this repo's `.env`, and startup fails fast with an actionable message if the database is unreachable. Set `BRAIN_READ_ONLY=1` to disable `brain_write`/`brain_link`/`brain_merge`.

**Rollback.** Run `pnpm mcp:service uninstall`, then `claude mcp remove -s user brain` and re-add the stdio form: `claude mcp add -s user brain -- pnpm --silent --dir /path/to/bd --filter @breakdown/mcp run start`.

### 4. First query

Ask Claude something the seeded docs actually answer — e.g. "search the brain for why there are no embeddings." Claude calls `brain_search`; real output from this repo, trimmed for length:

```jsonc
{
  "mode": "exact",
  "seedCount": 4,
  "nodeCount": 9,
  "truncated": false,
  "nodes": [
    {
      "nodeType": "openspec-design",
      "externalId": "openspec/changes/add-knowledge-graph-core/design.md",
      "title": "add-knowledge-graph-core: Design",
      "score": 2,
      "isSeed": true,
      "snippet": "### No [[embeddings]]; full-text search plus explicit edges\n\nRetrieval seeds come from Postgres full..."
    },
    {
      "nodeType": "doc",
      "externalId": "docs/architecture-handoff.md",
      "title": "Personal Brain — Architecture Handoff",
      "score": 1.6,
      "isSeed": true,
      "snippet": "No [[embeddings]]. No model calls in the read path... no re-[[embedding]] when models change."
    },
    { "nodeType": "openspec-proposal", "externalId": "openspec/changes/add-knowledge-graph-core/proposal.md", "score": 0.8, "isSeed": true },
    { "nodeType": "openspec-spec", "externalId": "openspec/changes/add-knowledge-graph-core/specs/brain-mcp/spec.md", "score": 0.72, "isSeed": false, "edgePath": ["part-of-change"] }
    // ... 5 more nodes reached by traversal (README, the other two capability specs,
    // tasks.md, and docs/retrieval-query-design.md via the sibling edge), 16 edges total
  ]
}
```

The top two hits are exact full-text matches on `design.md` and `architecture-handoff.md` (both discuss "no embeddings" directly); everything else was reached by following `part-of-change`/`sibling` edges outward — no vector search involved.

## Visual reviews

An agent asks a person to accept screenshots with one command, run from a registered checkout or any git worktree of one:

```bash
review-request <item-id> --summary 'what to look at' shot-1.png shot-2.png [--board-url http://localhost:5310]
```

It files (or refreshes) a `review` child bead of the item, copies the images under `~/.local/share/breakdown/reviews/<project>/<bead-id>/`, opens the board's drawer for it in a new Chrome tab unless a breakdown tab is already open (then the review appears in that tab's review queue instead), and shows a herdr notification either way. It needs `pnpm dev` running here (it reads registered projects from the API server) and the checkout registered with `pnpm ingest:beads <path> --project <key>`. Put it on `PATH` once, from this repo:

```bash
ln -sf "$PWD/bin/review-request" ~/.local/bin/review-request
```

For a decision rather than a look (an architecture choice, a risky operational step, a pick between layouts), file a decision card instead: `review-request <item-id> <card.md>`. The card is one markdown file whose YAML frontmatter holds a `question`, `options` (each with a `label`, `what`, and `risk`), the `recommend`ed option, `on_accept` steps, and `attachments` (images, optionally a `before`/`after` pair; `mermaid` diagrams; `diff`s), and whose body is the evidence in markdown (tables, `diff` and `mermaid` fences), at most 300 words outside its fenced blocks: evidence for the decision, not a build log. The board shows the question and the recommendation first, with the evidence one expand away; Accept takes the recommended option and "Choose X" another, and the decision written back names it (`Accepted: B — <message>`). Examples and the full contract: [`fixtures/review-cards/`](fixtures/review-cards/README.md). A `--summary` over 280 characters is still filed, with a warning pointing to the card form.

## Working on it

Specs live in OpenSpec, work lives in beads.

```bash
openspec list                      # active changes
openspec show add-knowledge-graph-core
bd ready                           # what can be worked on now
bd show bd-vt2                     # the core epic
```
