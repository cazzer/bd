# graph-explorer Specification

## Purpose
Makes the knowledge store observable and correctable by a person: a search finds entry points, a force-directed graph grows outward on demand, and what the graph looks like reveals what the store actually holds — including whether its edges carry meaning or only structure.
## Requirements
### Requirement: Search is the entry point

The explorer SHALL open with no graph drawn. Submitting query text SHALL render the matching seed nodes together with their immediate neighbourhood. The explorer SHALL NOT offer a view that renders the entire store at once.

#### Scenario: First query draws a bounded neighbourhood

- **WHEN** a person submits a query that matches nodes in the store
- **THEN** the seed nodes and their immediate neighbours are drawn, and nodes outside that neighbourhood are absent

#### Scenario: Query matches nothing

- **WHEN** a query returns no seeds from either exact or approximate matching
- **THEN** the explorer states that nothing matched and that both modes were tried, and the canvas stays as it was rather than clearing

### Requirement: Expansion preserves the existing layout

Expanding a node SHALL add its neighbours to the current view without relocating nodes that are already placed. New nodes SHALL enter near the node they were expanded from. The person's spatial memory of the graph is the thing being protected.

#### Scenario: Expanding a node leaves placed nodes where they are

- **WHEN** a person expands a node and new neighbours are added
- **THEN** every node already on screen remains within a small tolerance of its previous position, and only the newly added nodes move to settle

#### Scenario: New nodes enter near their parent

- **WHEN** neighbours are added by expansion
- **THEN** they first appear adjacent to the expanded node rather than at the origin or a random position

#### Scenario: Expanding a node already on screen

- **WHEN** a person expands a node whose neighbour is already drawn
- **THEN** that neighbour is not duplicated, and the connecting edge is drawn

### Requirement: Node size encodes connectedness

A node SHALL be drawn at a size derived from its degree across the whole store, not its degree within the current view, so that a node is the same size wherever it appears. Size SHALL scale with the square root of degree, because perceived circle size tracks area rather than radius.

#### Scenario: Size is stable across views

- **WHEN** a node appears in the results of two different queries
- **THEN** it is drawn at the same size both times

#### Scenario: A hub does not visually swamp the graph

- **WHEN** one node has ten times the degree of another
- **THEN** its radius is larger by a factor of about three, not ten

### Requirement: Query relevance is transient, never geometry

Relevance is a property of a query, not of a node — nodes reached by expansion have no relevance at all. Relevance SHALL be shown as a transient visual state on the seed nodes and SHALL NOT alter node size or position. Running a new query SHALL clear the previous query's relevance state.

#### Scenario: A new query clears the old highlight

- **WHEN** a person runs a second query
- **THEN** nodes highlighted as seeds of the first query are no longer highlighted, and no node changed size as a result

#### Scenario: An expanded node carries no relevance

- **WHEN** a node enters the view by expansion rather than by matching
- **THEN** it is drawn without relevance highlighting and at its normal size

### Requirement: Edge provenance is visible

An edge SHALL be drawn so that its source system is distinguishable at a glance and its confidence weight is reflected in its thickness. A store whose edges all come from one source SHALL therefore be visually obvious as such.

#### Scenario: Edges from different sources are distinguishable

- **WHEN** the view contains edges written by a repository loader and edges written by a person
- **THEN** the two are visually distinct without selecting or hovering either

#### Scenario: A uniformly structural graph looks uniform

- **WHEN** every edge in the view shares one source system and one weight
- **THEN** the drawn edges are uniform, making the absence of other provenance apparent

### Requirement: Hub expansion is bounded

Expanding a node SHALL add at most a bounded number of neighbours, chosen by descending edge weight. When neighbours were withheld, the explorer SHALL say so and SHALL offer a way to draw more.

#### Scenario: Expanding a node with many neighbours

- **WHEN** a person expands a node with 500 neighbours and the bound is 25
- **THEN** the 25 highest-weighted neighbours are drawn, and the explorer indicates that more exist

#### Scenario: Drawing the withheld remainder

- **WHEN** the person asks for more neighbours of that node
- **THEN** the next tranche is added without relocating anything already placed

### Requirement: Repo-sourced nodes are read-only but annotatable

A node whose content originates from a file on disk SHALL NOT be editable in the explorer, and SHALL be shown as originating elsewhere. Any node SHALL be annotatable: annotating creates a separate note authored by the person and links it to the annotated node.

#### Scenario: Opening a repo-sourced node

- **WHEN** a person opens a node loaded from a repository file
- **THEN** its content is displayed without an editing affordance, and its file origin is shown

#### Scenario: Annotating a read-only node

- **WHEN** a person annotates a repo-sourced node and saves
- **THEN** a new note node is created, an edge links it to the annotated node, and the annotated node's own content is unchanged

#### Scenario: Editing an editable node

- **WHEN** a person edits a note or agent-authored node and saves
- **THEN** the content is persisted and the node's search index reflects the new text

### Requirement: People can create and connect nodes

The explorer SHALL let a person create a note, either standing alone or as an annotation of an existing node, and SHALL let a person assert, retract, and reweight an edge between two nodes.

#### Scenario: Creating a standalone note

- **WHEN** a person creates a note without connecting it to anything
- **THEN** it is persisted and findable by search, and its lack of connections is discoverable rather than silent

#### Scenario: Connecting two nodes by hand

- **WHEN** a person draws an edge between two nodes and gives it a relationship type
- **THEN** the edge is persisted, attributed to the person, and drawn with the provenance styling for hand-authored edges

