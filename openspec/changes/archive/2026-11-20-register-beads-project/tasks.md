## 1. Core: the registry write and the path checks

- [x] 1.1 `packages/core/src/beads-registration.ts`: `registerBeadsProject(db, { project, path, actor })` (design.md decision 1): canonical key, conflict read, one `beads` ingest run with `stats { project, path, registration: true }`, upsert of the registry node only, run closed with the error on failure; returns `{ project, path, status: "created" | "unchanged", ingestRunId }`; exported from `index.ts`
- [x] 1.2 `checkLocalCheckout(path)` and `checkRemoteCheckoutPath(path)` (design.md decision 2), each throwing an error that says which check failed
- [x] 1.3 Tests (DB, fixtures scoped to their own keys): created then unchanged; other path refused with both paths and nothing written; an existing project's items, edges, and revisions untouched; malformed key refused naming `project`; the row is listed by `listBeadsProjects({ registeredByBeads: true })` and `getRegisteredBeadsProject`; both path checks' refusals and acceptances

## 2. Web API

- [x] 2.1 `apps/web/server/routers/board-live.ts` (beside `refreshBoard`, which owns the watcher and the relay queue): `registerBeadsProject` `humanProcedure` mutation `{ project, path }`; picks the path check by `bdAvailable` (threaded into the router context or options); calls `watcher.reload()` after a write on a server with `bd`, and without it queues one `beads_reingest` so the relay loads the project at once; maps the conflict and the check errors to `CONFLICT` and `BAD_REQUEST` with their messages
- [x] 2.2 Router tests: human and loopback register; agent, hangar, and relay tokens refused; conflict; a server without `bd` stores a path it cannot see; a server with `bd` refuses a directory without `.beads/`

## 3. MCP tool

- [x] 3.1 `apps/mcp/src/tools/write.ts`: `brain_register_project({ project, path })` with the actor from attribution; the path check chosen by `findOnPath("bd")` at bootstrap; the response names key, path, status, and how the project is picked up (design.md decision 4: the watcher's tick does not re-read the registry, so with `bd` it says to refresh the board; without it, it queues a `beads_reingest` like the web mutation)
- [x] 3.2 `apps/mcp/src/server.ts`: add to the tool list and `SESSION_REFUSED_TOOLS`; update the server instructions and the tool count ("sixteen") in `server.ts`, `index.ts`, and `server.test.ts`; read-only refusal
- [x] 3.3 Tests: the tool registers and reports `created`/`unchanged`; refused to a session token; refused read-only; a conflict is returned as a tool error naming both paths

## 4. Docs

- [x] 4.1 README registration paragraph and `docs/relay.md` (a project may be registered over the API or MCP as well as by a local ingest; the relay still needs the key on its `--project` list); CLAUDE.md's MCP tool list if it names the tools

## 5. Checks

- [x] 5.1 `pnpm check` green (pre-existing failures noted, not new); `openspec validate register-beads-project --strict` passes
