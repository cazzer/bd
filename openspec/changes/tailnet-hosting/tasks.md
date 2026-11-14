## 1. Tailnet clients with per-client tokens (bd-d38.1)

- [x] 1.1 Migration `0006_client_tokens.sql` and drizzle schema for `client_tokens` (partial unique index on live `client`); schema test
- [x] 1.2 Token store in `packages/core`: create (refuses a live duplicate), list (no secrets), revoke, verify (hash lookup, throttled `last_used_at`); tests against the database with scoped fixtures
- [x] 1.3 Token CLI (`pnpm -s client-token create <client> --scope human|agent`, `list`, `revoke <client>`); prints the token once on stdout; test that the stored row holds only the hash
- [x] 1.4 Shared admission function in `packages/core` (design decision 2) with per-server Origin rule; unit tests for loopback, tailnet+token, foreign Host, missing/revoked token, foreign Origin, loopback peer with tailnet Host, public paths
- [x] 1.5 MCP: `--host` accepts any address, repeatable `--allow-host`; remove loopback-bind/peer refusals; http-server applies the shared function (401 with `WWW-Authenticate`, 403 as today); delete the local guard copy; tests updated
- [x] 1.6 MCP attribution: bind the token client to the session at initialize, refuse a different client on that session with 403, actor `"<client> via <name> <version>"`; tests
- [x] 1.7 Web: `--host`/`--port`/`--allow-host` flags (`WEB_SERVER_PORT` fallback), dispatcher applies the shared function, admitted client in tRPC context, human-write actors take it; delete the local guard copy; tests
- [x] 1.8 Web connect flow: `POST /auth/connect` sets the cookie (design decision 5); client shows a connect screen on 401; query-string tokens ignored; tests including cross-site POST with cookie → 403
- [x] 1.9 Test that no MCP tool and no tRPC procedure creates, lists, or revokes tokens
- [x] 1.10 Docs: CLAUDE.md architecture line on loopback/authentication and the guard's copy-not-share note; README section on exposing over the tailnet and managing tokens; `pnpm check` green

## 2. arm64 image and capped compose deploy (bd-d38.2)

- [ ] 2.1 Web server serves the built client statically when the build directory exists (index fallback, immutable hashed assets); `/healthz` on web; tests
- [ ] 2.2 Host-only binaries: `bd`/`herdr` ENOENT becomes a typed "unavailable" error everywhere they spawn; beads watcher tolerates a missing registry; startup test with neither on PATH
- [ ] 2.3 Multi-stage `Dockerfile` + `.dockerignore`: esbuild bundles for web, MCP, migrate, token CLI (tsx fallback recorded if needed), non-root runtime; `docker buildx build --platform linux/arm64,linux/amd64` succeeds
- [ ] 2.4 `docker-compose.jetson.yml`: postgres (tuned flags), migrate (one-shot gate), web, mcp with mem_limit/memswap_limit/cpus per design decision 7; publish address, allowed hosts, data and media paths as compose variables defaulting to loopback and named volumes; in-container healthchecks
- [ ] 2.5 Smoke test script: build, up, create a token, healthz with/without token from the host (200/401), an MCP initialize with the token, `docker stats` under each cap, down; run it on the Mac and record the measured peaks in the README
- [ ] 2.6 README deploy section (budget table, variables, token commands in the container); `pnpm check` green
