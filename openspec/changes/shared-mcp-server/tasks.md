## 1. Shared bootstrap, stdio unchanged

- [x] 1.1 Move the startup sequence out of `apps/mcp/src/index.ts` into `apps/mcp/src/bootstrap.ts`: resolve `DATABASE_URL`, parse `BRAIN_READ_ONLY`, create the pool, verify it, and exit fail-fast with the existing messages. It returns `{ db, pool, readOnly, target }`. `index.ts` becomes bootstrap plus `StdioServerTransport` with identical behavior (design.md decision 1).
- [x] 1.2 `startup.test.ts` still passes unchanged: the first stdout byte is `{` and `ready on stdio` goes to stderr. Add a test that stdio writes still record the client actor.
- [x] 1.3 `pnpm check` passes (apps/mcp 115/115; the full run is red only on the work-items DAG test, which also fails on main: bd-aia)

## 2. HTTP mode

- [x] 2.1 `apps/mcp/src/http-config.ts`: parse `--port` (integer 0–65535, where 0 is an ephemeral port chosen by the OS; default 5320) and `--host` (only `127.0.0.1`, `::1`, or `localhost`, default `127.0.0.1`). A bad value exits naming it, and a non-loopback host exits with the "network exposure is not supported" message (design.md decisions 4–5).
- [x] 2.2 `apps/mcp/src/request-guard.ts`: a copy of the web API's `isAllowedRequest` pinned to the MCP port, with its own tests: foreign Host → refused, foreign Origin → refused, absent Origin → allowed, `localhost`/`127.0.0.1` Host case-folded.
- [x] 2.3 `apps/mcp/src/http-server.ts` (started by the `http.ts` entrypoint): a `node:http` server on the parsed host and port. The guard runs before routing (403). `/mcp` routes POST/GET/DELETE through a session map (one `StreamableHTTPServerTransport` and one `createServer(db, { readOnly })` per session, `randomUUID` ids, an unknown id → 404). `EADDRINUSE` exits naming the port. The `ready on http://…` line goes to stderr (design.md decision 2).
- [x] 2.4 Session lifetime: `lastSeen` per session, a 10-minute sweep closing sessions idle for more than 7 days, and a cap of 256 with least-recently-seen eviction, all as constants (design.md decision 3).
- [x] 2.5 `GET /healthz`: `select 1` with a 2s timeout. Returns 200 `{ ready: true, readOnly, database }` or 503 naming the failure, and the process stays up (design.md decision 6).
- [x] 2.6 `apps/mcp/package.json` gains a `serve` script. Root `package.json` gains `mcp:serve`.
- [x] 2.7 Tests that start the real server on an ephemeral port against the test database, with fixtures scoped to their own source/external ids and no assertions on global counts:
  - two clients with different `clientInfo` each write, and each ingest run names its own actor
  - `tools/list` over HTTP equals stdio's
  - a stale session id gets 404, then re-initialize succeeds
  - foreign Host/Origin get 403 with nothing written
  - a non-loopback `--host` exits before listening
  - an occupied port exits naming it
  - `/healthz` returns 200, then 503 with a pool pointed at a dead port
  - read-only mode over HTTP refuses writes
- [x] 2.8 `pnpm check` passes (apps/mcp 176/176 across 3 runs; the full run is red only on bd-aia)

## 3. macOS service

- [x] 3.1 `bin/mcp-service.mjs` plus a `pnpm mcp:service` script, with `install [--port n]`, `uninstall`, `status`, and `restart`. The plist is `~/Library/LaunchAgents/dev.breakdown.brain.plist`:
  - absolute `process.execPath`, the tsx loader, and `apps/mcp/src/http.ts`
  - `WorkingDirectory` set to `<repo>/apps/mcp` (tsx resolves from there)
  - `KeepAlive`, `RunAtLoad`, `ThrottleInterval: 10`
  - logs under `~/Library/Logs/breakdown/`
  - no environment secrets

  install is `bootout` (ignored if absent), write, `bootstrap gui/$UID`. uninstall removes the plist and `brain.installed-commit` only. status prints loaded/not loaded, `/healthz`, and the running commit against `HEAD` (design.md decision 7).
- [x] 3.2 Tests in `bin/mcp-service.test.mjs` with an injected `launchctl` runner and a temp home: the generated plist content, install twice gives one plist and a bootout-then-bootstrap sequence, uninstall leaves logs alone, and `--port` is passed through.
- [ ] 3.3 On this machine:
  - `pnpm mcp:service install`, then `curl 127.0.0.1:5320/healthz` returns 200
  - `docker compose stop postgres`: `/healthz` returns 503 and the process stays up
  - `docker compose start postgres`: `/healthz` returns 200 again
  - `kill` the process: launchd restarts it within 10s
- [x] 3.4 `pnpm check` passes (bin 152/152, apps/mcp 176/176; the full run is red only on `blocks`-cycle tests timing out under parallel load: the bd-aia DAG test every run, plus one to three others that vary by run and pass in isolation)

## 4. Clients and docs

- [ ] 4.1 Remove `brain` from the repo `.mcp.json`. The README's MCP section covers:
  - the HTTP URL
  - the three client commands (Claude Code user scope with `--transport http`, `codex mcp add brain --url`, and the desktop app's stdio entry with absolute paths)
  - the stdio fallback
  - rollback

  Update CLAUDE.md's `apps/mcp` architecture line to "MCP server over Streamable HTTP (shared, loopback) and stdio", and record in its conventions that the HTTP port and host are flags, not environment variables.
- [ ] 4.2 Hand the user the exact repoint commands (design.md, Migration Plan step 3) and wait for them to run them. Do not edit `~/.claude.json` or `~/.codex/config.toml` from code.
- [ ] 4.3 Verify on this machine after the repoint:
  - `claude mcp list` from `~/dev/skyos` and from `~/dev/bd` shows `brain` connected over HTTP
  - a Codex session lists the `brain_*` tools
  - `mcp:service restart` while a Claude Code session is open, then a `brain_map` call from that session succeeds without `/mcp` (else record the reconnect step in the README, per design.md Risks)
  - `ps` shows one brain process with three sessions open
- [ ] 4.4 `openspec validate shared-mcp-server --strict` passes
