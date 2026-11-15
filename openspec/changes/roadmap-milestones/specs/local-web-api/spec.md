## ADDED Requirements

### Requirement: Roadmap read

The server SHALL expose a roadmap read that accepts an optional set of project keys, validated as the board read validates them, and answers for those projects (or every registered project when none are named), in one database statement: each milestone with its id, title, status, project, `due_at`, and progress; each epic with its id, title, status, project, milestone (or none), `due_at`, `started_at`, `closed_at`, first start among its items, and progress; and the counts of items that belong to no epic per milestone. Progress SHALL be the counts of contained non-epic, non-milestone items by status group (closed, in progress, deferred, other open), each item counted once per epic or milestone however many paths reach it. The read SHALL return no content and SHALL be bounded in size, stating when it was cut. It SHALL be reachable by the same token scopes as the board read and SHALL change nothing.

#### Scenario: One project's roadmap

- **WHEN** the roadmap is read for `tides`, which has two milestones and five epics
- **THEN** both milestones and all five epics come back with their progress, and nothing from any other project

#### Scenario: Task reached twice

- **WHEN** a parent cycle makes a task reachable twice under one epic
- **THEN** the task counts once in that epic's progress and once in its milestone's

#### Scenario: Unknown project key shape

- **WHEN** the roadmap is read for a project key with uppercase letters
- **THEN** the read is refused naming `projects`, as the board read refuses it
