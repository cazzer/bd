## Purpose

A live board of work across every project tracked in beads: which items are ready, blocked, in progress, deferred, or recently closed, grouped by the epic they belong to and filtered by project, kept current as the trackers change without a reload.

## ADDED Requirements

### Requirement: A beads checkout is registered by loading it under a project key

Loading a beads checkout with a project key SHALL write every one of its issues as a work item carrying that `project`, and SHALL record the checkout as a registered project: a node naming the key and the checkout's absolute path. A project key SHALL name at most one checkout; loading a second path under a key already registered to another path SHALL be refused naming both paths. Loading SHALL be refused, with nothing persisted, when any issue in the export already exists in the store under a different `project`, naming the issue and both projects, so that two trackers that share an id prefix can never overwrite each other's items. Re-loading a registered checkout SHALL be idempotent: items whose content did not change SHALL be reported unchanged.

#### Scenario: First registration

- **WHEN** the checkout at `/Users/caleb/dev/tides` is loaded under project `tides`
- **THEN** every tides issue is stored as a work item with `project` `tides`, and the registered projects include `tides` at that path

#### Scenario: Re-loading changes nothing

- **WHEN** the same checkout is loaded again with no tracker changes
- **THEN** every item is reported unchanged

#### Scenario: Colliding ids across projects

- **WHEN** a checkout is loaded under project `other` and its export contains an issue id already stored with `project` `tides`
- **THEN** the load is refused naming that id, `tides`, and `other`, and nothing from the load is persisted

#### Scenario: Key reused for another path

- **WHEN** a checkout at a different path is loaded under the key `tides`
- **THEN** the load is refused naming both paths

### Requirement: Every item lands in exactly one column

The board SHALL place each work item of the selected projects in exactly one column:

- **Closed** — status `closed`. Only the most recently closed items of each project, at most 25, SHALL be shown; the board SHALL state how many closed items it omitted.
- **Deferred** — status `deferred`.
- **In progress** — status `in_progress`; an in-progress item with an open blocker SHALL stay in this column and be marked blocked.
- **Blocked** — status `blocked`, or status `open` with at least one open blocker or membership in a blocking cycle.
- **Ready** — status `open` with no open blocker and no cycle membership.

A blocker SHALL count as open whenever it is not closed, whichever project it belongs to. Within a column, items SHALL be ordered by priority, most urgent first, then most recently updated first.

#### Scenario: Open item with an open blocker

- **WHEN** an open item is blocked by an item that is in progress
- **THEN** it appears in Blocked, naming its blocker

#### Scenario: Blocker closes

- **WHEN** an item's only blocker is closed
- **THEN** the item appears in Ready

#### Scenario: Status blocked without a blocking edge

- **WHEN** an item's status is `blocked` and nothing blocks it
- **THEN** it appears in Blocked

#### Scenario: Many closed items

- **WHEN** a project has 170 closed items
- **THEN** the 25 most recently closed appear in Closed, and the board states that 145 were omitted

### Requirement: Items are grouped by their nearest epic

The board SHALL group items into lanes, one per epic: an item's lane SHALL be its nearest ancestor along parent relationships that is a work item of issue type `epic`. Items with no epic ancestor SHALL share a lane named "No epic". An epic SHALL head its lane, showing its title and status, and SHALL NOT also appear as a card. A parent cycle SHALL NOT prevent the board from answering. Lanes whose epics are closed and whose items are all closed SHALL be collapsed by default.

#### Scenario: Grandchild of an epic

- **WHEN** a task's parent is a feature whose parent is an epic
- **THEN** the task appears in that epic's lane

#### Scenario: Nested epics

- **WHEN** an item's parent is an epic that is itself the child of another epic
- **THEN** the item appears in the nearer epic's lane

#### Scenario: Parent cycle

- **WHEN** two items name each other as parent
- **THEN** the board still answers, and each appears in the lane of the nearest epic reachable before the cycle repeats, or in "No epic"

### Requirement: The board view is addressed by a view and the reader's chosen projects

The board SHALL be reachable at `/board?view=<id>&project=<key>&project=<key>`. The view's filter SHALL name the projects offered as chips, or, when it names no project, every registered project SHALL be offered; all offered projects SHALL be selected until the reader deselects one, and the chosen set SHALL live in the address so that back, reload, and a shared link reproduce it. A card SHALL show the item's id, title, priority, issue type, and project, and activating it SHALL open the graph on that item with its detail panel. The board SHALL NOT change any item. With no view, an unknown view, or a view whose renderer is not `board`, the board SHALL show an empty state saying so and SHALL NOT redirect.

#### Scenario: Deselecting a project

- **WHEN** a reader deselects `skyos` on an all-projects board
- **THEN** skyos items disappear, the address names the remaining projects, and reloading shows the same board

#### Scenario: Opening an item

- **WHEN** a reader activates a card
- **THEN** the graph opens on that item with its detail panel showing

#### Scenario: Wrong renderer

- **WHEN** the address names a view whose renderer is `feed`
- **THEN** the board shows an empty state naming the problem and stays at `/board`

### Requirement: The board updates live as trackers change

While the board is open, a change written to any registered project's tracker on this machine — an issue created, updated, closed, or reparented, by a person or an agent, or arriving from a tracker pull — SHALL appear on the board without a reload, within two seconds of the write in ordinary conditions. Reading a tracker SHALL NOT cause a re-load. Re-loads of one project SHALL NOT overlap; a change that arrives during a re-load SHALL cause exactly one further re-load after it. A failed re-load of one project SHALL leave that project's items as last loaded, SHALL be visible on the board as that project's error, and SHALL NOT stop other projects from updating. A reader SHALL also be able to request a refresh of every project by hand.

#### Scenario: Agent closes an issue

- **WHEN** an agent closes an item in a registered project while the board is open
- **THEN** within two seconds the card moves to Closed without a reload

#### Scenario: Reads do not re-load

- **WHEN** a person lists and shows issues in a registered project's tracker without changing anything
- **THEN** no re-load of that project occurs

#### Scenario: Burst of writes

- **WHEN** ten issues in one project are updated within one second
- **THEN** the board reflects all ten, and that project is re-loaded no more than twice

#### Scenario: One project's tracker is broken

- **WHEN** one registered project's tracker cannot be read
- **THEN** the board names that project's error, keeps showing its last loaded items, and other projects keep updating
