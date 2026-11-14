## Purpose

Lets a Breakdown that lacks `bd`, `herdr`, and the beads checkouts (the Jetson) keep review decisions, herdr reply delivery, and the beads board working, by queuing those actions for a relay on the Mac that has them.

## ADDED Requirements

### Requirement: Host-binary actions queue for the relay

When the server lacks a binary that an action needs, it SHALL record a relay action in state `queued` instead of refusing with 412, and SHALL answer the caller that the action is pending. This covers three actions:
- a review decision (needs `bd`, then `herdr`);
- a herdr reply to a local session after an inbox decision (needs `herdr`);
- any beads checkout's re-ingest the board asks for (needs `bd`).

Each action SHALL record:
- its kind;
- its arguments, as validated data, never a command string;
- the project or pane it targets;
- who requested it, and when.

When the binaries are present, the server SHALL run the action directly, exactly as before. Session-opening actions SHALL keep answering 412.

#### Scenario: Accept on the Jetson

- **WHEN** a person accepts option B of a review on a Breakdown with no `bd`
- **THEN** a `review_decision` action is queued with the review, option, and message, the caller is told it is pending, and nothing answers 412

#### Scenario: Accept on the Mac

- **WHEN** the same accept happens on a Breakdown that has `bd`
- **THEN** it runs `bd` directly and no relay action is created

### Requirement: The relay claims and reports actions

The relay SHALL claim queued actions over authenticated HTTP with a `relay`-scoped token. It SHALL claim by long-poll, waiting at most 30 seconds, oldest first, and an action SHALL go to exactly one claimer even when claims race. The relay SHALL report each claimed action `done` or `failed`, with a result or an error message. Breakdown SHALL return a claimed action that is not reported within 5 minutes to `queued`, so a relay that died mid-action does not lose it. A review decision whose issue has already moved past the decision when the relay runs it SHALL be reported `done` with a note, not run twice.

#### Scenario: Relay runs an accept

- **WHEN** the relay claims a queued `review_decision` and runs it against the local checkout
- **THEN** the review's bead gets the comment and is closed, the session's herdr pane gets the reply, and the action is reported `done`

#### Scenario: Relay dies mid-action

- **WHEN** the relay claims an action and never reports it
- **THEN** after 5 minutes the action is `queued` again and the next claim takes it

### Requirement: Only allowlisted commands run

Before running anything, the relay SHALL check every command against an allowlist, and Breakdown SHALL refuse at enqueue any action whose arguments fall outside it. The allowlist is:
- `bd show <id> --json`;
- `bd comments add <id> <text>`;
- `bd update <id> --add-label review:changes` or `--remove-label review:changes`;
- `bd close <id> --reason <text>`;
- `herdr agent prompt <pane> <text>`;
- the read-only `bd` commands the beads ingest uses.

Issue ids, panes, and project paths SHALL match their expected shapes. A project path SHALL be one the relay's own registry lists. Every command SHALL run with an argument vector, never through a shell.

#### Scenario: Forged action

- **WHEN** a queued action carries `bd delete` or a project path the relay does not know
- **THEN** the relay refuses to run it and reports it `failed` naming the reason, and nothing runs

### Requirement: The board stays live from the relay

The relay SHALL run the beads watcher against its local checkouts and push each project's ingest batch to Breakdown over authenticated HTTP. Breakdown SHALL apply the batch with the same idempotent beads upsert as a local ingest, attributed to the relay's client, and SHALL emit the same board events so open boards refresh. A push for a project Breakdown has not registered SHALL be refused. When Breakdown runs on the Mac with `bd`, its own watcher SHALL keep working, and the relay SHALL NOT be needed.

#### Scenario: Bead changes on the laptop

- **WHEN** a bead is updated in a checkout on the Mac while the board is open against the Jetson
- **THEN** the relay pushes the project's batch, and the open board shows the change without a reload

### Requirement: Relay status is visible

The relay SHALL check in on an interval, and every claim SHALL count as a check-in. Breakdown SHALL report the relay as:
- online, when it last checked in within three intervals;
- offline, with the time of its last check-in, otherwise;
- never seen, when it has never checked in.

That status SHALL appear on the board whenever relay actions are queued or the server lacks `bd` or `herdr`. A pending action SHALL show as pending in the UI until it is done or failed, and a failure's message SHALL be shown.

#### Scenario: Relay offline

- **WHEN** a review decision is queued while the relay last checked in two hours ago
- **THEN** the review shows the decision as pending, and the board says the relay has been offline since then
