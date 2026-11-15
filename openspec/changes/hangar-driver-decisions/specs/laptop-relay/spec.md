## ADDED Requirements

### Requirement: The relay files an escalated review

The relay SHALL run a `review_request` action: file a review (a beads issue labelled `review`, carrying the decision card and a key as its review metadata) under a work item in the project's registered checkout, make a new review block the work item unless it is an epic, and report the review's bead id. A `review_request` SHALL never be failed as stale.

#### Scenario: A review is filed

- **WHEN** the relay runs a `review_request` for work item W
- **THEN** a review under W carries the card, blocks W, and the report names its id

### Requirement: A retried review request files no second review

The relay SHALL reuse the work item's open review holding the request's key instead of filing another.

#### Scenario: A retry finds the review it filed

- **WHEN** the relay runs a `review_request` whose key an open review of the work item already holds
- **THEN** it updates that review's metadata, files no new issue, and reports its id with `reused: true`

### Requirement: Filing a review runs only allowlisted commands

Filing a review SHALL use only allowlisted `bd` argument vectors whose literals are fixed and whose metadata is a valid keyed card, checked by Breakdown at enqueue and by the relay before spawning.

#### Scenario: A forged command runs nothing

- **WHEN** a `review_request` payload carries a title starting with `-` or metadata that is not a keyed card
- **THEN** Breakdown refuses it at enqueue, and the relay refuses it again before spawning anything

### Requirement: The relay closes a stale escalated review

The relay SHALL run a `review_withdraw` action: close an open review, with the given reason, only when `bd show` reads it as that exact issue labelled `review`. A review already closed SHALL be reported done. A `review_withdraw` SHALL never be failed as stale.

#### Scenario: A review filed after its decision moved on

- **WHEN** a session files a new decision while the relay is filing its earlier escalation's review R
- **THEN** Breakdown queues a `review_withdraw` for R once, and the relay closes R
