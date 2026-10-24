## ADDED Requirements

### Requirement: A work item may name its project

A work item's metadata MAY carry `project`: a short key naming the project the item belongs to, such as the repository whose tracker it was loaded from. When present it SHALL be a non-empty string of at most 64 characters drawn from lowercase letters, digits, `-`, `_`, and `.`; surrounding whitespace SHALL be trimmed, and an empty or absent value SHALL leave the key absent. A value outside that form SHALL be rejected naming the item and `project`, and nothing SHALL be persisted. The key SHALL be enforced by every writer that applies the work-item contract and SHALL NOT be changed by a work-item field patch, so that the loader that owns an item is the only writer of its project.

#### Scenario: Project stored

- **WHEN** a work item is written with `project` set to ` tides `
- **THEN** it is stored with `project` as `tides`

#### Scenario: Invalid project

- **WHEN** a work item is written with `project` set to `Tides Repo`
- **THEN** the write is rejected naming `project`, and no node is persisted

#### Scenario: Patching leaves project alone

- **WHEN** a work item with `project` `tides` has its status patched to `in_progress`
- **THEN** its `project` is still `tides` afterwards

#### Scenario: Work items without a project

- **WHEN** a work item is written with no `project`
- **THEN** it is stored with no `project` key, and every other part of the contract applies unchanged
