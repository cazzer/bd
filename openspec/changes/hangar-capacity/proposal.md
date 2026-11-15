## Why

Hangar decides what it can run from measured budgets (RAM, CPU, VRAM, disk) and reports them on every check-in, but Breakdown stores that report as an opaque blob and shows none of it. A queued request just sits there: whoever asked can't tell whether hangar is offline, out of RAM, or out of disk because ended sessions are still waiting for a person to accept or table them. That last case is fixable by the person in a click, if they're told. This is bead bd-d38.5. Hangar already sends the shape this change documents (cazzer/hangar `service/src/breakdown.ts`, `Capacity`).

## What Changes

- **The capacity contract.** `docs/hangar-api.md` stops calling `capacity` opaque. It documents what hangar sends today: `slots`, `blocked`, `free`, `sessions`, and `disk`. It also adds an optional per-session `usage` list (session id, allocated and apparent disk bytes). A `blocked` reason that starts with `disk:` means the disk budget is full. The 10,000-character limit and the ignore-unknown-fields rule stay.
- **When it was reported.** Each check-in row gains `capacity_at`, the database time the stored capacity arrived. A claim still touches liveness only, so a stale capacity can be told apart from a fresh one.
- **Lenient reads.** The capacity is still stored as given. A reader parses it, and a malformed field is treated as absent, so a bad or newer report never breaks check-in or liveness.
- **Why a request waits.** Each queued session gets a reason, computed when read and never stored:
  - `offline`: no hangar is online, or none has ever checked in.
  - `unknown`: hangar is online but reported no capacity.
  - `not_offered`: no online hangar runs this flavor.
  - `disk_awaiting_review`: the disk is full and ended sessions still hold disks with no outcome. The reason lists them with their work items.
  - `capacity`: another budget is full; the reason quotes hangar's text.
  - `next`: it fits now, with how many requests of its flavor are ahead.
- **Where it shows.** `brain_hangar_status` adds the latest capacity and when it was reported. `brain_hangar_sessions` adds `waiting` on queued sessions. On the board, the hangar pill shows capacity, and the work item drawer shows a queued session's reason, with links to the sessions awaiting review.

Out of scope:
- **Hangar sending `usage`.** This is a follow-up in cazzer/hangar. Breakdown shows disk bytes per session when they're reported and leaves them out otherwise.
- **Admission in Breakdown.** Hangar admits sessions. Breakdown only explains.

Rejected alternatives:
- **Validate capacity strictly at check-in and refuse a bad one.** A refused check-in makes hangar look offline over a reporting bug, and the cost is worse than an unexplained queue.
- **Store the reason on the session.** It changes whenever hangar checks in or a person decides an outcome. Storing it means writing a revision every 30 seconds, and it would still go stale between writes.
- **A structured `blocked` kind field.** Hangar's reasons already start with the resource name. Documenting the `disk:` prefix needs no change on hangar's side.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `hangar-queue`: check-ins carry a documented capacity with per-session usage and a reported-at time, and queued requests say why they wait.
- `brain-mcp`: the status tool returns capacity, and the session listing returns the wait reason.

## Impact

- **Database:** a migration adds `capacity_at timestamptz` to `hangar_check_ins`. It isn't on `nodes`, so the `resolved_nodes` view doesn't change.
- **`packages/core/src/hangar.ts`:**
  - `recordCheckIn` sets and clears `capacity_at`;
  - a lenient capacity parser;
  - `getHangarStatus` returns capacity;
  - a batch `explainQueuedSessions`.
- **`apps/mcp/src/tools/hangar.ts`:** status and session listing output.
- **`apps/web/server/routers/hangar.ts`:** status and session DTOs carry capacity and wait reasons.
- **`apps/web/src`:** `HangarStatusPill` and `HangarSessions` (with `hangarStatus.ts`).
- **Docs:** `docs/hangar-api.md` (check-in and status sections).
