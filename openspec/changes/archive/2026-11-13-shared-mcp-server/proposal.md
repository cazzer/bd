## Why

The brain is reached only over stdio, so every agent session spawns its own server process, and a session sees the brain only if its client was configured for it before the session started. On 2026-11-08 the skyos sessions in herdr could not file work because `brain` was declared only in this repo's `.mcp.json`. Fixing that meant a user-scope registration and then restarting every running session. One long-running server that every session binds to by URL removes the per-session process, and it is the shape the brain needs before it can move onto the SkyOS home cluster or, later, sit behind a funnel for the phone.

## What Changes

- `apps/mcp` gains a Streamable HTTP mode: one long-running process serving the same eleven `brain_*` tools at `http://127.0.0.1:<port>/mcp`. It holds one connection pool and a separate MCP session per client, so write attribution still names each client.
- The HTTP mode binds loopback only and refuses requests whose `Host` or `Origin` is not local, the same guard the web API applies. Binding any other address is refused at startup in this change. Network exposure is deferred to the cluster/funnel change, which also has to bring authentication.
- A `GET /healthz` endpoint reports whether the server and its database are usable, for launchd now and cluster readiness probes later.
- Stdio stays as a supported transport with unchanged behavior, used by the Claude desktop app's local config and as the fallback when the service is down.
- A macOS LaunchAgent installer (`pnpm mcp:service install|uninstall|status`) runs the HTTP server at login, restarts it on exit, and logs under `~/Library/Logs/breakdown/`. The server itself reads no macOS-specific path. Only the installer is platform-specific.
- Client wiring is documented and the repo's `.mcp.json` drops its stdio `brain` entry, so sessions in this repo use the same shared server as everyone else:
  - Claude Code user scope uses the HTTP URL.
  - Codex uses the HTTP URL (`codex mcp add --url`; Codex 0.164 supports it).
  - The Claude desktop app uses stdio with absolute paths.
- **Not in this change:**
  - binding beyond loopback
  - authentication or OAuth
  - Cloudflare or Tailscale funnels
  - container images for the cluster
  - running Claude sessions on the cluster (a separate project)

Rejected alternatives:
- **Mounting `/mcp` on the existing web API server.** That process is `pnpm dev` under `tsx watch`, restarts on every edit, and the adapters deliberately share no code. The brain needs to stay up independently of the explorer.
- **Stateless HTTP.** It discards the per-client identity from the `initialize` handshake that write attribution records.
- **An `mcp-remote` stdio-to-HTTP bridge for the desktop app.** It adds a dependency to get what the existing stdio entrypoint already gives.

## Capabilities

### New Capabilities
- `brain-service`: the brain run as a supervised, long-running local service: how it is installed, started, restarted, health-checked, and logged on this machine, kept portable to a non-macOS host.

### Modified Capabilities
- `brain-mcp`: adds the shared HTTP transport (loopback-only, browser-guarded, a separate session per client with per-client attribution), states that stdio remains supported, and extends fail-fast startup to the HTTP mode's bind configuration.

## Impact

- **Code:**
  - `apps/mcp/src/index.ts` splits into transport entrypoints over the shared `createServer`.
  - New HTTP server module with session map and request guard.
  - New service installer script.
  - `apps/mcp/package.json` scripts.
- **Config surface:** the HTTP mode takes its port and bind address as command-line flags, not environment variables, so the environment allowlist (`DATABASE_URL`, `BRAIN_READ_ONLY`, `WEB_SERVER_PORT`) is unchanged. design.md records this as the architecture decision it is.
- **Dependencies:** none new. `@modelcontextprotocol/sdk` 1.30.0 already ships `StreamableHTTPServerTransport`.
- **Clients:**
  - `~/.claude.json` user-scope `brain` switches from stdio to HTTP.
  - The repo `.mcp.json` loses its `brain` entry.
  - The desktop app gains a stdio entry.
  - Already-running sessions need one reconnect when the switch happens, and none after that.
- **Docs:** CLAUDE.md architecture line ("MCP server over stdio") and the README's MCP setup section.
