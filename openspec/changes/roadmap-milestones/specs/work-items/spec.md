## ADDED Requirements

### Requirement: Work items may carry planning dates

A work item's metadata MAY carry `due_at` (the date the item is meant to be done by) and `started_at` (the moment work on it began). Each SHALL be stored only in the fixed-width UTC instant form that `occurred_at` uses (`2026-12-15T00:00:00.000Z`), accepted from a string that carries a zone (`Z` or `±HH:MM`) or is a date alone (UTC midnight). `null` or absent SHALL delete the key. Any other value SHALL be rejected naming the item, the field, and the value, and nothing SHALL be persisted. Every writer that applies the work-item contract SHALL apply this rule.

#### Scenario: Date-only due date

- **WHEN** a work item is written with `due_at` `2026-12-15`
- **THEN** it is stored as `2026-12-15T00:00:00.000Z`

#### Scenario: Zoneless instant refused

- **WHEN** a work item is written with `started_at` `2026-11-15T10:00:00`
- **THEN** the write is rejected naming `started_at` and that value, and no node is persisted

#### Scenario: Clearing a due date

- **WHEN** a work item with a `due_at` is re-written with `due_at` null
- **THEN** it is stored with no `due_at` key

### Requirement: The beads importer carries planning dates

Loading a beads project SHALL carry each issue's `due_at` and `started_at`, when the tracker reports them, into the work item's metadata under the planning-date rule. An issue the tracker reports without one SHALL have no such key. An issue whose tracker value cannot be read under the rule SHALL fail the load naming the issue and the field, as an unreadable `created_at` does.

#### Scenario: Milestone with a due date

- **WHEN** a project's tracker holds a milestone due `2026-12-15T00:00:00Z`
- **THEN** after loading, its work item carries `due_at` `2026-12-15T00:00:00.000Z` and issue type `milestone`

#### Scenario: Claimed task

- **WHEN** a task was claimed at `2026-11-15T16:22:12Z`
- **THEN** after loading, its work item carries that `started_at`

#### Scenario: Re-load with no change

- **WHEN** a project is loaded twice with no tracker change in between
- **THEN** the second load reports every item unchanged

### Requirement: A milestone contains epics through the parent relationship

A work item of issue type `milestone` SHALL be an ordinary work item. Its contents SHALL be the items that name it as parent (`child_of`), directly or through further parents: usually epics, and also any item placed directly under it. An item's milestone SHALL be its nearest ancestor along parent relationships that is a work item of issue type `milestone`; an item SHALL belong to at most one milestone. A parent cycle SHALL NOT prevent any read from answering.

#### Scenario: Epic under a milestone

- **WHEN** an epic's parent is a milestone and a task's parent is that epic
- **THEN** both the epic and the task belong to that milestone

#### Scenario: Nested epics

- **WHEN** an epic's parent is another epic whose parent is a milestone
- **THEN** the inner epic, and its items, belong to that milestone

#### Scenario: No milestone

- **WHEN** an epic has no milestone among its ancestors
- **THEN** it belongs to no milestone
