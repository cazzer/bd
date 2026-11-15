## Context

See proposal.md and the contract in cazzer/hangar `docs/release-contract.md`. This builds on what hangar-queue already provides:
- the session metadata contract (`normalizeHangarSessionMetadata`);
- the write path, `changeClaimedSession` (a pre-check, then `FOR UPDATE`, then upsert inside an ingest run);
- the REST PATCH, `listSessions` ordered by `updated_at DESC`, and the inbox paths bound to a session.

## Decisions

### 1. Outcome lives in session metadata

The session metadata gains `outcome` (`accepted` | `tabled`, absent means none), `outcome_at`, and `outcome_by` (the actor).

`setHangarSessionOutcome(db, { id, outcome, actor })` follows the same write shape as `changeClaimedSession`, but without the claimer check, since a person isn't the claimer. It refuses when:
- the state isn't `stopped` or `failed`;
- the session is already released (outcome set and `disk_path` null);
- the outcome is unknown.

Setting the same value again is a no-op. The upsert bumps `updated_at`, which is what hangar's listing order relies on. `brain_write`'s reservation of `hangar_session` already keeps agents from writing it.

### 2. Only the people paths call it

- tRPC `hangarSessionOutcome` (`humanProcedure`).
- An inbox action kind, `hangar_outcome`. Filing it binds the item to `metadata.hangar_outcome = { session_id, requested }`, with options `accept` and `table`. In `decideInboxItem`, accepting it with an option sets the session's outcome in the same transaction, attributed to the person. Dismissing it leaves the outcome unset.
- The hangar REST PATCH strips unknown fields, so a sent `outcome` is simply ignored.

### 3. PATCH `reason` and nulls

- On `state: "failed"`, `reason` (1–500 characters) goes to `failure_reason`. Sent with any other state it's refused with 400, so hangar learns its mistake.
- `container: null` and `disk_path: null` delete the key. This is allowed on a final session through the existing same-state field update.
- The session JSON gains `outcome`, `outcome_at`, `outcome_by`, and `released` (computed). Clients ignore unknown fields, as the contract says.

### 4. `releasable` is a filter, not a state

`listSessions({ releasable: true })` uses `metadata ? 'outcome' AND metadata ? 'disk_path'`. `brain_hangar_sessions` exposes the same filter.

### 5. Board

The board item's drawer lists the item's hangar sessions, from `listSessions` by work item. Each shows state, outcome, and released. Ended sessions with no outcome get Accept and Table buttons. Tabled shows "the disk is deleted when hangar next checks in".

## Risks / Trade-offs

- [A person tables by mistake] → They can change it until hangar acknowledges. After that the disk is gone, and the Table confirmation says so.
- [Hangar is offline when the decision is made] → The decision waits in the listing until hangar's next check-in. The board shows "not yet released".
