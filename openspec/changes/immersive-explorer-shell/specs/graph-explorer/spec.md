## MODIFIED Requirements

### Requirement: Search is the entry point

The explorer SHALL open with no graph drawn. Submitting query text SHALL render the matching seed nodes together with their immediate neighbourhood. The explorer SHALL NOT offer a view that renders the entire store at once. Typed search text SHALL also match node type names; a matched type SHALL be offered as a suggestion, and choosing it SHALL apply as a filter on the query rather than as ordinary search text.

#### Scenario: First query draws a bounded neighbourhood

- **WHEN** a person submits a query that matches nodes in the store
- **THEN** the seed nodes and their immediate neighbours are drawn, and nodes outside that neighbourhood are absent

#### Scenario: Query matches nothing

- **WHEN** a query returns no seeds from either exact or approximate matching
- **THEN** the explorer states that nothing matched and that both modes were tried, and the canvas stays as it was rather than clearing

#### Scenario: Choosing a type suggestion filters the query

- **WHEN** a person chooses a suggested node type and submits search text
- **THEN** the results returned are only seeds whose node type matches the chosen type

### Requirement: Edge provenance is visible

An edge SHALL be drawn so that its source system is distinguishable at a glance and its confidence weight is reflected in its thickness. A store whose edges all come from one source SHALL therefore be visually obvious as such. This encoding SHALL remain legible under the explorer's dark presentation.

#### Scenario: Edges from different sources are distinguishable

- **WHEN** the view contains edges written by a repository loader and edges written by a person
- **THEN** the two are visually distinct without selecting or hovering either

#### Scenario: A uniformly structural graph looks uniform

- **WHEN** every edge in the view shares one source system and one weight
- **THEN** the drawn edges are uniform, making the absence of other provenance apparent

## ADDED Requirements

### Requirement: The map is the page

The graph canvas SHALL fill the viewport. Every other control SHALL be drawn as a floating layer over the canvas and SHALL NOT reduce the area available to the drawn graph.

#### Scenario: Opening detail does not resize the canvas

- **WHEN** a person selects a node and its detail panel opens
- **THEN** the canvas's measured size is unchanged, and no drawn node moves as a result of the panel opening

#### Scenario: Every control floats over the canvas

- **WHEN** the explorer is rendered with the search bar, the type control, and an open detail panel all visible at once
- **THEN** all three are drawn as layers over the canvas rather than as siblings that share space with it

### Requirement: The type control reflects the selection

The explorer SHALL show a ranked list of node types with a visible count for each. With no node selected, the list SHALL default to the types most prevalent store-wide. With a node selected, the list SHALL instead rank the node types of that node's neighbours on the currently drawn graph, by how many neighbours carry each type. Choosing a type from the list SHALL visually distinguish nodes of that type from all others on the canvas without altering any node's size or position.

#### Scenario: Default view shows top types store-wide

- **WHEN** no node is selected
- **THEN** the type control shows the node types with the highest store-wide counts

#### Scenario: Selecting a node re-ranks by neighbour prevalence

- **WHEN** a person selects a node
- **THEN** the type control ranks types by how many of that node's on-screen neighbours carry each one, and identifies the selected node

#### Scenario: Focusing a type dims the rest without moving anything

- **WHEN** a person chooses a type from the type control
- **THEN** nodes of that type render at full strength, all other nodes dim, and no node's size or position changes

### Requirement: Presentation is dark-first

The explorer SHALL render on a dark ground by default. Every node type's colour SHALL remain mutually distinguishable from every other, and node and panel labels SHALL remain legible, under this presentation.

#### Scenario: The explorer opens dark

- **WHEN** a person opens the explorer without any prior preference set
- **THEN** the canvas and every floating panel render on a dark ground, and node-type colours and labels remain legible against it
