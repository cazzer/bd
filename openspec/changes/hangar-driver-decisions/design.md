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

## Risks / Trade-offs

- **The relay is in the path.** With the Mac asleep, an escalation waits; the session waits with it. That is the person's queue anyway.
- **A superseded escalation leaves its review open.** If the session re-files after escalating, the review's eventual decision routes nowhere. Acceptable for now; closing it would need another relay action.
- **Driver identity is any agent token.** Any `agent` token (not a session token) can decide any session's pending decision. Reasonably constrained, not ironclad: drivers and the person's own sessions share the scope today. Binding a session to its requesting client is a follow-up if needed.
- **Version skew.** An older hangar keeps filing inbox items and keeps working; a newer hangar falls back on `404` from an older Breakdown.
