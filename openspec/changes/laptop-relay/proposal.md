## Why

When Breakdown moves to the Jetson (cutover bd-d38.10), several features stop working, because `bd`, `herdr` and the beads checkouts all stay on the Mac (bd-d38.2):
- review decisions;
- herdr reply delivery;
- the beads watcher.

Today those features answer 412. On 2026-11-14 a small Mac relay was chosen over retiring beads (bd-98d, which is days to weeks of work). The relay pulls those actions from Breakdown and runs them locally, the same pull pattern as the hangar queue (bd-d38.3), so the laptop loses nothing at cutover. This is bead bd-d38.11.

## What Changes

- **Relay actions.** When the server lacks `bd` or `herdr`, a review decision, a herdr reply to a local session, or an inbox decision's pane notification is queued as a relay action instead of answering 412. The UI shows each action as pending, then done or failed. When the binaries are present, which is Breakdown on the Mac, everything runs directly as today.
- **A relay service on the Mac.** It runs from the repo checkout under launchd (`pnpm relay:service`) with a `relay`-scoped token. It claims queued actions by long-poll, runs them, and reports each result.
- **An allowlist on the relay.** Only the `bd` subcommands review decisions use (`show --json`, `comments add`, `update --add-label|--remove-label review:changes`, `close --reason`) and `herdr agent prompt` are ever run, and arguments are validated on the server and again on the relay.
- **The beads watcher runs on the relay.** It runs `bd` against the local checkouts and pushes each project's ingest batch to Breakdown over authenticated HTTP. Breakdown applies it with the existing beads upsert and emits board events, so the board stays live.
- **Relay status.** The relay checks in on an interval. While it is offline, actions wait, and the board says "relay offline since …".
- **A new `relay` token scope,** which reaches only the relay endpoints.

Out of scope:
- **Opening or focusing herdr sessions from the board** (`inboxOpenSession`, `inboxFocusSession`, `reviewSession`). These start interactive tabs on a desktop and keep answering 412 on the Jetson. Cutover (bd-d38.10) records that.
- **Review media.** That is bd-d38.6.

Rejected alternatives:
- **An `agent`-scoped relay token, as the bead's acceptance literally says.** Workers hold `agent` tokens, so a prompt-injected worker could claim relay actions: dropping a person's review decisions, or reading herdr text meant for a local session. A dedicated scope gives the same capability with nothing extra exposed.
- **Raw `bd` argument lists as actions.** A review decision reads the issue first (`bd show`) and picks its steps from the result, so the relay runs the decision through the same review-writer code instead.
- **Waiting for bd-98d.** It would block cutover for weeks.

## Capabilities

### New Capabilities
- `laptop-relay`: relay actions and their lifecycle, the relay's claim and report protocol, the allowlist, check-ins and relay status, and beads ingest pushed from the relay.

### Modified Capabilities
- `container-deploy`: "Host-only features degrade cleanly" becomes "queue for the relay", for the actions the relay can run.
- `client-access`: adds the `relay` scope.

## Impact

- **`packages/db`:** migration 0009 adds the `relay_actions` and `relay_check_ins` tables and the `relay` scope value.
- **`packages/core`:**
  - new `relay.ts`, covering the action queue, claim, report and status;
  - `beads-ingest.ts`, split into compute and apply.
- **`apps/web/server`:**
  - a `/relay/v1` handler;
  - review decisions and inbox notifications queue an action when a binary is missing;
  - the beads watcher accepts pushed batches;
  - a `relayStatus` query;
  - action state reaches the UI.
- **`apps/web/src`:** pending/done/failed state on review and inbox decisions, and a relay status pill.
- **New `bin/relay.mjs` and `bin/relay-service.mjs`,** a launchd installer modelled on `bin/mcp-service.mjs`.
- **Docs:** `docs/relay.md`, a README section, and a CLAUDE.md note.
- **No Docker image builds** are needed or run on the Mac for this change.
