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
apps/mcp        MCP server (shared HTTP, loopback by default, + stdio)
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

One long-running server on this machine serves every agent session, from any folder or herdr workspace, at `http://127.0.0.1:5320/mcp`. It listens on loopback unless told otherwise (see [Reaching Breakdown over the tailnet](#reaching-breakdown-over-the-tailnet)). Each client gets its own MCP session, so writes are still attributed to the client that made them.

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

## Reaching Breakdown over the tailnet

Both servers bind `127.0.0.1` by default and nothing changes for local sessions: a loopback request with a loopback `Host` needs no token. Exposing either one to other machines takes two flags and one token per client.

**Flags.** `--host <addr>` picks the bind address and `--allow-host <name>` (repeatable) names each hostname remote clients will use; both are flags under any supervisor, never environment variables.

```bash
pnpm mcp:serve --host 0.0.0.0 --allow-host breakdown.tail1234.ts.net
pnpm --filter @breakdown/web dev:server --host 0.0.0.0 --allow-host breakdown.tail1234.ts.net
```

A request whose `Host` is neither loopback nor allowed is refused with 403, token or not. An allowed name is accepted at the server's own port or with no port (a fronting proxy such as `tailscale serve` on 443), and a browser write must come from one of those same origins, so a page on another port of the host can't write. Bound off loopback with no `--allow-host`, the server starts but warns that every remote request will get 403.

Give Breakdown a dedicated hostname: browsers send a host's cookies to every port on it, so any other app served under the same name would receive Breakdown's token cookie. Never point a forwarder that adds no forwarding header at either server's loopback port: L4 forwarders (socat, `ssh -R`) and nginx's default `proxy_pass` (which rewrites Host and sends no `X-Forwarded-For`) make remote requests look local and bypass tokens entirely.

**Tokens.** Every request from off loopback needs a client token, on every path including `/healthz`, or gets 401. So does a loopback request whose `X-Forwarded-For`, `X-Real-IP`, or `Forwarded` header names a remote address: a proxy acting for someone else isn't the local machine. Mint one per client on the host, choosing its scope:

```bash
pnpm -s client-token create phone --scope human     # prints bdt_… once on stdout; only its hash is stored
pnpm -s client-token create worker-1 --scope agent
pnpm -s client-token list                           # client, scope, created, last used, live/revoked; never the token
pnpm -s client-token revoke phone
```

The scope is required. `human` is for a person's devices (phone, laptop): it works on the web API and MCP. `agent` is for workers and the driver: it works on MCP only, and the web API refuses it with 403, so an agent can't approve its own inbox request or decide a review.

`-s` keeps pnpm's `> pkg@version` banner off stdout, so `TOKEN=$(pnpm -s client-token create phone --scope human)` captures the token alone. The token is shown once and can't be recovered; lose it and revoke and re-create. Tokens can only be managed here: no MCP tool and no web API procedure creates, lists, or revokes one. A revoked token is refused on its next request, with no cache to wait out. `last_used_at` is updated at most once a minute per client, and still is when the server runs with `BRAIN_READ_ONLY=1`.

**MCP clients** send the token as a static header:

```bash
claude mcp add -s user --transport http brain http://breakdown.tail1234.ts.net:5320/mcp \
  --header "Authorization: Bearer bdt_…"
```

Without the header, a 401 may send Claude Code into OAuth discovery, which this server doesn't offer; check the header first when a remote client reports an auth flow. Writes from a token are attributed to its client and the MCP client's own name, e.g. `worker-1 via claude-code 2.1.0`.

**Browsers** connect once. A board opened from the tailnet with no cookie shows a connect screen; paste the client's token, and the server answers with an HttpOnly, SameSite=Strict cookie that carries every later request, images included. The token never goes in a URL (a query-string token is ignored), and revoking it ends the cookie too. Web writes from that browser are attributed to the client, e.g. `phone`. Only a `human` token can connect a browser. Remote browsers get the board from the web server itself once it serves the built client. Don't expose the Vite dev server with `--host`: its proxy passes the phone's address in `X-Forwarded-For`, so reads still need a token, but writes come from Vite's port, which isn't the API's origin, and are refused.

Host-side firewall and tailnet ACLs live in skyos (`sky-brx`), not here.

## Deploying as two containers

On a shared host (the SkyOS Jetson), Breakdown runs as two single-container apps configured by env, with data in named volumes:

- **`breakdown-db`**: the stock `pgvector/pgvector:pg16` image, with the Postgres settings below.
- **`breakdown`**: this repo's image (`Dockerfile`). Its entrypoint, `bin/container-launch.mjs`, runs migrations (retrying while the database starts), then the web server (serving the built client) and the MCP HTTP server as two children. If either one exits, the container exits non-zero so its supervisor restarts it.

The SkyOS app definitions live in skyos (`sky-brx.2`). `docker-compose.app.yml` runs the same two containers locally with the same env, caps, and volumes, under its own compose project (`breakdown`), so the dev database (`docker-compose.yml`, project `bd`) is never touched:

```bash
export BREAKDOWN_DB_PASSWORD=$(openssl rand -hex 24)   # keep it: it is fixed when the volume is first initialized
docker compose -f docker-compose.app.yml up -d --build --wait
docker compose -f docker-compose.app.yml exec -T breakdown node dist/token.mjs create phone --scope human
```

Always name the file with `-f docker-compose.app.yml`. A bare `docker compose` in this directory is the dev database.

### Caps

| App | memory (`mem_limit` = `memswap_limit`) | cpus | Inside |
| --- | --- | --- | --- |
| `breakdown-db` | 384m | 1.0 | Postgres with the settings below; `shm_size: 128m` |
| `breakdown` | 512m | 1.5 | V8 heap caps set by the launcher: web 160 MB, MCP 128 MB, migrate 96 MB (runs and exits before the servers start) |
| **total** | **896m** | | under 1 GB |

The heap caps bound the V8 heap only. Buffers and code space sit outside them, which is why they stay well under half the container's cap. Swap equals the memory limit, so a container at its cap is OOM-killed and restarted rather than paged.

`breakdown-db` runs with:

```
-c shared_buffers=96MB -c effective_cache_size=192MB -c work_mem=4MB
-c maintenance_work_mem=32MB -c max_connections=30 -c wal_buffers=4MB
```

`shared_buffers` is a quarter of the cap, and `effective_cache_size` tells the planner to expect half. The live pools (web 10 + MCP 10, plus a one-connection token CLI) stay under `max_connections`.

**Measured** by `pnpm smoke:app` on an Apple-silicon Mac (Docker Desktop, cgroup v2 `memory.peak`), after 51 `brain_map` calls and 100 tRPC reads against an empty store: `breakdown` peaked at 108.4 MiB of 512 MiB (21%) and `breakdown-db` at 87.9 MiB of 384 MiB (23%), with no OOM kills or restarts. This is a Mac measurement on an empty store. The Jetson figures come from `sky-brx`.

### Environment

The launcher reads these on the `breakdown` container and turns them into the servers' flags. The servers themselves still read only `DATABASE_URL`, `BRAIN_READ_ONLY`, and `WEB_SERVER_PORT`. An unset or empty variable takes its default.

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | required | `postgres://breakdown:<password>@breakdown-db:5432/breakdown` |
| `BREAKDOWN_HOST` | `0.0.0.0` | bind address for both servers |
| `BREAKDOWN_WEB_PORT` | `4310` | web server port |
| `BREAKDOWN_MCP_PORT` | `5320` | MCP server port (`/mcp`, `/healthz`) |
| `BREAKDOWN_ALLOW_HOSTS` | empty | comma-separated hostnames remote clients use; each becomes `--allow-host` on both servers |
| `BREAKDOWN_MEDIA_DIR` | `/data/media` | review media directory, one volume |
| `BRAIN_READ_ONLY` | unset | `1` refuses every write, as on the host |

`docker-compose.app.yml` also reads these on the machine running compose:

| Variable | Default | Meaning |
| --- | --- | --- |
| `BREAKDOWN_DB_PASSWORD` | required | the database password. Use hex (`openssl rand -hex 24`): it goes into `DATABASE_URL` unescaped. Postgres applies it only when the data volume is first initialized, so changing it later means changing it inside the database too. |
| `BREAKDOWN_PGDATA` | `breakdown-pgdata` | named volume or host path for Postgres data |
| `BREAKDOWN_MEDIA` | `breakdown-media` | named volume or host path mounted at `/data/media` |
| `BREAKDOWN_PUBLISH_ADDR` | `127.0.0.1` | host address both ports are published on |

**Publish each port at the number it listens on.** Admission accepts an allowed name only at the server's own listen port (or bare, behind a proxy that sends no port), so a port published as `8080:4310` makes every remote request a 403. To move a port, set `BREAKDOWN_WEB_PORT` or `BREAKDOWN_MCP_PORT`. Compose publishes the same number on both sides.

**Keep loopback in `BREAKDOWN_HOST`.** The image's healthcheck probes `http://127.0.0.1:<port>/healthz` inside the container, which admission trusts without a token. A bind that excludes loopback (a single tailnet address, say) leaves the container permanently unhealthy. The default `0.0.0.0` includes it.

A bind-mounted `BREAKDOWN_MEDIA` must be readable (and, for new reviews, writable) by uid 1000, the image's `node` user.

### Tokens in the container

The image carries the same token CLI, run with `exec` so it uses the container's `DATABASE_URL`:

```bash
docker compose -f docker-compose.app.yml exec -T breakdown node dist/token.mjs create phone --scope human
docker compose -f docker-compose.app.yml exec -T breakdown node dist/token.mjs create worker-1 --scope agent
docker compose -f docker-compose.app.yml exec -T breakdown node dist/token.mjs list
docker compose -f docker-compose.app.yml exec -T breakdown node dist/token.mjs revoke phone
```

`-T` keeps a TTY from adding a carriage return, so `TOKEN=$(…)` captures `bdt_…` alone. Requests from the host to the published ports are off loopback as far as the container is concerned, so they need a token too.

### Media

Until review media moves into the database (`bd-d38.6`), seed the media volume from the host's review directory:

```bash
docker cp ~/.local/share/breakdown/reviews/. "$(docker compose -f docker-compose.app.yml ps -q breakdown)":/data/media/
```

### Building for the Jetson

The image builds for linux/arm64 and linux/amd64 from one Dockerfile. A multi-platform build needs a `docker-container` builder:

```bash
docker buildx create --name breakdown-multi --driver docker-container
docker buildx build --builder breakdown-multi --platform linux/arm64,linux/amd64 -t <registry>/breakdown:<tag> --push .
```

### Smoke test

`pnpm smoke:app` (not part of `pnpm check`; it needs Docker) builds the image and starts the stack as project `breakdown-smoke` with a random password and ports 14310/15320. It mints a `human` and an `agent` token in the container and checks, from the host: `/healthz` on both servers is 401 with `WWW-Authenticate: Bearer` without a token, the human token gets 200 on the web and the agent token 403 there, and the agent token gets 200 on MCP. It also checks that the board's HTML and hashed assets are public, a tRPC read without a token is 401, and an MCP session initializes, calls `brain_map`, and closes. After some load it inspects both containers (memory limit set, swap equal to it, cpus set, not OOM-killed, never restarted, peak under the cap, total under 1 GB) and prints the limits-and-peaks table. It always removes its project and volumes at the end. `--keep` leaves them up. It refuses to run against the projects `bd` and `breakdown`.

## Inbox

A review queue for everything that needs a decision: email, Asana, Slack, Notion, Google Docs comments, GitHub reviews, Fathom action items, drafts from live Claude sessions, and the board's open reviews from every registered project. Open `http://localhost:5310/inbox` (with `pnpm dev` running). Keys: `j`/`k` move, `a` accept (the recommended option on a card), `c` message, `d` dismiss, `o` open session; `Ctrl/⌘+Enter` accepts and `+Shift` requests changes.

- **Needs me** lists pending inbox items and open board reviews together, by priority then age. A review counts as P1, since an agent is waiting on it. The chips above the list filter by source (`?source=review`, `?source=gmail`, …). A review decided here is written and notified exactly as from the board's drawer.
- **Cards.** An inbox item can carry the same decision card a review does (`question`, `options`, `recommend`, `on_accept`), shown and decided the same way. Accepting names the option, and the executor acts on it.
- **Undigested.** An item whose agent didn't declare reading its `url` (`metadata.read`, or `inbox request --read 'full|<url>'`) is held in the Undigested tab, out of Needs me. The next ingest pass reads it and releases it. You can also release it by hand or dismiss it.

Items are `inbox_item` nodes (`packages/core/src/inbox.ts`). The app makes no model call. Claude sessions fill and work the queue:

| What | How |
|---|---|
| Fill it from your connectors | `/inbox-ingest` in a Claude session in this repo (rules: `local/needs-me.yaml`, copied from `config/needs-me.example.yaml`) |
| Carry out accepted items | `/inbox-execute` |
| Queue a draft from any session | `inbox request --key session:<slug> --title ... --url <u> --read 'full|<u>' < body.md` (decision is prompted back into that herdr pane) |
| Close an item after acting | `inbox done <id> "<what you did>"` |
| Go deep on one item | **Talk it through ↗** (`o`): a new tab in herdr's `inbox` workspace with Claude primed on the item. It sends its draft back here with `inbox request`, and your Accept is prompted back into that tab. `pnpm dev` has to run inside herdr (or herdr's default socket must exist). |
| Make Accept act on its own | `inbox-watch` in a spare terminal: runs `claude -p` with `inbox-execute` (accepted) or the revise step (changes) for items no session owns |

Headless, e.g. from launchd/cron: `claude -p --mcp-config .mcp.json "/inbox-ingest"`. Put the CLIs on `PATH` once: `ln -sf "$PWD/bin/inbox" "$PWD/bin/inbox-watch" ~/.local/bin/`.

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

One card is one decision. Several decisions about one item are several cards in one call, `review-request <item-id> city.md budget.md logos.md` (up to six). Each card becomes its own review under the item, with its own Accept and its own prompt back to the requesting pane. Every card is validated, and every image copied, before anything is filed, and one notification and one board link cover the call. A review is found again by its card's key: the frontmatter `key`, else the filename stem (`budget.md` → `budget`). Re-running one card replaces only that review, so keep a card's filename, or set `key`, across revisions. A review filed before keys existed (and every `--summary` review) has none: a single card or the image form still reuses it, and a multi-card call leaves it alone and says so. A card review's title is its question. In the inbox's Needs me, reviews under the same item show together, grouped like inbox items about the same work item, and with them. Never render text, tables, or code to an image: put them in the card.

A card can carry video too: `{ kind: video, path: reel.mp4, poster: reel.jpg, caption: "Cut 1", option: A }`, where `path` and the optional `poster` image are relative to the card, as images are. Videos are mp4 or webm, at most 200 MB each (a `.mov` is refused with the `ffmpeg -i reel.mov -c copy reel.mp4` remux that fixes it); encode with `-movflags +faststart` so playback starts before the whole file loads. `option` names the card option the video is the cut of: the board shows every option's cut side by side in option order, the recommended one marked, so "which cut" is one card with one video per option. Each plays as a muted vertical reel with a Loop toggle and an Enlarge button, and while the review is open a "Note 0:07" button beside it adds its time (`B 0:07 ` for option B's cut) on a new line of the changes-requested message.

## Working on it

Specs live in OpenSpec, work lives in beads.

```bash
openspec list                      # active changes
openspec show add-knowledge-graph-core
bd ready                           # what can be worked on now
bd show bd-vt2                     # the core epic
```
