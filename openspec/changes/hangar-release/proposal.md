## Why

Hangar keeps every stopped or failed session's disk, and its stopped container, until a person says they're done with the session. Breakdown has no way to record that today, so disks pile up on the desktop. Hangar's side is already merged and tested against a proposed contract (cazzer/hangar `docs/release-contract.md`): an `outcome` on the session that only a person sets, plus a `reason` when hangar fails a session. This is bead bd-d38.4. The change matches that contract; one criterion is pushed back on the bead (see Out of scope).

## What Changes

- **`outcome` on every hangar session:** `null`, `accepted` or `tabled`.
  - Only a person sets it, and only on a `stopped` or `failed` session: from the board (the `human` scope, or the tokenless local person), or by accepting an inbox request an agent filed for it.
  - A person can change it until hangar has released the session.
  - Setting it is a change to the session node, so the session moves to the front of the newest-changed listing hangar reads.
  - It's returned wherever the session object is: REST, MCP, and the board.
- **Agents can only ask.** A new MCP tool, `brain_hangar_outcome_request`, files an inbox item bound to a session, with Accept and Table options. Your decision on it sets the outcome. Session tokens and the hangar token can't call it.
- **`reason` on `PATCH /hangar/v1/sessions/:id` with `state: "failed"`** (1–500 characters). It's stored as the session's `failure_reason`, the same field claim-time failures already use.
- **Release acknowledgement.** `PATCH {container: null, disk_path: null}` on a final session is how hangar says it released the session. `outcome` set with `disk_path` null means released.
- **Releasable sessions.** `brain_hangar_sessions` gains a `releasable` filter: outcome set, disk still held. The board shows each session's outcome with Accept and Table on ended sessions.
- **The contract doc.** `docs/hangar-api.md` documents all of the above. No new endpoint.

Out of scope:
- **Readiness.** The bead's "readiness queries handle the new states" is pushed back on the bead. Accepted and tabled are session outcomes, not work item statuses, so readiness doesn't change, and a person still closes the work item as today.
- **Deleting a released session's messages or archiving the session.** Breakdown may do this later; the contract allows it but doesn't require it.

Rejected alternatives:
- **Work item statuses `accepted` and `tabled`.** These would put a hangar concern into the work-item contract and every readiness query, for a fact that belongs to one session (a work item can have several sessions).
- **Letting agents set the outcome directly.** Tabling deletes a disk, so it's a person's decision; agents only ask.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `hangar-queue`: sessions gain a person-set outcome, a reported failure reason, and a release acknowledgement.
- `brain-mcp`: adds the outcome request tool and the releasable filter.

## Impact

- **`packages/core/src/hangar.ts`:** the outcome field in the session contract, `setHangarSessionOutcome`, failure reason on update, clearing fields with null, and the releasable filter.
- **`packages/core/src/inbox.ts`:** an inbox action whose decision sets a session's outcome.
- **`apps/web/server`:**
  - `hangar-api.ts`: PATCH accepts `reason` and nulls; the session JSON gains `outcome`, `outcome_at` and `outcome_by`.
  - a human procedure for setting the outcome;
  - inbox routing for the outcome request.
- **`apps/mcp`:**
  - `brain_hangar_outcome_request`;
  - the `releasable` filter.
- **`apps/web/src`:** session outcome controls on the board item.
- **Docs:** `docs/hangar-api.md` and the README.
- **Database:** no migration. Session state lives in node metadata.
