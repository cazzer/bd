## Why

Every hangar session's PR and question reaches the person's inbox today, and so does every request to release a session. Most of these are the driver's to make: the agent that requested the session reviews its PR, picks among its options, answers its clarifying questions, and knows when the session is done. In the person's words: "if something is simply asking if its ok to release a session it should not be coming to me since that decision should be made by the driver. the only decisions that should come to me are big decision points, such as ones that change the architecture or set a fundamental direction". The decisions that do reach them should be items tagged for review, not inbox items.

## What Changes

- **The driver releases sessions itself.** A new agent-scope MCP tool, `brain_hangar_outcome { sessionId, outcome: accepted | tabled, note? }`, sets an ended session's outcome directly, with `outcome_by` the token's client name, and leads to the same release hangar already performs. `brain_hangar_outcome_request` is retired: still dispatched, never advertised, it files nothing and points at the new tool. The disk-wait text and `awaitingReview` tell the driver to release, not to ask the person.
- **Session decisions go to the driver.** A new session-token endpoint, `POST /hangar/v1/decision`, takes the worker's result (kind `pr` or `question`, title, summary, PR URL, and the same strictly validated card) and stores it as the session's pending decision in a new `hangar_decisions` table. It is not an inbox item. `brain_hangar_sessions` shows it as `pendingDecision`. A new MCP tool, `brain_hangar_decide { sessionId, decision: accept | changes | dismiss, option?, note? }`, answers it with a `session_decision` message whose body is an `inbox_decision`'s, so the worker's loop barely changes.
- **Escalation to the person, for big decisions only.** A new MCP tool, `brain_hangar_escalate { sessionId, card, note? }`, marks the decision escalated and files a review (a beads issue labelled `review`, the driver's card as its review metadata) under the session's work item through a new `review_request` laptop-relay action, so it shows in the board's review queue and in Needs me. Once escalated, `brain_hangar_decide` refuses it. When the person decides the review, Breakdown writes their decision to the session's messages, same body. A work item with no registered beads project falls back to an inbox item with the card, bound to the session, whose decision also reaches the session as a `session_decision`.
- **Session tokens** are refused all three new tools: a worker never releases, decides, or escalates its own work.
- **Docs.** `docs/hangar-api.md` (the endpoint, the message kind, who decides, version tolerance), `docs/relay.md` (the new kind and its allowlisted `bd` shapes), the README's hangar section, and CLAUDE.md's outcome invariant.

Out of scope:
- **Switching the hangar worker.** cazzer/hangar's `hangar-worker` moves to `POST /decision` and `session_decision` separately; until then it keeps filing inbox items, which keeps working.
- **Running `bd` on the Breakdown server for an escalation.** A Breakdown with `bd` runs a relay against itself (`--url` may be loopback). One path, not two.
- **Closing a stale escalated review** when the session files again or ends. The review stays on the board; its decision reaches nobody.

Rejected alternatives:
- **Store the pending decision in the session node's metadata.** A card with its evidence is large, and every re-file would be a revision of the session. Like messages, it is delivery, not knowledge.
- **Reuse the `inbox_decision` kind.** Its documented meaning is a person acting on an inbox item; a separate kind with the same body keeps the contract honest for one `select` change in the worker.
- **A new token scope for drivers.** The `agent` scope already expresses it; session tokens are excluded by name, as for `brain_hangar_request`.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `hangar-queue`: sessions gain a pending decision filed by the worker and answered by the driver or, escalated, by the person; the driver sets a session's outcome.
- `brain-mcp`: adds `brain_hangar_outcome`, `brain_hangar_decide`, `brain_hangar_escalate`, and `pendingDecision`; retires `brain_hangar_outcome_request`.
- `laptop-relay`: adds the `review_request` action.

## Impact

- **Database:** migration `0012_hangar_decisions`: the `hangar_decisions` table, and `review_request` in `relay_actions`' kind check.
- **`packages/core`:** `hangar-decisions.ts` (filing, deciding, escalation bookkeeping, routing), `hangar-escalation.ts` (escalate, relay report follow-up), `relay.ts` and `relay-allowlist.ts` (the new kind and its `bd` shapes), `inbox.ts` (an escalation's inbox item routes to the decision), `hangar.ts` (disk-wait wording).
- **`apps/web/server`:** `hangar-api.ts` (`POST /hangar/v1/decision`), `relay-api.ts` (report follow-up), `routers/review.ts` (a written decision routes to the session), `relay/execute.ts` and `relay/main.ts` (the relay files the review).
- **`apps/mcp`:** the three tools, `pendingDecision`, the retired stub, session-token refusals, read-only gating.
- **`bin/`:** `relay-lib.mjs` kinds, `hangar-release-e2e.mjs` (the driver releases session B).
