## MODIFIED Requirements

### Requirement: The board view is addressed by a view and the reader's chosen projects

The board SHALL be reachable at `/board?view=<id>&project=<key>&item=<bead-id>`. The offered projects SHALL be those the view's filter names, or, when it names none or there is no view, every registered project. The reader SHALL choose what the board shows from one compact project switcher that offers "All projects" and each offered project, one at a time; choosing one SHALL replace the address's `project` with that key, and choosing "All projects" SHALL drop it. With no `project` in the address the board SHALL show every offered project. An address that names several projects SHALL still show those projects, with the switcher stating how many are shown, and choosing from the switcher SHALL replace them. The chosen project SHALL live in the address so that back, reload, and a shared link reproduce it. A card SHALL show the item's id, title, priority, issue type, and project, and SHALL be marked when the item is a review. Activating a card SHALL open the item's drawer on the board and put its id in the address as `item`; closing the drawer SHALL drop `item` from the address. The drawer SHALL show the item's details and offer to open the graph on it. An `item` that is not on the board yet SHALL show the drawer waiting for it, and SHALL open on it when a change brings it in. The board SHALL NOT change any item except by a review decision. With an unknown view, or a view whose renderer is not `board`, the board SHALL show an empty state saying so and SHALL NOT redirect.

#### Scenario: Switching project

- **WHEN** a reader on an all-projects board chooses `skyos` from the switcher
- **THEN** only skyos items show, the address is `/board?project=skyos`, and reloading shows the same board

#### Scenario: Back to all projects

- **WHEN** a reader on `/board?project=skyos` chooses "All projects"
- **THEN** every offered project shows and the address names no project

#### Scenario: Old multi-project link

- **WHEN** a reader opens `/board?project=tides&project=strides`
- **THEN** both projects show and the switcher says 2 projects; choosing `tides` leaves only tides

#### Scenario: Opening an item

- **WHEN** a reader activates a card
- **THEN** the item's drawer opens on the board, the address gains `item=<its id>`, and the drawer offers to open the graph on it

#### Scenario: Closing the drawer

- **WHEN** a reader closes an open drawer
- **THEN** `item` is gone from the address and back reopens it

#### Scenario: Deep link with no view

- **WHEN** the address is `/board?project=tides&item=tides-r1`
- **THEN** the board shows the tides project with the drawer open on `tides-r1`

#### Scenario: Item not loaded yet

- **WHEN** the address names an item the store has not loaded yet, and its tracker is then loaded
- **THEN** the drawer says it is waiting for the item, then opens on it without a reload

#### Scenario: Wrong renderer

- **WHEN** the address names a view whose renderer is `feed`
- **THEN** the board shows an empty state naming the problem and stays at `/board`

## ADDED Requirements

### Requirement: Milestones are not cards

A work item of issue type `milestone` SHALL NOT appear as a card in any column. An epic's lane header SHALL name the epic's milestone, when it has one. An item placed directly under a milestone with no epic between SHALL appear in the "No epic" lane.

#### Scenario: Milestone on the board

- **WHEN** a project holds a milestone with two epics
- **THEN** the board shows no milestone card, and both epics' lane headers name the milestone

### Requirement: Board and Roadmap are sibling views

The board and the roadmap SHALL each offer a two-way Board / Roadmap toggle. Switching SHALL carry the chosen project (or all projects) across and drop any open item.

#### Scenario: Board to roadmap

- **WHEN** a reader on `/board?project=tides&item=tides-r1` switches to Roadmap
- **THEN** the address becomes `/roadmap?project=tides`
