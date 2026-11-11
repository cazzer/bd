# Spec Delta

## Purpose

The person's direction on an inbox item is carried out by an agent without a second card, unless it needs the person to see something new. The primary action does not ask the person to choose between approving and requesting changes.

## ADDED Requirements

### Requirement: The inbox's primary action follows the note box

On an inbox item without options, the decision footer SHALL show one primary action. While the note box is empty or blank it SHALL read Accept and record `accept`. While it holds a non-blank note it SHALL read Send to agent and record `changes` with the note. Ctrl/Cmd+Enter SHALL take the primary action in either state. Board reviews SHALL keep their current footer.

#### Scenario: Empty note accepts

- **WHEN** the person presses the primary action on a pending inbox item with an empty note box
- **THEN** the item is recorded `accept` with an empty message and moves to `accepted`

#### Scenario: Typed note sends to the agent

- **WHEN** the person types "already sent a message, close this" and presses the primary action
- **THEN** the button read Send to agent, and the item is recorded `changes` with that message and moves to `changes`

#### Scenario: Board review unchanged

- **WHEN** the person opens a board review in the drawer
- **THEN** Accept and Request changes are shown as separate actions, as before

### Requirement: Choosing a card option keeps its note

On an inbox item whose card has options, choosing an option SHALL record `accept` with that option and the current note, whether the note box is empty or not.

#### Scenario: Option with a note

- **WHEN** the person types "track only the first two" and chooses `track`
- **THEN** the item is recorded `accept` with option `track` and that message

### Requirement: Dismiss keeps the typed note

Dismissing an inbox item SHALL record the current note box contents as the dismiss message, from every Dismiss control and the `d` key.

#### Scenario: Dismiss with a note

- **WHEN** the person types "dupe of the Asana task" and presses Dismiss
- **THEN** the feedback entry is `dismiss` with message "dupe of the Asana task"

### Requirement: An item sent to the agent is triaged into close, act, or re-queue

An agent handling an item in `changes` SHALL read the latest feedback message and write exactly one outcome:
- **close** when the note says the item is done, handled, not the person's, or needs no action: status `done` with `close_reason`.
- **act** when the note fully specifies the outcome and what goes out is the reviewed draft with at most the edits the note names: carry it out, then status `done`.
- **re-queue** otherwise: status `pending` with a one-line `revision`.

The agent SHALL re-queue whenever acting would send text under the person's name that the person has not read, and whenever it is unsure.

#### Scenario: Close note

- **WHEN** an item's latest feedback is `changes` with "this question isn't addressed at me, ignore it and close this issue"
- **THEN** the agent writes it `done` with that note as `close_reason`, and it does not return to Needs me

#### Scenario: Specified edit is acted on

- **WHEN** an item's draft is a Slack reply and the note is "send it but drop the last line"
- **THEN** the agent sends the draft without its last line, and writes the item `done` with a `**Done:**` line linking the message

#### Scenario: New outbound text is re-queued

- **WHEN** the note is "go read the PR and propose real feedback"
- **THEN** the agent writes new review comments into the draft, and writes the item `pending` with a `revision` saying what changed

### Requirement: Revision and close reason are part of the inbox contract

Inbox item metadata SHALL accept `revision` (a single line of at most 200 characters) and `close_reason` (at most 500 characters), both optional. A value of the wrong type or length SHALL be refused, naming the item and the field. A new person decision on the item SHALL remove `revision`. The detail pane SHALL show `revision` on a pending item and `close_reason` on a closed one.

#### Scenario: Revision shown and cleared

- **WHEN** an agent re-queues an item with `revision: "rewrote the reply to drop the alias line"`, and the person then accepts it
- **THEN** the revision line is shown above the content while it is pending, and is absent from the item once accepted

### Requirement: Every handler of a sent-back item triages

The inbox watcher's run for `changes` items, the ingest's revise step, and the prompt sent to a session that owns a `changes` item SHALL each instruct the close / act / re-queue triage, not a revise-and-re-queue.

#### Scenario: Session-owned item

- **WHEN** the person sends a note on an item queued from a live session
- **THEN** the session's prompt names the three outcomes and the command that closes the item, as well as re-queuing with the same key
