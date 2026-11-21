## Context

See proposal.md (Why). Facts the design builds on:
- **Where the registry lives.** A project's registration is one `beads_project` node, `(beads, project:<key>)` with metadata `{ project, path }`, written today by `applyBeadsIngest` in the same batch as the items.
- **What counts as a registration.** Every consumer that acts on a path asks `listBeadsProjects(db, { registeredByBeads: true })` or `getRegisteredBeadsProject`. Either one counts a row only when its last writer is a `beads` ingest run. This is the provenance rule that keeps an agent's `brain_write` from choosing where `bd` runs.
- **Who consumes the registry:**
  - The web server's beads watcher, only when `bd` is on PATH (`bdAvailable`). Its `reload()` re-syncs the registry and is already called by the board's refresh mutation.
  - The relay, through `GET /relay/v1/projects`. It narrows its own `--project` list to what the server lists at the same path, re-reading at start, every 5 minutes, and when an action names a project it doesn't hold.
- **How MCP refuses session tokens.** The MCP server refuses session-bound tokens the tools in `SESSION_REFUSED_TOOLS`, and refuses every write tool in read-only mode.

## Goals / Non-Goals

**Goals:** a registration path that needs neither `bd` nor database access; callable by a person (tRPC) and by Claude (MCP); safe on both kinds of server.

**Non-Goals:**
- Deregistration or re-pointing a key. The conflict refusal stays, and moving a checkout remains a local-ingest operation.
- A board UI.
- Changes to the relay. It still serves only the keys on its own command line.

## Decisions

1. **A dedicated registry write, not `applyBeadsIngest` with no issues.** An empty `applyBeadsIngest` would reconcile the project's `blocks`/`child_of` edges against an empty derived set, deleting every edge of an already-registered project. `registerBeadsProject(db, { project, path, actor })` instead does four things:
   - canonicalizes the key with the existing `canonicalProject`;
   - reads the key's registry row and throws `BeadsProjectConflictError(project, "path", requested, stored)` when the path differs;
   - opens a `beads` ingest run with the caller as `actor`;
   - upserts the one registry node and closes the run.

   The upsert's `content_hash` decides created or unchanged, as everywhere else. The run is a `beads` run, so the row passes the provenance rule exactly as a local ingest's does. A failure after the run opens closes it with the error, the same pattern the ingest uses.
   - *Alternative:* a separate registry table. Rejected: every reader already keys on the node, and the provenance rule would need a twin.

2. **The caller decides which path check applies.** Core exports two checks:
   - `checkLocalCheckout(path)`: the path exists, is its own realpath, is a directory, and holds `.beads/`. These are the relay's own checks, so the two cannot disagree.
   - `checkRemoteCheckoutPath(path)`: shape only (absolute, `path.posix.normalize(p) === p`, no trailing slash, at most 1024 characters, no control characters).

   The web procedure picks with the `bdAvailable` it already computes at startup. The MCP server picks with `findOnPath("bd")`, resolved once at bootstrap (it runs in the same container on the Jetson and on the same Mac locally). Core takes the already-checked path and never runs `bd`.
   - *Alternative:* always store as given. Rejected: on a server with `bd` the watcher would run `bd` in an unchecked directory.

3. **Scopes.**
   - The tRPC mutation is a `humanProcedure`.
   - The MCP tool is reachable by `human` and `agent` tokens and the loopback client (all MCP callers), and goes into `SESSION_REFUSED_TOOLS`.
   - *Why the agent token is allowed:* letting Claude register is the point of the change. What an agent can do with it is bounded:
     - on a server with `bd`, it can only name a real beads checkout on that host, which is what `pnpm ingest:beads` would already do;
     - on a server without `bd`, nothing runs until the relay holds that key at that path on its own command line;
     - it cannot re-point an existing key.
   - *Why session tokens are refused:* they belong to remote workers.
   - The relay token stays unable to register, preserving `docs/relay.md`'s "a push cannot register a project".

4. **Pick-up after registration.**
   - The web procedure calls `watcher.reload()` after a successful write, so on a server with `bd` the project loads at once. Without `bd` the watcher is inert, and the relay picks the project up within 5 minutes.
   - The MCP server has no watcher handle. On a server with `bd`, its response says the board's refresh (or the watcher's next registry sync) loads the project. Task 3 confirms whether the 30 s tick re-reads the registry, and phrases that sentence accordingly.
   - On a server without `bd`, both responses say the relay serves the key only if it is on its own `--project` list.

5. **Attribution.** The actor follows the existing write paths: `<client> via <name> <version>` over MCP and `<client>` for a web human write, with a loopback request keeping today's actor. The ingest run's `stats` record `{ project, path, registration: true }`, so a registration is distinguishable from a load in the run list.

## Risks / Trade-offs

- [An agent registers a key for a checkout the person did not intend] → No harm until the relay has it on its command line. The run names the agent, and the board shows the project. Deregistration is out of scope, so a mistaken key stays empty but listed. Accepted; follow-up bead.
- [The stored path drifts from the relay's (case, symlink)] → The relay already logs "registered at another path" and skips the project; the conflict refusal stops a quiet re-point. The person must use the relay's realpath, and the tool description says so.
- [An MCP-only registration on a server with `bd` waits for the next sync] → The response says how it is picked up (decision 4).

## Migration Plan

1. Merge.
2. Rebuild the Jetson image (on the Jetson, not the Mac) and redeploy `breakdown`. No migration.
3. Register `underground` with the new MCP tool from this session. Its key is already on the relay's `--project` list, so it appears within 5 minutes.

Rollback: the previous image. Registry rows written by the tool stay valid, because they have the same shape and provenance as an ingest's.
