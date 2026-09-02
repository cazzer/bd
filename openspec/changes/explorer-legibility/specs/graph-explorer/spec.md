## MODIFIED Requirements

### Requirement: Node size encodes connectedness

A node SHALL be drawn at a size derived from its degree across the whole store, not its degree within the current view, so that a node is the same size wherever it appears. Size SHALL scale with the square root of degree, because perceived circle size tracks area rather than radius. Size SHALL be capped at a maximum radius so that no single node can visually dominate a view regardless of how large its degree grows; a node's actual, uncapped degree SHALL remain visible in its detail panel.

#### Scenario: Size is stable across views

- **WHEN** a node appears in the results of two different queries
- **THEN** it is drawn at the same size both times

#### Scenario: A hub does not visually swamp the graph

- **WHEN** one node has ten times the degree of another
- **THEN** its radius is larger by a factor of about three, not ten

#### Scenario: A hub above the cap is drawn at the cap radius

- **WHEN** a node's degree is high enough that `sqrt(degree)` scaling would exceed the maximum radius
- **THEN** the node is drawn at the maximum radius, and its actual degree is shown in the detail panel

## ADDED Requirements

### Requirement: Labels follow relevance

A node's label SHALL be drawn when the node is a seed of the current query, the selected node, a direct neighbour of the selected node, or hovered. All other labels SHALL be withheld unless the view is zoomed in past a threshold. A drawn label SHALL be truncated when the node's title exceeds 40 characters, with the full title available on hover and in the detail panel.

#### Scenario: Relevant nodes stay labelled at any zoom

- **WHEN** a node is a seed of the current query, the selected node, or a direct neighbour of the selected node
- **THEN** its label is drawn regardless of the current zoom level

#### Scenario: Ambient nodes are unlabelled below the zoom threshold

- **WHEN** a node is none of seed, selected, neighbour of the selection, or hovered, and the view is not zoomed in past the threshold
- **THEN** its label is not drawn

#### Scenario: Zooming in reveals ambient labels

- **WHEN** a person zooms in past the threshold
- **THEN** previously-unlabelled ambient nodes in view gain labels

#### Scenario: A long title is truncated with the full title still reachable

- **WHEN** a node whose title exceeds 40 characters has its label drawn
- **THEN** the drawn label is truncated to 40 characters with an ellipsis, and the full title is available by hovering the node or opening its detail panel

### Requirement: Type colour is assigned by prevalence

Node type colour SHALL be assigned by ranking node types by store-wide count, most prevalent first, and mapping that rank onto the categorical palette in order. A type whose rank exceeds the palette's length SHALL receive the fallback colour. Every surface that displays a type's colour SHALL use the same assignment.

#### Scenario: The two most common types are visually distinct

- **WHEN** the store contains at least two node types
- **THEN** the two most common types by store-wide count are drawn in two distinct palette colours

#### Scenario: The type control, chips, and canvas agree

- **WHEN** a node type is shown in the type control, as a search chip, and on a canvas node of that type
- **THEN** all three show the same colour for that type

#### Scenario: A newly-observed type still gets a distinguishable colour

- **WHEN** the store contains a node type not previously seen by the explorer
- **THEN** the type is assigned a colour by its rank among current store-wide counts, without requiring a code change

### Requirement: The view fits the free area

After a search settles, the graph view SHALL be fit and centred within the area of the viewport not occupied by floating panels, so that a drawn seed node does not sit hidden beneath a panel. Expanding a node's neighbours SHALL NOT re-fit or re-centre the view — new nodes enter near their parent, and the person can pan to them.

#### Scenario: A fitted result is not hidden behind the detail panel

- **WHEN** a search result is fit to view while the detail panel is open
- **THEN** the fitted graph is centred within the region to the left of the open panels, and no seed node is obscured by a panel

#### Scenario: Opening or closing a panel, or expanding a node, does not re-fit the view

- **WHEN** a person opens or closes a panel, or expands a node's neighbours, without running a new search
- **THEN** the already-drawn graph's position and the canvas's own size are unchanged

### Requirement: The detail panel opens as a summary

Selecting a node SHALL open its detail panel in a summary state showing the node's title, its type/source/degree, and the first paragraph of its content. An explicit control SHALL expand the panel to its full content, editing, annotation, and edge controls; collapsing SHALL return it to the summary. Editing SHALL only be reachable from the expanded state.

#### Scenario: Selecting a node shows a summary first

- **WHEN** a person selects a node
- **THEN** the detail panel opens showing the title, its type/source/degree, and the first paragraph of its content, without the full editor or edge controls

#### Scenario: Expanding reveals the full panel

- **WHEN** a person chooses to show more on a summary panel
- **THEN** the panel expands to show the full content, editing, annotation, and edge controls

#### Scenario: Collapsing returns to the summary

- **WHEN** a person collapses an expanded panel
- **THEN** the panel returns to the summary state without discarding unsaved navigation state (the same node stays selected)
