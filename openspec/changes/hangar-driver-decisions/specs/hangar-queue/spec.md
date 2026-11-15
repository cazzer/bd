## ADDED Requirements

### Requirement: A worker files its result for its driver

A worker SHALL file its result with its session token through `POST /hangar/v1/decision`: a kind (`pr` or `question`), a title, an optional summary, a PR URL (required for `pr`), and an optional decision card. It SHALL be stored as the session's pending decision, superseding any open one, and SHALL NOT be an inbox item. Only a `claimed` or `running` session SHALL file one, and always the token's own session.

#### Scenario: A PR reaches the driver, not the inbox

- **WHEN** a worker files a `pr` result with a card for session S
- **THEN** S has a pending decision with that card, and no inbox item is filed for S

### Requirement: A filed card is held to the contract

A filed decision card SHALL follow the review card contract (question, options, recommend, on_accept) with an optional evidence body, and SHALL be refused, never trimmed, when it breaks it or carries any other key.

#### Scenario: An over-long card is refused

- **WHEN** a worker files a card whose question is over 140 characters
- **THEN** the request is a `400 invalid_request` naming the card, and nothing is stored

### Requirement: The answer reaches the session with an inbox decision's body

An answer to a session's decision SHALL reach the session as a `session_decision` message whose body carries every `inbox_decision` field, with `item_id` the decision's id, plus who decided (`by`) and how (`via`: `driver`, `review`, or `inbox`). A session that has ended SHALL NOT be answered by the driver.

#### Scenario: The driver's answer reaches the worker

- **WHEN** the driver accepts S's pending decision with option `b`
- **THEN** S's messages carry a `session_decision` with `item_id` the decision's id, `decision: "accept"`, `option: "b"`, and `via: "driver"`, and S has no open decision

### Requirement: An escalated decision goes to the person as a review

When the driver escalates a session's pending decision, it SHALL be filed for the person as a review under the session's work item, through the laptop relay, when the work item's beads project is registered. Otherwise it SHALL be filed as an inbox item with the card, bound to the session. From then on the driver SHALL NOT be able to answer it.

#### Scenario: The driver cannot decide it

- **WHEN** the driver tries to answer S's escalated decision
- **THEN** it is refused, and nothing is sent to S

#### Scenario: A work item without a beads project

- **WHEN** the driver escalates for a session whose work item has no registered beads project, and the person accepts the inbox item filed for it
- **THEN** S's messages carry a `session_decision` for the decision with `via: "inbox"`, and the inbox item is done

### Requirement: The person's decision is routed on the server's own record

The person's decision on an escalation's review or inbox item SHALL reach the session, matched on the server's record of where the escalation went (the review's project and bead id, or the inbox item's id), never on anything a review's or item's writer sets. A review decision queued for the relay SHALL reach the session only once the relay reports it done.

#### Scenario: The person decides an escalated review

- **WHEN** the driver escalates S's decision, the relay files review R, and the person's decision on R is written
- **THEN** S's messages carry a `session_decision` with `via: "review"` and the person as `by`

### Requirement: The driver releases an ended session

The session's driver, with an `agent` token that is not a session token, SHALL be able to set an ended session's outcome directly, recorded with `outcome_by` its client name, with the same effect as a person's. Releasing SHALL NOT file anything for the person. Neither a session token nor the `hangar` token SHALL set an outcome.

#### Scenario: A driver tables a session

- **WHEN** the driver tables stopped session S
- **THEN** S's outcome is `tabled` with `outcome_by` the driver's client, and no inbox item is filed

### Requirement: An escalation never strands its decision

An escalated decision whose review is not filed yet SHALL remain answerable by the driver, which SHALL withdraw the queued relay action. A `review_request` that fails, whether reported or failed when claimed, SHALL put its decision back to pending. Filing a new decision SHALL withdraw the queued action of the one it supersedes.

#### Scenario: The relay never files it

- **WHEN** the driver escalates S's decision and the relay never runs the `review_request`
- **THEN** the driver can still answer the decision, and the queued action is failed as withdrawn

#### Scenario: The claim abandons it

- **WHEN** the `review_request` is failed when claimed, with no report
- **THEN** S's decision is pending again, with the error, and can be escalated again

### Requirement: The driver answers only the decision it read

A driver's answer naming a decision id SHALL be refused when the session's open decision is another.

#### Scenario: The worker re-filed meanwhile

- **WHEN** the driver answers decision D1 after S has filed D2
- **THEN** the answer is refused naming D2, and nothing is sent
