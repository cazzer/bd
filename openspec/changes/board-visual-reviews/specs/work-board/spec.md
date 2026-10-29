## MODIFIED Requirements

### Requirement: The board view is addressed by a view and the reader's chosen projects

The board SHALL be reachable at `/board?view=<id>&project=<key>&project=<key>&item=<bead-id>`. The view's filter SHALL name the projects offered as chips, or, when it names no project, every registered project SHALL be offered; with no view at all, the board SHALL offer every registered project as an all-projects board does. All offered projects SHALL be selected until the reader deselects one, and the chosen set SHALL live in the address so that back, reload, and a shared link reproduce it. A card SHALL show the item's id, title, priority, issue type, and project, and SHALL be marked when the item is a review. Activating a card SHALL open the item's drawer on the board and put its id in the address as `item`; closing the drawer SHALL drop `item` from the address. The drawer SHALL show the item's details and offer to open the graph on it. An `item` that is not on the board yet SHALL show the drawer waiting for it, and SHALL open on it when a change brings it in. The board SHALL NOT change any item except by a review decision. With an unknown view, or a view whose renderer is not `board`, the board SHALL show an empty state saying so and SHALL NOT redirect.

#### Scenario: Deselecting a project

- **WHEN** a reader deselects `skyos` on an all-projects board
- **THEN** skyos items disappear, the address names the remaining projects, and reloading shows the same board

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
