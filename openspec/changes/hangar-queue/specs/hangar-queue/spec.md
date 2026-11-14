## Purpose

Breakdown as the control plane for hangar, the service that runs remote Claude sessions on a machine that only connects out and is often offline. Requests queue in Breakdown, hangar pulls them and reports back, and sessions and their messages are tracked here.

## ADDED Requirements

### Requirement: Session requests queue until hangar claims them

A caller SHALL be able to request a hangar session for a repo and a work item, with a flavor of `headless`, `display-godot`, or `display-browser`. The request SHALL be recorded as a session in state `queued`, linked to its work item, whether or not hangar is online, and SHALL report hangar's current status to the caller. Hangar SHALL claim queued requests over authenticated HTTP. A claim SHALL take the oldest queued request whose flavor is among those hangar names, SHALL hand any request to exactly one claimer even when claims race, and SHALL wait up to a caller-given bound (at most 30 seconds) for one to arrive before answering that there is none. A queued request that cannot be claimed (its record breaks the session contract, or its session token's client name is already held) SHALL be marked `failed` with a reason, and the claim SHALL go on to the next match rather than fail. Only the `run_by` edge the queue writes SHALL name a session's work item: no generic edge write SHALL create an edge under source system `hangar` or out of a session.

#### Scenario: Request while hangar is offline

- **WHEN** a skill requests a `headless` session for work item W while hangar last checked in two hours ago
- **THEN** the session is recorded as `queued` with a `run_by` edge to W, and the response says hangar is offline since that check-in

#### Scenario: Claim

- **WHEN** hangar claims with flavors `headless` and `display-browser` while a `display-godot` request and a later `headless` request are queued
- **THEN** it receives the `headless` request, which becomes `claimed`, and the `display-godot` request stays queued

#### Scenario: Racing claims

- **WHEN** two claims arrive at the same moment and one request is queued
- **THEN** exactly one claim receives it and the other receives none

#### Scenario: Long-poll

- **WHEN** hangar claims with a 25-second wait and a matching request is enqueued 5 seconds later
- **THEN** the claim answers with that request without waiting out the full 25 seconds

#### Scenario: Unclaimable request at the head of the queue

- **WHEN** the oldest queued `headless` request's record breaks the session contract and a later `headless` request is queued
- **THEN** a `headless` claim marks the first `failed` with a reason and receives the second

#### Scenario: Worker cannot repoint its session

- **WHEN** a worker links its session to another work item with `run_by` over MCP
- **THEN** the link is refused, nothing is stored, and the session still names its own work item

### Requirement: Claiming issues a session token

A successful claim SHALL return, exactly once, a new `agent`-scoped client token bound to the claimed session. Breakdown SHALL store only its hash, like any other token. Requests admitted by the token SHALL be attributed to the session's client, and its messages SHALL be the session's own. The token SHALL be revoked when the session reaches `stopped` or `failed`, or when the claim is requeued. Only a `hangar`-scoped token SHALL be able to claim.

A session token SHALL be refused `brain_merge` and `brain_hangar_request` over MCP, and those tools SHALL not be listed for it. No merge SHALL move a hangar session, as loser or survivor, whatever token asks. A session-bound inbox request SHALL re-send only items its own session filed: a key naming an item another session filed, or one no session filed, SHALL be refused and nothing written.

#### Scenario: Worker uses its session token

- **WHEN** a worker uses the token from its session's claim to write a node over MCP
- **THEN** the write is admitted and attributed to that session's client

#### Scenario: Token ends with the session

- **WHEN** hangar marks the session `stopped`
- **THEN** a request carrying that session's token is refused with 401

#### Scenario: Agent cannot claim

- **WHEN** a worker's `agent` token is used to claim
- **THEN** it is refused with 403 and nothing changes

#### Scenario: Session token cannot merge a session

- **WHEN** a worker calls `brain_merge` with its session token, or any client merges a hangar session into another node or another node into it
- **THEN** the merge is refused, and every session stays canonical with its token and inbox items bound to it

#### Scenario: Worker cannot take another session's item

- **WHEN** worker A files an inbox request with the key of an item session B filed, or of a local session's item
- **THEN** it is refused, the item is unchanged, and decisions on it still go where they went before

#### Scenario: Worker re-sends its own item

- **WHEN** worker A files an inbox request again with the key of an item its own session filed
- **THEN** the item is updated and stays bound to session A

### Requirement: Hangar reports session state

Hangar SHALL update each session it claimed with its state (`running`, `stopped`, `failed`) and with its container, host, and disk path as they become known. Only the hangar that claimed a session SHALL be able to update it. A transition SHALL be refused unless it moves forward along `queued` → `claimed` → `running` → `stopped`, or reaches `failed` from any state except `stopped`. Hangar SHALL be able to return a claimed session to `queued` with a reason when it cannot start it, and the reason SHALL be visible on the session. Each change SHALL be recorded as a revision of the session node.

#### Scenario: Session runs

- **WHEN** hangar reports session S `running` with container `c-12`, host `hangar-linux`, and disk path `/var/lib/hangar/disks/S.img`
- **THEN** reading S shows those values and state `running`, and its history shows the change attributed to hangar

#### Scenario: Backwards transition refused

- **WHEN** hangar reports a `stopped` session as `running`
- **THEN** the update is refused naming both states, and the session is unchanged

#### Scenario: Requeue

- **WHEN** hangar returns claimed session S to the queue with reason "disk budget full"
- **THEN** S is `queued` again with that reason, its session token is revoked, and the next claim can take it

### Requirement: Hangar status is known from check-ins

Hangar SHALL check in on an interval, and every claim SHALL count as a check-in. A check-in SHALL record when it happened, the hangar's name and version, and an opaque capacity object for later use. Breakdown SHALL report hangar as `online` when its last check-in is newer than three check-in intervals, `offline` with the time of its last check-in otherwise, and `never` when it has never checked in. This status SHALL be readable through MCP and shown on the web board. Check-ins SHALL NOT be written as node revisions.

#### Scenario: Hangar goes away

- **WHEN** hangar's last check-in was at 09:00 and it is now 11:00
- **THEN** the status reads offline since 09:00, through MCP and on the board

#### Scenario: Never seen

- **WHEN** no hangar has ever checked in
- **THEN** the status reads that hangar has never checked in

### Requirement: Workers receive their messages by long-poll

A worker SHALL fetch its session's messages with its session token, waiting up to a bound (at most 30 seconds) for one to arrive, and SHALL pass back a cursor so that each message is delivered after the last one it acknowledged. A worker SHALL NOT be able to read another session's messages. When a person decides an inbox item or review that a remote session filed, the decision SHALL be queued as a message to that session instead of being typed into a herdr pane. Items filed by a local session SHALL keep herdr delivery. The session an item belongs to SHALL be taken from the token that filed it, never from the request body.

#### Scenario: Reply reaches a remote session

- **WHEN** a worker files a review request with its session token, and a person accepts option B with a message
- **THEN** the worker's next long-poll returns a message carrying the decision and the message, and no herdr command runs

#### Scenario: Local session unchanged

- **WHEN** a local session's item, recorded with a herdr pane, is decided
- **THEN** the decision is typed into that pane as before

#### Scenario: Another session's messages

- **WHEN** worker A's token is used to fetch messages
- **THEN** only session A's messages are returned, whatever the request names

### Requirement: The HTTP contract is published

The hangar-facing and worker-facing HTTP endpoints SHALL be documented in the repository: each method and path, the required token scope, request and response bodies with example JSON, status codes and error bodies, long-poll and cursor semantics, the session state machine, and the check-in interval and offline rule. The document SHALL be versioned under its path prefix, and a test SHALL fail when an endpoint is added or removed without updating the document.

#### Scenario: Contract stays in step

- **WHEN** a hangar endpoint is added to the server but not to the document
- **THEN** the test that compares the router's endpoints with the document fails
