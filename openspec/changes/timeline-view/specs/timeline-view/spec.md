## Purpose

Gives the web app a timeline view: for one anchor node, the items connected to it in the order they happened in their source systems, narrowed to the node types the reader chooses, so a repository's or an epic's history reads top to bottom.

## ADDED Requirements

### Requirement: The timeline view is addressable

The web app SHALL serve a timeline view under the path `/timeline`, addressed by the id of the `view` node it renders, the id of the anchor node whose neighbours it lists, and zero or more chosen node types, so that a timeline can be reloaded, bookmarked, and shared with its selection intact. `/timeline` with no view id, or with an id that names no canonical `view` node, SHALL show an empty state naming the problem with a way to the graph. `/timeline` with a view but no anchor SHALL show an empty state saying to choose a node in the graph. An anchor that names no canonical node SHALL show an empty state saying so. None of these SHALL redirect or change the address.

#### Scenario: Opening a timeline by address

- **WHEN** a person opens `/timeline` with a view id, an anchor id, and two chosen types
- **THEN** that anchor's timed neighbours of those two types are listed, and reloading the page shows the same list with the same two types chosen

#### Scenario: Timeline with no view

- **WHEN** a person opens `/timeline` with no view parameter or with an id that names no view
- **THEN** an empty state says so and offers the graph, and the address is left as it is

#### Scenario: Timeline with no anchor

- **WHEN** a person opens `/timeline` with a view id and no anchor
- **THEN** an empty state says to choose a node in the graph, names the view, and the address is left as it is

#### Scenario: Anchor names nothing

- **WHEN** a person opens `/timeline` with a view id and an anchor id that names no canonical node
- **THEN** an empty state says the node was not found and offers the graph, and the address is left as it is

### Requirement: The type chips come from the view and live in the address

When the view's filter names node types, the timeline SHALL offer one chip per named type, every chip selected when the address names no type, and SHALL list only the chosen types. Toggling a chip SHALL rewrite the address in place, not add a history entry, so that back from the timeline returns to where the person came from and forward-and-back to the graph reproduces the selection. A chosen type the view does not name SHALL be ignored. When every chip is deselected the timeline SHALL list nothing and say that no type is chosen. When the view's filter names no node types, no chips SHALL be offered and every timed neighbour SHALL be listed.

#### Scenario: All types by default

- **WHEN** a person opens a timeline whose view names `gh-issue` and `work_item` and the address names no type
- **THEN** both chips are selected and neighbours of both types are listed

#### Scenario: Deselecting a type

- **WHEN** the person deselects `work_item`
- **THEN** only `gh-issue` neighbours remain, the address now names `gh-issue` alone, and the browser's back control leaves the timeline rather than restoring the chip

#### Scenario: Selection survives a round trip through the graph

- **WHEN** the person activates a row, then presses back
- **THEN** the timeline shows with `gh-issue` alone still chosen

#### Scenario: Nothing chosen

- **WHEN** the person deselects every chip
- **THEN** no rows are listed and the view says no type is chosen

#### Scenario: A view that names no types

- **WHEN** a person opens a timeline whose view's filter names no node types
- **THEN** no chips are offered and every timed neighbour of the anchor is listed

### Requirement: The timeline lists an anchor's timed neighbours newest first

The timeline SHALL list the anchor's neighbours that carry an event time, newest first, narrowed to the chosen types and to the view's source systems, and SHALL page through them with the store's timeline cursor without repeating or skipping a row. Each row SHALL show the item's event time, title, type, source system, and how it relates to the anchor, and every external link found among the item's top-level metadata values. The timeline SHALL state how many neighbours matching the selection carry no event time, so that an incomplete picture is named rather than silent. Activating a row SHALL open that node selected in the graph view. The timeline SHALL never show a node's content.

#### Scenario: A repository's history

- **WHEN** the anchor is a repository with issues opened in March and in June, and one file with no event time
- **THEN** the June issue is listed above the March one, each with its time, title, type, source, and relation to the repository, the issue rows carry their GitHub links, and the view says one neighbour has no time

#### Scenario: Paging

- **WHEN** more timed neighbours match than one page holds
- **THEN** the timeline says more exist and a control loads the next page without repeating or skipping a row

#### Scenario: Nothing timed

- **WHEN** every neighbour matching the selection lacks an event time
- **THEN** no rows are listed and the view says how many neighbours have no time

#### Scenario: Activating a row

- **WHEN** a person activates a row
- **THEN** the graph view opens with that node selected, and the browser's back control returns to the timeline
