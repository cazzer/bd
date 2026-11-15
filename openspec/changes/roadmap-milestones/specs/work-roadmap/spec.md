## Purpose

Shows each project's plan over time: milestones in date order, the epics that make them up on a shared timeline, and progress rolled up from their items, so a reader can see how far along each body of work is and whether it is on schedule.

## ADDED Requirements

### Requirement: Progress rolls up from items to epics to milestones

An epic's progress SHALL count every non-epic, non-milestone item that has the epic among its ancestors, nested epics' items included. A milestone's progress SHALL count every non-epic, non-milestone item that belongs to it, whether through an epic or directly. Progress SHALL be shown as the share of counted items that are closed, alongside the in-progress count, and deferred items SHALL be shown separately and left out of the share. An epic or milestone with no counted items SHALL show no share, not 0% or 100%.

#### Scenario: Milestone across two epics

- **WHEN** a milestone holds epic A with 3 of 4 tasks closed and epic B with 1 of 4 closed
- **THEN** A shows 75%, B shows 25%, and the milestone shows 50%

#### Scenario: Deferred work

- **WHEN** an epic has 2 closed tasks, 2 open tasks, and 1 deferred task
- **THEN** it shows 50% and names 1 deferred

#### Scenario: Empty epic

- **WHEN** an epic has no child items yet
- **THEN** it shows no percentage and reads as having no items

### Requirement: The roadmap lays milestones and epics on a timeline

The roadmap SHALL show, per project, its milestones ordered by `due_at` (milestones with none last, then by title), each heading a group of its epic rows, followed by a "No milestone" group for epics that belong to none. Each row SHALL sit on one shared, week-scaled time axis with a line at today. An epic's bar SHALL run from its start (its own `started_at`, else the first `started_at` among its items) to its `closed_at`, or to today while it is open; an epic not yet started SHALL show no bar. Its target SHALL be marked at its own `due_at`, else its milestone's. A milestone SHALL be marked at its `due_at`. An open epic or milestone past its target SHALL be marked overdue. Dates SHALL be shown as calendar dates in UTC, so a date-only due date never shifts a day. Each milestone and epic row SHALL show its title, status, and progress; activating one SHALL open its drawer as a board card does.

#### Scenario: Ordering milestones

- **WHEN** a project has milestones due in March and January, and one with no due date
- **THEN** the January one comes first, then March, then the undated one, then "No milestone"

#### Scenario: Overdue epic

- **WHEN** an open epic's milestone was due yesterday
- **THEN** the epic's row and the milestone are marked overdue

#### Scenario: Not started

- **WHEN** an epic and all its items have no `started_at`
- **THEN** its row shows its target marker and progress but no bar

### Requirement: The roadmap is addressed by project

The roadmap SHALL be reachable at `/roadmap?project=<key>&item=<id>`. With no `project` it SHALL show every registered project, each as its own section; with one it SHALL show that project. The chosen project and open item SHALL live in the address so that back, reload, and a shared link reproduce it. The roadmap SHALL offer the same project switcher as the board, and SHALL change no item.

#### Scenario: Shared link

- **WHEN** a reader opens `/roadmap?project=skyos`
- **THEN** the roadmap shows only skyos's milestones and epics

#### Scenario: All projects

- **WHEN** a reader opens `/roadmap` with no project
- **THEN** each registered project with any milestone or epic is shown as its own section
