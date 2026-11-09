## Context

See proposal.md for why. Current state:

- **`apps/mcp/src/index.ts`** does three things and then connects `StdioServerTransport`:
  - resolves `DATABASE_URL` via `resolveDatabaseUrl()`, which walks up to the workspace `.env`, so it is independent of the working directory
  - verifies the pool
  - builds one `McpServer` with `createServer(db, { readOnly })`
- **`createServer`** takes a `Database` it is handed. Attribution reads the client's `initialize` identity from the `McpServer` instance (`attribution.ts`, `ToolContext.actor`). So **one `McpServer` instance per client session is what keeps attribution correct.**
- **The web API** (`apps/web/server`) binds `127.0.0.1` explicitly and guards `Host`/`Origin` in `request-guard.ts`. The adapters deliberately copy small pieces (`config.ts`, `startup.ts`) rather than share a module.
- **Postgres** runs in docker compose with `restart: unless-stopped` on `:5442`. It can come up after the user logs in.
- **`@modelcontextprotocol/sdk` 1.30.0** ships `StreamableHTTPServerTransport` with session-id generation and `onsessioninitialized`/`onsessionclosed` hooks.
- **Codex 0.164** accepts `codex mcp add <name> --url <url>` for Streamable HTTP, so Codex can bind to the shared server directly.
- **The Claude desktop app's local config** launches stdio processes only, and does not inherit the login shell's `PATH` (pnpm and node live under nvm here).

## Goals / Non-Goals

**Goals:**
- One brain process per machine, reached by URL by every session in every folder and herdr workspace.
- Restarts and upgrades of the brain are invisible to clients except for one transparent re-initialize.
- Nothing in the server binary assumes macOS, so the cluster move is a new supervisor plus a bind/auth change, not a rewrite.

**Non-Goals:**
- Concurrency tuning beyond the existing pool defaults.
- Server-initiated notifications or resumable SSE streams (no `EventStore`). The tools are request/response.
- Multi-user anything. There is one person, and no authentication in this change.

## Decisions

**1. HTTP mode is a second entrypoint of `apps/mcp`, not a route on the web API server.**
`apps/mcp/src/index.ts` keeps the stdio path, and `apps/mcp/src/http.ts` (started by `pnpm --filter @breakdown/mcp run serve`) is the HTTP path. Both share the startup steps: resolve URL, verify pool, parse read-only. Those steps move into a small `bootstrap.ts` inside `apps/mcp`, so the two entrypoints differ only in transport.
*Alternative: mount `/mcp` on the web server.* Rejected. That process runs under `tsx watch` for explorer development and restarts on every save. The brain needs to stay up while the explorer is being edited, and the adapters share no code by convention.

**2. Stateful sessions, one `McpServer` per session, one pool per process.**
On an `initialize` POST with no `mcp-session-id`, the server creates a transport (`sessionIdGenerator: randomUUID`) and a fresh `createServer(db, { readOnly })`, connects them, and stores the pair in a `Map` keyed by session id when `onsessioninitialized` fires. Later requests are routed by the header. `DELETE` closes the session, and an unknown id answers 404, per the MCP spec, so the client re-initializes.
*Alternative: stateless mode (`sessionIdGenerator: undefined`, a server per request).* Rejected. Each request would lose the client identity from `initialize`, and the attribution requirement depends on it.

**3. Idle sessions expire after 7 days, and at most 256 sessions are held.**
herdr tabs sit idle for hours waiting on reviews, so expiry has to be long. The skyos tabs were idle across a whole evening on 2026-11-08. A per-session `lastSeen` is checked on a 10-minute timer. Past the cap, the least-recently-seen session is closed. An expired session costs the client one 404 and one re-initialize, so the numbers are a memory bound, not a correctness one. They are constants in `http-server.ts` (`SWEEP_INTERVAL_MS`, `IDLE_LIMIT_MS`, `MAX_SESSIONS`), not configuration.

**4. Port and bind address are command-line flags, not environment variables. This is an architecture decision.**
`serve --port <n> --host <addr>`, defaulting to `--port 5320 --host 127.0.0.1`. The port sits next to the web API's 5310. The environment allowlist in CLAUDE.md (`DATABASE_URL`, `BRAIN_READ_ONLY`, `WEB_SERVER_PORT`) stays exactly as it is. A launchd plist, a systemd unit, and a container `command:` all pass arguments as easily as environment.
*Alternative: `MCP_SERVER_PORT` mirroring `WEB_SERVER_PORT`.* Rejected for now. It widens the allowlist for no capability that flags lack. The cluster change may revisit this if its orchestrator prefers environment.

**5. Loopback is enforced, not defaulted.**
`--host` accepts only `127.0.0.1`, `::1`, or `localhost`, and anything else exits fail-fast (spec: "HTTP mode is local only"). The flag exists now so the cluster change widens a validation rule instead of adding a flag. The request guard is a copy of `apps/web/server/request-guard.ts`'s `isAllowedRequest`, pinned to the MCP port and applied to every request including `/healthz`, in keeping with the copy-not-share convention. It accepts `[::1]:<port>` as a Host and `http://[::1]:<port>` as an Origin, since `::1` is an allowed bind. One deliberate difference from the web guard: Origin is checked on every method, not only on writes. A GET on `/mcp` opens the session's SSE stream, so it is not the harmless read a GET is on the web API. Copying it keeps the guard aligned with the SDK's own DNS-rebinding guidance, and avoids depending on SDK option names that have moved between versions.
*Alternative: accept a LAN bind now with a warning.* Rejected. The write tools would then be open to anything on the home network with no authentication, which is exactly the decision the cluster/funnel change has to make deliberately.

**6. Health is a plain HTTP route next to `/mcp`.**
`GET /healthz` runs `select 1` with a short timeout and reports `{ ready, readOnly, database: "host:port/db" }`, built by the existing `describeConnectionTarget`, which already omits the password. The server keeps running when the database drops (spec: "Database goes away after startup"). Tool calls fail with the existing actionable errors until it returns. Only startup is fail-fast.

**7. launchd LaunchAgent, written by a repo script.**
`pnpm mcp:service install|uninstall|status` is a Node script under `bin/`, matching `review-request`. It writes `~/Library/LaunchAgents/dev.breakdown.brain.plist`:
- **`ProgramArguments`:** the absolute `node` path resolved at install time (`process.execPath`), then tsx's loader and `apps/mcp/src/http.ts`.
- **`WorkingDirectory`:** `<repo>/apps/mcp`, where `tsx` is a devDependency, so `--import tsx` resolves.
- **Restart and launch:** `KeepAlive: true`, `ThrottleInterval: 10`, `RunAtLoad: true`.
- **Logs:** `StandardErrorPath`/`StandardOutPath` under `~/Library/Logs/breakdown/`.

`DATABASE_URL` still comes from the workspace `.env` through `resolveDatabaseUrl`, so the plist carries no secret. install is `bootout` (ignored if absent), then write, then `bootstrap gui/$UID`, which makes it idempotent. uninstall is `bootout`, then removes the plist and `brain.installed-commit` only; the logs and the database stay. The 10s throttle covers the database-after-login race: fail-fast exits are retried until docker is up.
*Alternative: a docker compose service.* Rejected for now. It is the likely shape on the cluster, but on the laptop it would need its own Node image and a container-to-host database URL, and it would hide logs inside docker. Revisit with the cluster change.
*Alternative: run under `tsx` via pnpm.* Rejected. pnpm's PATH lookup and its stdout preamble are exactly what broke stdio before.

**8. Client wiring.**
- **Claude Code (user scope):** `claude mcp add -s user --transport http brain http://127.0.0.1:5320/mcp`, replacing today's user-scope stdio entry.
- **Codex:** `codex mcp add brain --url http://127.0.0.1:5320/mcp` in `~/.codex/config.toml`.
- **Claude desktop app:** a stdio entry with absolute `node` and entrypoint paths. This is the one remaining per-process client.
- **The repo's `.mcp.json`:** drops `brain`. Otherwise, inside this repo, the project-scope stdio entry would shadow the shared server.

The README documents the stdio command as the fallback for when the service is down. Applying the user-level config is a manual step the user runs (the tasks give the exact commands). The installer does not edit `~/.claude.json` or `~/.codex/config.toml`.

## Risks / Trade-offs

- **[A client that does not re-initialize on 404 after a restart]** → Verify with Claude Code and Codex in tasks. If either fails, it falls back to `/mcp` reconnect, and the README says so. Restarts are rare, since the service only restarts on upgrade or crash.
- **[Upgrades need a restart]** The service runs source via tsx, so pulled code runs only after a restart. → `mcp:service status` prints the running commit beside `HEAD`, and `mcp:service restart` (an alias of install) reloads it.
- **[A single process is a single point of failure for every session]** → `KeepAlive` restarts it, and stdio stays as a fallback that needs no service.
- **[A local process without `Origin` can reach the write tools]** This is the same exposure stdio and the web API already accept on a single-user machine, and it is recorded rather than mitigated here.
- **[Port 5320 collides with something]** → Fail-fast names the port, and install takes `--port`, passing it through to the plist.

## Migration Plan

1. Land the HTTP entrypoint, guard, health route, and installer, with the stdio path unchanged.
2. `pnpm mcp:service install`, then confirm `GET http://127.0.0.1:5320/healthz` is 200.
3. Repoint clients:
   - **Claude Code:** `claude mcp remove -s user brain`, then the `--transport http` add.
   - **Codex:** `codex mcp add brain --url …`.
   - **Repo `.mcp.json`:** remove `brain`.
   - **Desktop app:** add its stdio entry.
4. Reconnect running sessions once (`/mcp`, or `claude --resume` in a herdr pane).
5. Rollback: `pnpm mcp:service uninstall`, and re-add the user-scope stdio entry from the README. No data migration is involved.

## Open Questions

- Whether the Claude desktop app's local config accepts a `url` for a loopback HTTP server in its current version. If it does, it can move off stdio later with no other change.
