# Spec Delta

## Purpose

An inbox item is a decision about some piece of work, and the work, not the item, remembers what the person decided. A signal about settled work reaches the person only when it would change a decision.

Open decisions 1 and 2 in design.md are resolved: the work context is a native `work_item`, and the agent matches signals to it.

## ADDED Requirements

### Requirement: An inbox item links to the work it is about

An inbox item MAY carry one `about` edge to a `work_item` node, written by the agent with a confidence weight. The inbox read SHALL return each item's `about` target (id, title, project), folded through `merged_into`. An item without one SHALL be served as before.

#### Scenario: Linked item

- **WHEN** an agent writes a Slack-sourced inbox item with an `about` edge to the work item "Vendor RFI"
- **THEN** the inbox serves the item with its work context "Vendor RFI"

#### Scenario: Merged work context

- **WHEN** the work item an inbox item is about is merged into another
- **THEN** the inbox serves the survivor as the item's work context

### Requirement: The person can unlink a wrong work context

The detail pane SHALL show an item's work context with a control that removes its `about` edge. Removing it SHALL leave the item's status and feedback unchanged.

#### Scenario: Unlink

- **WHEN** the person presses "not this" on an item shown as about "Vendor RFI"
- **THEN** the item has no work context afterwards and stays pending

### Requirement: The ingest matches a signal to work before writing

Before writing an inbox item, the ingest agent SHALL search the store for the work context the signal belongs to, and SHALL read that context's recorded decisions and signals. With no confident match, it SHALL create a work context for the signal.

#### Scenario: Second source, same work

- **WHEN** a Slack thread about the Vendor RFI arrives and a work item "Vendor RFI" already exists from the Asana task
- **THEN** the new item, if one is written, is linked `about` the existing work item and no second work item is created

### Requirement: A signal consistent with settled work is kept as history

When a matched work context's recorded decisions already settle what a signal asks or reports, the ingest SHALL record it as a signal on the work context (title, link, one-line gist) and SHALL NOT write an inbox item for it. A signal that contradicts or reopens a recorded decision, or that addresses the person directly with a question, SHALL be written as an inbox item whose content names the decision it affects.

#### Scenario: Already answered

- **WHEN** a Slack message repeats an Vendor RFI question whose recorded decision is "Alex answered, no action"
- **THEN** the message is recorded as a signal on the Vendor RFI work item and no inbox item is written

#### Scenario: Reopens a decision

- **WHEN** a PR the person closed out has a new review request with new commits
- **THEN** an inbox item is written whose content begins by naming the earlier decision and its date

### Requirement: Decisions are recorded on the work context

When an inbox item linked to a work context is closed, acted on, or accepted with a note, the agent carrying it out SHALL append `{ at, decision, note, item }` to the work context's `decisions`, keeping the most recent 50.

#### Scenario: Close recorded

- **WHEN** the agent closes an Vendor RFI item on the note "Sam already wrote this so no need to change it"
- **THEN** the Vendor RFI work item's decisions gain an entry with that note and the item's id

### Requirement: Needs me groups items by work context

Needs me SHALL show pending items that share a work context as one row titled with the work context, with its items beneath it. Items without a work context SHALL be listed as before.

#### Scenario: Grouped RFI

- **WHEN** five pending items are linked to "Vendor RFI"
- **THEN** Needs me shows one "Vendor RFI" row with the five items under it
