## Context

See proposal.md for motivation. Current state:

- `apps/web/server/index.ts` hard-codes `HOST = "127.0.0.1"` and reads its port from `WEB_SERVER_PORT`. `request-guard.ts` pins `Host` to loopback and checks `Origin` on writes; `dispatch.ts` applies it, then routes review images or tRPC.
- `apps/mcp/src/http-config.ts` refuses a non-loopback `--host`. `http-server.ts` refuses a non-loopback bound address and a non-loopback peer, then applies its own copy of the guard (which checks `Origin` on every method, because GET opens the SSE stream).
- The MCP actor is `"<clientInfo.name> <version>"` (`server.ts`). Web human writes open runs with source system `human` and actor `human` (`routers/write.ts`, `packages/core/src/inbox.ts`).
- The only app image is `pgvector/pgvector:pg16` in `docker-compose.yml`. MCP is supervised by launchd (`bin/mcp-service.mjs`). Review images and decisions shell out to `bd` and `herdr`, and the spawn paths already turn ENOENT into a "not found on PATH" message in places.

The CLAUDE.md constraints still hold: no model call, no new environment variable the app reads, bind settings are flags, and no SQL passthrough.

## Goals / Non-Goals

**Goals:**
- Remote clients authenticate with per-client tokens; local clients see no change.
- One guard implementation decides admission for both servers.
- The stack runs in under 1 GB with hard caps, on arm64 and amd64.

**Non-Goals:**
- TLS termination. WireGuard (the tailnet) encrypts transport, and `tailscale serve` can front HTTPS later without changing this design.
- Fine-grained token permissions. A token has one of two scopes (`human`, `agent`); see decision 3.
- Replacing herdr or beads inside the container (bd-d38.3, bd-98d).
- Host provisioning, ACLs, ufw, and deployment (sky-brx).

## Decisions

### 1. Bind and allowed hosts are flags; the default stays loopback

Both servers take `--host <addr>` (default `127.0.0.1`), `--port <n>`, and a repeatable `--allow-host <name>`. The web server keeps `WEB_SERVER_PORT` as a fallback when `--port` is absent, because the Vite proxy reads it. `parseHttpArgs` stops refusing non-loopback addresses. Instead, when bound off loopback with no `--allow-host`, startup logs a warning that only loopback `Host` values will pass, so the server is reachable but useless remotely until named; the operator gets told rather than getting a silent 403.

- *Alternative: an env var `BREAKDOWN_ALLOWED_HOSTS`.* Rejected: it grows the environment allowlist, and flags already carry bind settings under any supervisor.
- *Alternative: accept any `Host` when a token is present.* Rejected: DNS rebinding only needs a browser and a cookie, so the `Host` check must hold even for token-bearing requests.

### 2. Admission: loopback peer plus loopback Host is trusted; everything else needs a token

The shared guard is a pure function over `{ method, host, origin, peerIsLoopback, path, credential }` that answers `allow | forbidden(403) | unauthorized(401)`, in this order:

1. `Host` is not loopback-at-port and not allowed-at-port → 403.
2. `Origin` is present and its host is not loopback or allowed → 403. On web this applies to non-GET/HEAD only; on MCP to every method. A per-server option preserves each server's current rule.
3. Peer is loopback and `Host` is loopback → allow with no actor override. This is today's path.
4. The path is public (web client static files, `POST /auth/connect`) → allow.
5. Otherwise a credential is required. The adapter resolves it (bearer header first, then cookie; never the query string) to a client via the token store. Unknown, revoked, or missing → 401 with `WWW-Authenticate: Bearer`. Live → allow with that client.

Step 3 needs both conditions: a loopback peer that sends a tailnet `Host` (a sidecar, or `tailscale serve` proxying to loopback) must present a token, since the proxy hides the real origin.

The CGNAT range (100.64/10) is not checked: behind Docker's port mapping the peer is the bridge gateway, and token plus `Host` is the real boundary. The MCP server's "bound address must be loopback" and "peer must be loopback" checks are removed and replaced by this function.

- *Alternative: keep two guards and share only token lookup.* Rejected: bd-d38.1 asks for one implementation. The two guards already differed in subtle ways (`[::1]` and the Origin-on-GET rule), which is how copies drift. The copy-not-share convention stays for the rest of the adapters.

### 3. Token store in `client_tokens`, managed by a local CLI

Migration `0006_client_tokens.sql` creates `client_tokens(id uuid pk, client text not null, token_hash bytea not null unique, created_at timestamptz default now(), last_used_at timestamptz, revoked_at timestamptz)`, with a partial unique index on `client` where `revoked_at is null`, so a client name can be re-issued after revocation and the history stays. A token is `bdt_` plus base64url of 32 random bytes; the store holds `sha256(token)`. A slow hash isn't needed: the input has 256 bits of entropy, and verification runs on every request.

Verification is one indexed lookup (`token_hash = $1 and revoked_at is null`). `last_used_at` is updated only when it is null or older than 60 s, so steady traffic writes at most once a minute per client. There is no in-process cache, so revocation takes effect on the next request.

The CLI is `packages/core/src/cli/token.ts`, exposed as root `pnpm -s client-token create <client> --scope human|agent`, `list`, `revoke <client>` (not `pnpm token`: pnpm 10 has a built-in `token` command that shadows the script and hands off to `npm token`; `-s` keeps pnpm's `> pkg@ script` banner off stdout). It prints the token once, on stdout, and nothing else. In the container it runs as `docker compose exec web node dist/token.mjs …`. No tRPC procedure or MCP tool touches the table, and a test enumerates both surfaces to prove it.

- *Alternative: a token file on disk.* Rejected: revocation and last-use need a writer, and the database is already the one stateful dependency.

### 4. Attribution

The adapters carry the admitted client on the request (web: a tRPC context field; MCP: the session). The MCP actor thunk returns `"<client> via <clientInfo.name> <version>"` when a token client is bound, and today's string otherwise. A session records the token client at initialize. A later request on that session presenting a different live client gets 403, so one client can't continue another's session. Web human writes pass `actor: client ?? "human"` into the run they open; source systems are unchanged. The runs are opened in core (`human-writes.ts`, `inbox.ts`), so those functions gain a trailing `{ actor }` option — trailing, not an input field, so the zod-parsed browser input can never set it. Inbox request/complete over the web pass the client too, falling back to core's default. A board review decision opens no ingest run (it runs `bd`, and its effect arrives through the beads watcher), so it is not attributed here; passing `bd --actor <client>` is a follow-up.

### 5. Browser connect flow

The web client fetches tRPC as now. A 401 renders a connect screen: one password-style field and a submit button. It POSTs JSON `{ token }` to `/auth/connect`, which validates the token and sets `breakdown_token=<token>; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`. `Secure` is set only when the request arrived over HTTPS — the socket is encrypted, or a loopback peer (`tailscale serve`) sent `x-forwarded-proto: https`, which can only make the cookie stricter — since plain HTTP over WireGuard is the expected path. MCP accepts the cookie through the same credential parser; Origin-on-every-method keeps it inert cross-site. A request on an MCP session must present the same client that opened it (a tokenless loopback request on a token-bound session included), else 403. The cookie holds the token itself, so revocation ends it with no separate session table. `/auth/connect` passes the `Host` and `Origin` checks (it is a POST) but needs no credential. Review images (`<img src>`) ride the cookie.

- *Alternative: store the token in localStorage and attach a header.* Rejected: image tags can't carry headers, and script-readable storage widens the impact of an XSS bug.

### 6. Image: one container, a launcher, both servers

Scope revised 2026-11-13. On the Jetson, Breakdown runs as two SkyOS apps (skyos sky-brx.2): `breakdown-db` (stock `pgvector/pgvector:pg16` with our settings) and `breakdown` (this image). Both are single containers configured by env, with data in named volumes.

A multi-stage `Dockerfile` installs with pnpm, builds the client (`vite build`), bundles the server entrypoints, and ends in `node:22-bookworm-slim` as user `node`, carrying only runtime files and SQL migrations. The entrypoint is a small launcher (`bin/container-launch.mjs`). It reads `BREAKDOWN_*` env, runs migrations, starts the web and MCP servers as two child processes with flags (`--host`, `--port`, `--allow-host`, the client and media directories), forwards SIGTERM/SIGINT, and exits non-zero if either child exits. Node heap flags are set by the launcher.

The servers keep reading only `DATABASE_URL`, `BRAIN_READ_ONLY`, and `WEB_SERVER_PORT`. The launcher is deployment glue in the same role as the launchd plist, so the env allowlist rule still describes the app.

- *Alternative: both servers in one Node process.* Rejected. Each entrypoint owns its pool, signals, and fail-fast startup. Merging them couples their lifecycles in code, while two children keep them apart and still meet the one-container requirement.
- *Alternative: let the servers read `BREAKDOWN_*` env directly.* Rejected. It would grow the allowlist for every deployment knob, whereas flags already serve launchd, compose, and SkyOS alike.

The web server serves the built client when given a client directory (index fallback for client routes, immutable caching for hashed assets). Under `pnpm dev` it gets none, so Vite still serves there.

### 7. Caps and the local compose file

| App | memory cap | Notes |
| --- | --- | --- |
| breakdown-db | 384m | `shared_buffers=96MB`, `effective_cache_size=192MB`, `work_mem=4MB`, `maintenance_work_mem=32MB`, `max_connections=30`, `wal_buffers=4MB` |
| breakdown | 512m | web and MCP children, each with a heap cap well under half |

The total is 896m. The live pools (web 10 + MCP 10, plus a one-connection token CLI) stay under `max_connections`; migrate runs and exits before the servers start. `docker-compose.app.yml` runs the same two containers locally: same env, caps (`mem_limit` with `memswap_limit` equal to it, plus `cpus`) and named volumes, its own compose project name, ports published on `${BREAKDOWN_PUBLISH_ADDR:-127.0.0.1}` at the same numbers the servers listen on (decision 9). The existing `docker-compose.yml` stays the dev database. The SkyOS app definitions themselves live in skyos (sky-brx.2), not here.

### 8. Host-only binaries

Every spawn of `bd` or `herdr` maps ENOENT to a typed "unavailable" error naming the binary, which callers surface as a tRPC error rather than an unhandled rejection. The beads watcher starts with an empty registry when its registry path is absent, and logs that once. A startup test runs the web server with a PATH that holds neither binary.

### 9. Review-round amendments (group 1)

- **Scopes.** `client_tokens.scope` (`human` | `agent`, required at `create --scope`, migration 0007). The web dispatcher's policy accepts `human` only; an `agent` token there is 403 (not 401, so a browser holding one isn't looped back to the connect screen), and `/auth/connect` refuses it. MCP accepts both. Without this, a worker's MCP token also unlocked `inbox.decide` and review decisions on the web API: a worker could approve its own request.
- **Host and Origin authorities.** An allowed name matches `name:<listen port>` or bare `name` (a fronting proxy such as `tailscale serve` sends no port). An Origin on an allowed name must be one of those authorities (`http(s)://name:<listen port>` or `http(s)://name` on the default port); loopback Origins keep any port (the Vite client). This pins writes to the server's own origin: a page on another port of the same tailnet host can't use the cookie for writes. Cookies are still shared across a host's ports, so Breakdown should get a dedicated hostname (documented; sky-brx).
- **Forwarded requests aren't local.** Loopback trust (step 3) also requires that every `X-Forwarded-For` / `Forwarded` / `X-Real-IP` entry, if present, is loopback. Vite's proxy sets `xfwd`, so `pnpm dev --host` makes phone requests carry a token while local dev stays tokenless. An L4 forwarder (socat, `ssh -R`) can't be detected; documented.
- **Group 2 note.** The compose stack must publish each server on the same port number it listens on, or front it with a proxy that sends a bare Host.

## Risks / Trade-offs

- [The cookie holds a long-lived bearer secret] → It is HttpOnly and SameSite=Strict, writes are Origin-checked, and the token can be revoked per client. The phone's token can be revoked alone.
- [A plain HTTP cookie could be sniffed off the tailnet] → Only tailnet peers reach the published port once sky-brx applies its ACLs and ufw, and WireGuard encrypts the hop.
- [A loopback-trusted path behind a local proxy] → Step 3 requires a loopback `Host` too, so a proxy forwarding a tailnet `Host` is not trusted.
- [The 1 GB cap is a Mac measurement, not a Jetson one] → The smoke test asserts the caps hold on the Mac, and sky-brx (B2) measures on hardware.
- [Bundling surprises such as dynamic imports or `__dirname` in a dependency] → Fall back to tsx for that entrypoint, and record it in the task.

## Migration Plan

Merging changes nothing for existing local use: the default bind, the launchd service, and tokenless loopback all stay. Migration 0006 is additive. To expose: create tokens, run the compose stack with `BREAKDOWN_ALLOW_HOSTS` and `BREAKDOWN_PUBLISH_ADDR` set (sky-brx). To roll back: stop the stack. Dropping `client_tokens` is safe, since nothing else references it.
