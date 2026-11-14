## Why

The hangar service on the desktop's Linux host runs remote Claude sessions. It can only connect out, and it's offline whenever Windows is booted (hangar spike, cazzer/hangar `docs/plan.md`). So Breakdown on the Jetson has to be the control plane:
- session requests queue in Breakdown until hangar pulls them;
- hangar checks in so callers can see "hangar offline since …";
- each session has a record;
- replies to a remote session's review request reach that session without herdr, which only works on one machine.

This is bead bd-d38.3, and it folds in bd-d38.8: workers file their review requests through the web API, which today refuses every agent token.

## What Changes

- **A session-request queue.** A skill enqueues a request (repo, work item, flavor `headless` | `display-godot` | `display-browser`) through MCP. Hangar claims requests over authenticated HTTP, one at a time and atomically, by long-poll, filtered to the flavors it can admit right now.
- **Session nodes** (`hangar_session`: container, host, work item, disk path, flavor, state) with a `run_by` edge to their work item. Hangar updates their state; a request is simply a session in state `queued`.
- **Check-ins.** Hangar checks in on an interval. Breakdown reports hangar as online, offline since its last check-in, or never seen, through an MCP tool and on the web board.
- **Session tokens at claim.** Claiming a request returns a fresh `agent` token bound to that session, shown once and revoked when the session stops. The worker uses it for MCP and for its messages, so a session's writes and messages belong to that session.
- **Worker messages.** A worker long-polls its own messages. A decision on an inbox item or review that a remote session filed is delivered there instead of to a herdr pane. Local herdr delivery is unchanged.
- **Token scopes.** A new `hangar` scope for the service. The web API's procedures are gated individually: `agent` tokens may file and complete inbox requests and make the reads the inbox scripts use, while people's decisions stay `human`-only (bd-d38.8).
- **The HTTP contract** is documented in `docs/hangar-api.md` for cazzer/hangar issue #5 (C4).

Out of scope:
- accept and table outcomes, and releasing a session's disk (bd-d38.4);
- hangar's reported capacity and why requests wait (bd-d38.5) — check-ins carry an opaque capacity object that bd-d38.5 will interpret;
- media upload (bd-d38.6).

Rejected alternatives:
- **Hangar relays messages to its containers.** Workers would share one token, so Breakdown couldn't tell them apart.
- **Pre-minted slot tokens.** These are managed by hand, cap concurrency, and give identity per slot instead of per session. (Owner decision, 2026-11-14.)
- **Requests and sessions as separate nodes.** That would mean two records and a link to keep consistent for one lifecycle.
- **Check-ins as node writes.** Every write to a node appends a revision, so a 30 s heartbeat would flood `node_revisions`.

## Capabilities

### New Capabilities
- `hangar-queue`: the request queue, claiming, check-ins and hangar status, session records, session tokens, worker messages, and the published HTTP contract.

### Modified Capabilities
- `client-access`: adds the `hangar` scope; per-procedure scope gating on the web API replaces refusing `agent` tokens outright; a session-bound token can be minted by a hangar claim as well as by the host CLI.
- `brain-mcp`: adds tools to request a hangar session, read hangar status, and list sessions.

## Impact

- **`packages/db`:** migration 0008 adds `client_tokens.session_id`, a `hangar` scope value, `hangar_check_ins`, and `hangar_messages`. `nodes` is untouched.
- **`packages/core`:** new `hangar.ts` (queue, claim, sessions, check-ins, messages); `client-tokens.ts` (session tokens); `inbox.ts` (the `session` field and routing to messages).
- **`apps/web/server`:**
  - a `/hangar/v1` REST handler;
  - per-procedure scope middleware;
  - a `hangarStatus` query;
  - routing of decisions to messages.
- **`apps/web/src`:** a hangar status pill on the board.
- **`apps/mcp`:** the hangar tools.
- **Docs:**
  - new `docs/hangar-api.md`;
  - a README section;
  - in CLAUDE.md, the token-minting sentence and a hangar conventions bullet.
