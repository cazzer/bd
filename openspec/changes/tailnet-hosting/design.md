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
- Token scopes or roles: every live token has full access, as a loopback client has today.
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

The CLI is `packages/core/src/cli/token.ts`, exposed as root `pnpm token create|list|revoke <client>`. It prints the token once, on stdout, and nothing else. In the container it runs as `docker compose exec web node dist/token.mjs …`. No tRPC procedure or MCP tool touches the table, and a test enumerates both surfaces to prove it.

- *Alternative: a token file on disk.* Rejected: revocation and last-use need a writer, and the database is already the one stateful dependency.

### 4. Attribution

The adapters carry the admitted client on the request (web: a tRPC context field; MCP: the session). The MCP actor thunk returns `"<client> via <clientInfo.name> <version>"` when a token client is bound, and today's string otherwise. A session records the token client at initialize. A later request on that session presenting a different live client gets 403, so one client can't continue another's session. Web human writes pass `actor: client ?? "human"` into the run they open; source systems are unchanged. `inbox.ts`'s human paths gain an optional actor parameter for this.

### 5. Browser connect flow

The web client fetches tRPC as now. A 401 renders a connect screen: one password-style field and a submit button. It POSTs JSON `{ token }` to `/auth/connect`, which validates the token and sets `breakdown_token=<token>; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`. `Secure` is set only when the request arrived over HTTPS, since plain HTTP over WireGuard is the expected path. The cookie holds the token itself, so revocation ends it with no separate session table. `/auth/connect` passes the `Host` and `Origin` checks (it is a POST) but needs no credential. Review images (`<img src>`) ride the cookie.

- *Alternative: store the token in localStorage and attach a header.* Rejected: image tags can't carry headers, and script-readable storage widens the impact of an XSS bug.

### 6. Image: bundle with esbuild, one image, two commands

A multi-stage `Dockerfile` does the following:
- **Deps stage:** `pnpm install --frozen-lockfile`.
- **Build stage:** `vite build` for the client; esbuild bundles `apps/web/server/index.ts`, `apps/mcp/src/http.ts`, `packages/db` migrate, and the token CLI into `dist/*.mjs`, with `pg` and other packages that have native or optional pieces left external.
- **Runtime stage:** `node:22-bookworm-slim`, production deps for the externals, `dist/`, the client build, the SQL migrations, and user `node`.

Bundling avoids tsx's esbuild-at-startup cost and keeps resident memory down. If a dependency resists bundling, tsx in the runtime is the fallback; the task records which was used. Node runs with `--max-old-space-size` set below each service's limit, through the compose `command`, not env.

The web server gains a static handler for the built client (index fallback for client routes, immutable caching for hashed assets). It is used only when the client build directory exists, which is never true under `pnpm dev`, so Vite still serves in dev.

### 7. Compose budget

`docker-compose.jetson.yml` (the existing `docker-compose.yml` stays the dev database):

| Service | mem_limit / memswap_limit | cpus | Notes |
| --- | --- | --- | --- |
| postgres | 384m | 1.0 | `shared_buffers=96MB`, `effective_cache_size=192MB`, `work_mem=4MB`, `maintenance_work_mem=32MB`, `max_connections=30`, `wal_buffers=4MB`, `shm_size: 128m` |
| migrate | 128m | 0.5 | one-shot; `service_completed_successfully` gates the servers |
| web | 256m | 1.0 | `--max-old-space-size=160` |
| mcp | 256m | 1.0 | `--max-old-space-size=160` |

The long-running total is 896m, and migrate exits before the servers start. Pools are sized so the sum (web + mcp + migrate) stays under `max_connections`.

Inside the containers the servers bind `0.0.0.0` with `--allow-host` taken from the compose variable `BREAKDOWN_ALLOW_HOSTS`. Published ports bind `${BREAKDOWN_PUBLISH_ADDR:-127.0.0.1}` on the host, so the stack is also loopback-only on the host until the operator points it at the tailnet address. Data paths are `${BREAKDOWN_PGDATA:-breakdown-pgdata}` and `${BREAKDOWN_MEDIA:-breakdown-media}`; these are compose interpolation and never reach the app's environment. `DATABASE_URL` is `postgres://breakdown:${BREAKDOWN_DB_PASSWORD:?}@postgres:5432/breakdown`. `restart: unless-stopped` supervises the services. Healthchecks run inside each container against loopback, so they need no token.

### 8. Host-only binaries

Every spawn of `bd` or `herdr` maps ENOENT to a typed "unavailable" error naming the binary, which callers surface as a tRPC error rather than an unhandled rejection. The beads watcher starts with an empty registry when its registry path is absent, and logs that once. A startup test runs the web server with a PATH that holds neither binary.

## Risks / Trade-offs

- [The cookie holds a long-lived bearer secret] → It is HttpOnly and SameSite=Strict, writes are Origin-checked, and the token can be revoked per client. The phone's token can be revoked alone.
- [A plain HTTP cookie could be sniffed off the tailnet] → Only tailnet peers reach the published port once sky-brx applies its ACLs and ufw, and WireGuard encrypts the hop.
- [A loopback-trusted path behind a local proxy] → Step 3 requires a loopback `Host` too, so a proxy forwarding a tailnet `Host` is not trusted.
- [The 1 GB cap is a Mac measurement, not a Jetson one] → The smoke test asserts the caps hold on the Mac, and sky-brx (B2) measures on hardware.
- [Bundling surprises such as dynamic imports or `__dirname` in a dependency] → Fall back to tsx for that entrypoint, and record it in the task.

## Migration Plan

Merging changes nothing for existing local use: the default bind, the launchd service, and tokenless loopback all stay. Migration 0006 is additive. To expose: create tokens, run the compose stack with `BREAKDOWN_ALLOW_HOSTS` and `BREAKDOWN_PUBLISH_ADDR` set (sky-brx). To roll back: stop the stack. Dropping `client_tokens` is safe, since nothing else references it.
