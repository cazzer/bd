## Why

A beads project is registered only by `pnpm ingest:beads <path> --project <key>`, which runs `bd` and writes straight into the database. A Breakdown without `bd` and without a reachable database (the Jetson) therefore cannot gain a project unless someone tunnels to its Postgres with its password. Registering `underground` stalled on exactly that. The laptop relay can already watch and push any project once the server lists it, so the only missing piece is a way to put the registry row there over the API, where a person or Claude can do it without database access.

## What Changes

- A core write, `registerBeadsProject`, that writes only a project's registry node (`beads_project`, external id `project:<key>`, metadata `{ project, path }`) inside a `beads` ingest run attributed to the caller. It counts as a registration for the watcher and the relay, it touches no work items or edges, and it is idempotent: registering the same key at the same path again changes nothing. A key registered at another path is refused (`BeadsProjectConflictError`). The registry is never re-pointed.
- Path rules that depend on where `bd` runs:
  - **This server has `bd`** (it watches its own checkouts): the path must exist here, must be its own realpath, and must hold `.beads/`. This is the same check the relay makes.
  - **This server has no `bd`** (the relay pushes): the path is a Mac path that the server cannot see. The server checks only its shape (absolute, normalized, bounded) and stores it as given; the relay validates it before serving it.
- A tRPC mutation `registerBeadsProject({ project, path })` for `human` callers.
- An MCP tool `brain_register_project({ project, path })` so a Claude session can register a project on its own. It is refused in read-only mode and to hangar session tokens, the same way the other remote-worker refusals work.
- Docs: the README's registration paragraph, `docs/relay.md` (a project can now be registered over the API as well as by a local ingest), and the MCP tool count and server instructions.

## Capabilities

### New Capabilities
- `beads-project-registration`: registering a beads project by key and path without running `bd`. Covers the registry write, idempotence and conflict rules, path validation that depends on whether this server has `bd`, and the human tRPC procedure.

### Modified Capabilities
- `brain-mcp`: adds a project-registration tool.

## Impact

- `packages/core/src/beads-ingest.ts` (or a sibling `beads-registration.ts`), exported from `index.ts`.
- `apps/web/server/routers/board.ts` (the new mutation) and the server's knowledge of whether `bd` is on PATH.
- `apps/mcp/src/tools/write.ts`, `server.ts` (the tool list, instructions and `SESSION_REFUSED_TOOLS`), and the tool-count tests.
- No migration, no new environment variable, no new token scope. The relay is unchanged: it picks up a newly listed project within 5 minutes when the project is on its own `--project` list.
- Deploy: the Jetson needs a new image before the tool works there.
