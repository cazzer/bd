## ADDED Requirements

### Requirement: A person releases an ended session

Every hangar session SHALL carry an outcome: none, `accepted`, or `tabled`. Only a person SHALL set it, either directly or by accepting an inbox request an agent filed. The direct paths are a web API procedure that admits `human` only, and the tokenless local person. The outcome SHALL be settable only on a `stopped` or `failed` session. A person SHALL be able to change it until hangar has acknowledged the release. Setting it SHALL be recorded as a revision of the session node, and SHALL make the session the most recently changed in hangar's session listing. The outcome SHALL be returned wherever a session is: the REST session object, the MCP tools, and the board. No `agent`, session, or `hangar` token SHALL set it.

#### Scenario: Tabling a stopped session

- **WHEN** a person tables stopped session S from the board
- **THEN** S's outcome is `tabled`, its history shows the person's change, and hangar's next `GET /hangar/v1/sessions?state=stopped` lists S first with `outcome: "tabled"`

#### Scenario: A running session can't be tabled

- **WHEN** a person tries to accept a session that is still `running`
- **THEN** it is refused naming the state, and nothing changes

#### Scenario: Hangar can't decide

- **WHEN** the hangar token sends `PATCH /hangar/v1/sessions/:id` with an `outcome`
- **THEN** the field is ignored and the outcome is unchanged

### Requirement: Agents ask for an outcome; people decide

An agent SHALL be able to ask for a session's outcome by filing an inbox item bound to that session, offering Accept and Table. The item's decision by a person SHALL set the outcome; a dismissal SHALL leave it unset. Session tokens and the hangar token SHALL NOT be able to file such a request.

The request's card SHALL be the server's: its title, its content's facts about the session, its question, its two options with fixed labels and text, and its recommendation (the requested outcome) SHALL be written by the server. The agent's note SHALL appear only below those facts, quoted and attributed to the agent. No other writer SHALL create, overwrite, or change an outcome request: an inbox key reserved for outcome requests SHALL be refused to every generic inbox writer, and an accept SHALL be refused unless the stored options are still the server's. The card SHALL show, outside the agent's text, a banner built from the bound session's current state: which session a click releases and that it deletes the disk.

#### Scenario: Driver asks to table

- **WHEN** a driver skill requests that session S be tabled, and the person chooses Table on the inbox item
- **THEN** S's outcome is `tabled`, attributed to the person

#### Scenario: An agent can't write the card

- **WHEN** an agent writes an inbox item at session S's outcome-request key, with any token, before or after the request is filed
- **THEN** the write is refused, nothing is stored, and the person's card for S is the server's

#### Scenario: A relabelled card can't decide

- **WHEN** an outcome request's stored options differ from the server's, and the person accepts an option
- **THEN** the decision is refused as a changed card, and S's outcome is unchanged

### Requirement: Hangar reports why it failed a session and acknowledges release

`PATCH /hangar/v1/sessions/:id` with `state: "failed"` SHALL accept a `reason` of 1–500 characters, stored as the session's failure reason on the move into `failed` and returned on the session; a repeated `failed` report SHALL keep the reason stored first. On a `stopped` or `failed` session, a PATCH SHALL be able to clear `container` and `disk_path` by sending `null`, and SHALL NOT set either to a value. Clearing a held disk path is hangar's acknowledgement that it released the session, and SHALL be refused until a person has set an outcome. A session whose outcome is set and whose disk path is null SHALL be reported as released, and SHALL take no change but a clear. A refused PATCH SHALL change nothing and answer `409 session_ended`.

#### Scenario: Release acknowledged

- **WHEN** hangar sends `PATCH {"container": null, "disk_path": null}` for tabled session S
- **THEN** S's container and disk path are cleared, and S counts as released

#### Scenario: Ack before an outcome

- **WHEN** hangar sends `PATCH {"container": null, "disk_path": null}` for ended session S, which still holds a disk and has no outcome
- **THEN** it is refused with `409 session_ended`, and S keeps its disk path

#### Scenario: A released session stays released

- **WHEN** hangar sends a `disk_path` value for released session S
- **THEN** it is refused with `409 session_ended`, and S is still released

#### Scenario: Reason on failure

- **WHEN** hangar reports session S `failed` with reason `git clone exited 128`
- **THEN** reading S shows that failure reason
