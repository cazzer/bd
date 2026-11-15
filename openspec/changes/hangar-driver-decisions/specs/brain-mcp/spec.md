## ADDED Requirements

### Requirement: Driver tools for hangar sessions

The server SHALL expose three write tools for the agent driving a hangar session: `brain_hangar_outcome` (set an ended session's outcome), `brain_hangar_decide` (answer its pending decision: accept, changes with a note, or dismiss), and `brain_hangar_escalate` (hand the pending decision to the person). A session-bound token SHALL neither be shown nor allowed them, and read-only mode SHALL refuse them.

#### Scenario: A session token cannot decide its own work

- **WHEN** a session token lists or calls `brain_hangar_decide`
- **THEN** the tool is not listed, the call is refused, and nothing is written

### Requirement: Tool descriptions say when to escalate

Each driver tool's description SHALL say plainly when to use it and when not: routine calls (PR reviews and merges, releases, choosing among options, clarifications) are the driver's, and only a decision that changes the architecture or sets a fundamental direction is escalated.

#### Scenario: Reading the escalate tool

- **WHEN** an agent lists the tools
- **THEN** `brain_hangar_escalate`'s description names both when to use it and the routine calls it is not for

### Requirement: Sessions show their pending decision

The session listing tool SHALL show each open session's pending decision (`pendingDecision`): its kind, title, summary, PR URL, card, and whether it is escalated, or null when there is none.

#### Scenario: A filed PR is listed

- **WHEN** session S's worker has filed a PR and the driver lists S
- **THEN** S's `pendingDecision` carries that PR's title, URL, and card, with state `pending`

### Requirement: The outcome request tool is retired

`brain_hangar_outcome_request` SHALL NOT be advertised, and SHALL refuse every call with a pointer to `brain_hangar_outcome`, filing nothing.

#### Scenario: The retired tool files nothing

- **WHEN** an agent calls `brain_hangar_outcome_request` for an ended session
- **THEN** the call is refused naming `brain_hangar_outcome`, and no inbox item is filed
