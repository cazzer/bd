## Why

Breakdown is becoming the shared board for hangar worker containers on the Windows desktop, the driver, the laptop and the phone, hosted on the always-on SkyOS Jetson (epic bd-d38; hangar `docs/plan.md` piece 1, A1–A2). Today both servers hard-bind loopback with no authentication, and there is no app image — only Postgres runs in a container, and MCP is supervised by a macOS LaunchAgent. The Jetson has about 1.9 GB of RAM free, so the whole stack has to run in containers with hard caps totalling under 1 GB.

## What Changes

- Both servers (web API, MCP HTTP) accept a configurable bind address. The default stays `127.0.0.1`, so nothing changes until an operator opts in. **BREAKING** for the spec, not for callers: "local only, no authentication" becomes "local by default; anything off loopback carries a token".
- Off-loopback exposure is opt-in per hostname: a request's `Host` must be loopback or a name the operator listed with `--allow-host`, which keeps the DNS-rebinding defence.
- Per-client bearer tokens (worker, driver, laptop, phone): random, shown once, stored only as a hash, revocable, and managed from a local CLI. Tokens are never minted over MCP or the web API. A request from a non-loopback peer without a valid token gets 401.
- The token's client name is recorded as the actor on every write it makes, on the MCP and web write paths alike.
- A browser on the tailnet (the phone) connects by pasting its token into a form once; the server answers with an HttpOnly cookie, and the token never appears in a URL.
- The two copies of the request guard become one shared implementation in `packages/core`.
- A multi-arch (linux/arm64, linux/amd64) app image runs migrations and then serves web and MCP from one container, with the web server also serving the built client. On the Jetson it runs as two SkyOS apps, `breakdown-db` (Postgres tuned for its cap) and `breakdown`, configured by env through the image's entrypoint launcher, with media in one directory. `docker-compose.app.yml` runs the same two containers locally. Features that need host-only binaries (`bd`, `herdr`) report themselves unavailable inside the container instead of crashing.
- A smoke test runs that stack under its caps on the Mac.

Out of scope: deploying to the Jetson, the SSD, Tailscale ACLs and ufw (skyos epic sky-brx), the session registry (bd-d38.3), and remote media upload (bd-d38.6).

Rejected alternatives:
- **Tailscale identity headers** (`tailscale serve` whois): tagged nodes carry no user identity, and workers share tags, so these headers can't tell one client from another.
- **mTLS**: per-client certificates are heavier to mint and rotate than a token. Claude Code's HTTP MCP config can send a header but not present a client certificate.
- **A shared secret in an environment variable**: it can't be revoked per client, can't attribute writes, and would grow the environment allowlist.

## Capabilities

### New Capabilities
- `client-access`: how a client other than the local machine reaches either server: opt-in bind and allowed hostnames, per-client tokens and their lifecycle, the browser connect flow, and write attribution to the token's client.
- `container-deploy`: the app image and the capped compose deployment, including the memory budget, configurable data paths, and graceful degradation of host-only features.

### Modified Capabilities
- `brain-mcp`: "HTTP mode is local only" is replaced by "HTTP mode is local by default"; off-loopback requests are admitted only under `client-access`.
- `local-web-api`: "Local only, no credential beyond the database" is replaced by "Local by default"; the bind address is configurable and off-loopback requests require a client token.

## Impact

- `apps/web/server` (index, dispatch, request guard, context, write routes) and `apps/mcp/src` (http-config, http-server, request guard, attribution).
- `packages/core`: the shared guard and token verifier, plus a token store.
- `packages/db`: a new `client_tokens` table and migration. `nodes` is untouched, so the `resolved_nodes` view needs no change.
- New CLI scripts: `pnpm token create|list|revoke`.
- New: `Dockerfile`, `.dockerignore`, `docker/launch.mjs`, `docker-compose.app.yml`, Postgres settings, a smoke-test script, and README deploy notes.
- CLAUDE.md: the architecture line saying "the host is loopback-only and enforced", and the adapters' copy-not-share note for the guard.
- No new environment variables read by the servers. The bind host and allowed hosts are flags. The container's launcher reads `BREAKDOWN_*` env and passes them on as flags.
