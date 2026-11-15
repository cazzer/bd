## Context

A hangar worker today files each `pr` or `question` result as an inbox item with its session token, and waits for the person's `inbox_decision` message. Releasing an ended session needs a person's outcome, which an agent can only ask for (`brain_hangar_outcome_request`, an inbox item). Both put routine calls on the person's desk. The person wants the driver (the agent that requested the session) to make them, and only architecture- or direction-level calls to reach them, as review items rather than inbox items.

## Decisions

### 1. A table for pending decisions

`hangar_decisions` holds one row per filing: session, kind, title, summary, PR URL, card (normalized), state (`pending`, `decided`, `escalated`, `superseded`), escalation record, answer, filer. Filing supersedes the session's open row in the same transaction, so a session has at most one open decision. A table, like `hangar_messages`, because this is delivery: a card with evidence can be large, and a revision of the session node per re-file would bury real changes.

### 2. The card is held strictly

`normalizeHangarDecisionCard` runs the review card normalizer (`normalizeDecisionCard`) and refuses a card the normalizer would change, rather than fitting it, so the decider reads what was filed. Only `question` (required), `options`, `recommend`, `on_accept`, and `body` are taken; attachments are not (no media upload path from a worker), as for an inbox card.

### 3. The answer reuses the inbox decision's body

`brain_hangar_decide` appends a `session_decision` message with every `inbox_decision` field (`item_id` = the decision's id) plus `by` and `via`. The worker filters on the id it filed under; accepting both kinds keeps one loop. The `text` names no inbox command, since there is no inbox item to complete. Deciding requires a live session (`claimed` or `running`), share-locked so a racing stop waits.

### 4. Release by the driver uses the existing outcome path

`brain_hangar_outcome` calls `setHangarSessionOutcome` with the token's client as actor, so `outcome_by`, the revision, `updated_at` ordering, and hangar's release are exactly what a person's decision produces. `ToolContext` gains `tokenClient`. `brain_hangar_outcome_request` stays dispatchable (an old driver gets a pointer, not "unknown tool") but is flagged `retired`, never advertised.

### 5. Escalation goes through the relay, always

Breakdown's MCP server holds only the database, and the Jetson has no `bd`. `brain_hangar_escalate` queues a `review_request` relay action: `{ project_key, cwd, issue_id (the work item), title, description, review }`, where `review` is the card as review metadata with `key` = `hangar-<decision id hex>` (39 characters, within the review key pattern). The relay runs exactly the `bd` shapes `bin/review-request` runs for a card, each added to the allowlist with every literal fixed and `--metadata` checked to be `{ review }` holding a valid keyed card. It first lists the work item's open reviews and reuses the one holding the key, so a retry after a lost report never files a second review. One open `review_request` per work item at a time, by the existing open-target index. Never stale: an escalation waits for the person however long the relay was away.

### 6. Routing a person's decision is matched on the server's record

The escalation record names where it went. The relay's `done` report records the review's bead id (`review_id`); a `failed` report puts the decision back to `pending` with the error, so the driver can retry. A person's review decision is routed (`routeReviewDecision`) by `(project_key, review_id)`: from the review router once the decision is written with `bd` on the server, or from the relay API once the relay reports a queued `review_decision` done (so a decision the tracker refused never reaches the session). Nothing a review's writer controls (its key, its metadata) binds it to a session.

### 7. Fallback: an inbox item bound to the session

With no registered beads project for the work item, the escalation files an inbox item (`hangar-decision:<decision id>`) with the card and the session binding a worker's own item has. `decideInboxItem`, inside its transaction, matches an escalated decision by `(item id, session)`, records the person's answer on it and appends a `session_decision`; the item closes `done` on accept or changes, since the session carries on from its message. The existing `inbox_decision` is still sent.

### 8. No agent decides a review

An escalated decision refuses `brain_hangar_decide`. Review decisions remain the `human`-only `reviewDecision` procedure. Session tokens are refused all three new tools.

### 9. Review fixes (PR #12)

- **The escalation keeps the card the person sees** (`escalation.card`: question, options, recommend), and the person's option is checked against it, not against the worker's card, which may have none.
- **No stuck escalations.** Three things can leave a decision `escalated` with no review: a `review_request` the claim fails itself (abandoned, or a stored payload that breaks its schema), a relay that never runs the kind, and a crash between the report and its follow-up. In order:
  - the claim path fails the escalation in its own transaction;
  - the driver may answer an escalation whose review is not filed yet (no `review_id`), which withdraws the still-queued action;
  - the relay API runs the follow-up on a repeated report too, since it is idempotent.
- **Superseding withdraws.** Filing a new decision fails the queued `review_request` of the one it supersedes, so no stale review is filed later and the same work item can be escalated again. The review path queues its action in the transaction that marks the decision escalated, after re-locking the decision it read, so a racing decide or re-file leaves no orphan action. The inbox path marks first, then files the item; a failed filing reverts the mark.
- **The description starts with a heading** naming the driver and session, so a body that opens with a markdown list or rule passes the relay's "never starts with `-`" argument rule.
- **The fallback item's key is reserved** (`hangar-decision:`), like `hangar-outcome:`. Only the escalation writes it, so the worker it routes to cannot rewrite the card.
- **Outcomes record who set them** (`outcome_via`: driver or person; a legacy one is a person's). A driver never overwrites a person's outcome. Its note is stored (`outcome_note`).
- **`decisionId` on decide** refuses an answer to a decision the driver didn't read.
- **Delivery to a requeued session.** A `queued` session (after a requeue) still gets its answer, since the next worker reads the stream from the start.

## Risks / Trade-offs

- **The relay is in the path.** With the Mac asleep, an escalation waits; the session waits with it. That is the person's queue anyway.
- **A superseded escalation leaves its review open.** If the session re-files after escalating, the review's eventual decision routes nowhere. Acceptable for now; closing it would need another relay action.
- **Driver identity is any agent token.** Any `agent` token (not a session token) can decide, release, or escalate any session. This is deliberate: a driver must be able to act on sessions another driver requested. There is no ownership check by requester.
- **The claimed window** (second review). A decide is allowed on an escalation only when it actually cancels the still-queued action. Once the relay has claimed it, the decide is refused ("being filed; retry shortly"), so the review it files still routes to the session. A re-file is never refused. If the relay files a review whose decision has meanwhile been superseded or decided, the report's follow-up queues a `review_withdraw` relay action that closes it (a closed review no longer blocks its work item). It is queued once, recorded as `withdraw_action_id`.
- **brain_merge** refuses an escalation's inbox item (`hangar-decision:`), as it does an outcome request: its decision routes on its id.
- **Version skew.** An older hangar keeps filing inbox items and keeps working; a newer hangar falls back on `404` from an older Breakdown.
