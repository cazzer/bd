## ADDED Requirements

### Requirement: Edge relation is the encoded channel

An edge SHALL be drawn so that its relation type is distinguishable at a glance, without hovering or selecting. Relations that are directional SHALL be drawn with their direction visible. Because relation types are open text, the encoding SHALL degrade gracefully for a type it has no assignment for — an unrecognised relation SHALL still draw, distinguishably from the assigned ones, and introducing a new relation type SHALL NOT require a change to the store or a migration.

#### Scenario: Two relations in one view are distinguishable

- **WHEN** the view contains edges of two different relation types
- **THEN** the two are visually distinct without hovering or selecting either

#### Scenario: A directional relation shows its direction

- **WHEN** the view contains an edge whose relation is directional, such as one node blocking another or being contained by another
- **THEN** which endpoint is the source and which is the target is readable from the drawn edge alone

#### Scenario: An unknown relation still draws

- **WHEN** the view contains an edge whose relation type the encoding has no assignment for
- **THEN** it is drawn in a reserved styling shared by all unassigned relations, distinguishable from every assigned one, and nothing is dropped from the view

### Requirement: Edge provenance stays discoverable

An edge's source system SHALL remain reachable from the explorer without selecting the edge's endpoints, and the composition of the drawn edges by source system SHALL be readable from the interface. A view whose edges all come from one source system SHALL therefore still be apparent as such, even though source system no longer drives how an edge is drawn.

#### Scenario: Reading one edge's provenance

- **WHEN** a person inspects a single drawn edge
- **THEN** its source system and its confidence weight are shown

#### Scenario: A uniformly structural graph is still apparent

- **WHEN** every edge in the view shares one source system
- **THEN** the interface reports that composition, making the absence of other provenance apparent without the person inspecting edges one at a time

### Requirement: A dense selection keeps its structure visible

Selecting or focusing a node SHALL NOT cause the emphasis drawn for it and its neighbourhood to obscure the edges between them. Emphasis SHALL be bounded so that it does not grow with the size of the selected node's neighbourhood, and edges SHALL remain visible above any node emphasis regardless of how many nodes are emphasised.

#### Scenario: Selecting a hub

- **WHEN** a person selects a node whose drawn neighbourhood is large enough that emphasising every neighbour would merge into a continuous wash
- **THEN** the edges joining those nodes remain visible, and the emphasis identifies a bounded set of nodes rather than every neighbour

#### Scenario: Emphasis never hides an edge

- **WHEN** any number of nodes are emphasised
- **THEN** every drawn edge remains visible where it passes beneath them

### Requirement: A node's identity survives a crowded canvas

A node eligible for a label SHALL be labelled even when its immediate surroundings are occupied, by placing the label away from the crowd with its association to the node preserved. A label SHALL be omitted only when no placement can preserve that association, and never merely because the nearest positions are taken.

#### Scenario: Labelling inside a cluster

- **WHEN** a node eligible for a label sits in a cluster where every adjacent label position is already occupied
- **THEN** its label is placed clear of the cluster with its association to the node still readable, rather than dropped

#### Scenario: Labels do not overlap

- **WHEN** labels are displaced to make room
- **THEN** no label overlaps another label or a node

### Requirement: The type legend describes the drawn graph

The explorer's node-type control SHALL report, for each type, how many nodes of that type are currently drawn, and SHALL present that count as the primary figure. Any store-wide figure it also reports SHALL be visibly secondary to it. Choosing a type in the control SHALL narrow what is drawn to that type, not merely restyle it. Where more types exist than the palette can distinguish, the types sharing an undistinguished styling SHALL be presented as an explicit group rather than appearing as distinct entries that happen to look alike.

#### Scenario: The legend counts what is on the canvas

- **WHEN** the canvas holds nodes of four types and the store holds fourteen
- **THEN** the control's primary counts are the four drawn types' on-canvas counts, and no type absent from the canvas is presented as though it were drawn

#### Scenario: Choosing a type narrows the canvas

- **WHEN** a person chooses a type in the control
- **THEN** nodes of other types are removed from view or clearly suppressed, rather than the chosen type merely being tinted among them

#### Scenario: Types beyond the palette are grouped, not disguised

- **WHEN** the drawn types outnumber the distinguishable colours
- **THEN** the types that cannot be given their own colour are shown as one named group, so that no two entries appear distinct while drawing identically

### Requirement: Expansion is reversible

Having expanded a node, a person SHALL be able to undo that expansion, removing the nodes it added that nothing else holds in view. A person SHALL also be able to return the canvas to the result of the current query, discarding every expansion, without re-running the query. Neither SHALL relocate the nodes that remain.

#### Scenario: Collapsing one expansion

- **WHEN** a person collapses a node they previously expanded
- **THEN** the neighbours that expansion added are removed, nodes that are also held by another expansion or by the query result remain, and everything remaining stays where it was

#### Scenario: Returning to the query result

- **WHEN** a person resets the canvas after several expansions
- **THEN** the canvas shows the current query's result alone, without the query being re-run

## MODIFIED Requirements

### Requirement: People can create and connect nodes

The explorer SHALL let a person create a note, either standing alone or as an annotation of an existing node, and SHALL let a person assert, retract, and reweight an edge between two nodes. An edge a person asserts SHALL be attributed to them, and that attribution SHALL be discoverable, but SHALL NOT be carried by how the edge is drawn: a hand-asserted edge and a loaded edge of the same relation are drawn alike, because what an edge MEANS is the thing its appearance is spent on.

#### Scenario: Creating a standalone note

- **WHEN** a person creates a note without connecting it to anything
- **THEN** it is persisted and findable by search, and its lack of connections is discoverable rather than silent

#### Scenario: Connecting two nodes by hand

- **WHEN** a person draws an edge between two nodes and gives it a relationship type
- **THEN** the edge is persisted, attributed to the person, and drawn by that relationship type exactly as a loaded edge of the same type would be

#### Scenario: Finding what a person asserted

- **WHEN** a person wants to know which of the drawn edges they asserted themselves
- **THEN** the interface reports that, both for a single edge on inspection and as a share of the drawn edges

### Requirement: Node size encodes connectedness

A node SHALL be drawn at a size derived from its degree across the whole store, not its degree within the current view, so that a node is the same size wherever it appears. Size SHALL scale with the square root of degree, because perceived circle size tracks area rather than radius. The encoding SHALL remain discriminating across the range of degrees the store actually contains: two nodes whose degrees differ by an order of magnitude SHALL be drawn at visibly different sizes wherever they fall in that range. Where a bound on drawn size is applied so that a hub does not swamp the canvas, degree beyond that bound SHALL be carried by a further visual channel rather than discarded.

#### Scenario: Size is stable across views

- **WHEN** a node appears in the results of two different queries
- **THEN** it is drawn at the same size both times

#### Scenario: A hub does not visually swamp the graph

- **WHEN** one node has ten times the degree of another
- **THEN** its radius is larger by a factor of about three, not ten

#### Scenario: The encoding does not saturate over the store's real range

- **WHEN** a view contains nodes spanning the degrees the store actually holds, from its least connected to its most connected
- **THEN** a ten-fold difference in degree remains visible as a difference in drawn appearance at every point in that range, rather than every node above a low threshold appearing identical

#### Scenario: A hub past the bound is still identifiable

- **WHEN** a node's degree exceeds the bound on drawn size
- **THEN** it remains distinguishable from a node drawn at the bound, by a channel other than size

## REMOVED Requirements

### Requirement: Edge provenance is visible

**Reason**: The requirement spent the edge colour channel on source system, which in the real store is near-constant — every edge of a sample query carried one source system, so every edge drew in the fallback colour while the legend advertised three colours present on no edge. The channel conveyed nothing while the relation type, which is what the typed-edge architecture exists to express, was reachable only by hovering.

**Migration**: The two properties this requirement protected are preserved by its replacements. Per-edge provenance and weight move to inspection, and the "a uniformly structural graph looks uniform" property moves to a reported composition, both under `Edge provenance stays discoverable`. The colour channel it vacated is taken by `Edge relation is the encoded channel`.
