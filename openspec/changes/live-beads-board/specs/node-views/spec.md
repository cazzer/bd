## MODIFIED Requirements

### Requirement: A view is a node with a validated contract

A node of type `view` SHALL carry, in its metadata, a `renderer` that is one of `graph`, `feed`, `code`, `timeline`, or `board`, and a `filter` that is a structural listing selection: node types, source systems, an updated-since instant, and predicates on top-level metadata keys, validated exactly as the store's structured listing validates them. The contract SHALL be enforced at every path that writes a `view` node, before anything is persisted, and SHALL NOT be enforced by the database, so that the set of node types stays open. Keys the contract does not name SHALL pass through unchanged.

#### Scenario: A valid view is persisted

- **WHEN** a writer creates a node of type `view` whose renderer is `feed` and whose filter selects nodes of type `work_item` with status `open`
- **THEN** the node is stored and is returned by structured listing of type `view` with that renderer and filter in its metadata

#### Scenario: A timeline view is persisted

- **WHEN** a writer creates a node of type `view` whose renderer is `timeline` and whose filter names the node types `gh-issue` and `work_item`
- **THEN** the node is stored with that renderer and filter in its metadata

#### Scenario: A board view is persisted

- **WHEN** a writer creates a node of type `view` whose renderer is `board` and whose filter selects nodes of type `work_item` whose `project` is `tides`
- **THEN** the node is stored with that renderer and filter in its metadata

#### Scenario: Unknown renderer

- **WHEN** a writer creates a `view` whose renderer is `kanban`
- **THEN** the write is rejected naming the node and `renderer`, and nothing from that write is persisted

#### Scenario: Malformed filter

- **WHEN** a writer creates a `view` whose filter carries a predicate with an unknown operation or a non-scalar value
- **THEN** the write is rejected naming the node, `filter`, and the offending predicate, and nothing from that write is persisted

#### Scenario: Missing filter

- **WHEN** a writer creates a `view` with a renderer but no filter
- **THEN** the write is rejected naming `filter`

#### Scenario: Other node types are unaffected

- **WHEN** a writer creates a node of any type other than `view` with a `renderer` key in its metadata
- **THEN** the node is stored as written, and no view validation is applied

### Requirement: A node's preferred view is offered, never forced

When a node is opened in the graph and it resolves to a default view whose renderer is not `graph`, the graph SHALL offer to open that view, naming the renderer and the view, and SHALL NOT navigate on its own. For a `feed` renderer the offer SHALL open `/feed` for that view. For a `code` renderer the offer SHALL open `/code` for that view with the selected node as the node to show, so that a file reached in the graph is read directly. For a `timeline` renderer the offer SHALL open `/timeline` for that view with the selected node as the anchor, so that a repository or an epic reached in the graph shows its history directly. For a `board` renderer the offer SHALL open `/board` for that view. Resolution SHALL be requested after the graph is drawn and its failure SHALL leave the graph exactly as it would be without the feature.

#### Scenario: A child inherits a feed

- **WHEN** a person selects a work item whose epic declares a feed view as its default
- **THEN** the detail panel offers to open that feed by name, and choosing it opens `/feed` for that view

#### Scenario: A file inherits a code view

- **WHEN** a person selects a `file` whose repository root declares a code view as its default
- **THEN** the detail panel offers to open that code view by name, and choosing it opens `/code` for that view with the file shown

#### Scenario: A repository declares a timeline

- **WHEN** a person selects a repository that declares a timeline view as its default
- **THEN** the detail panel offers to open that timeline by name, and choosing it opens `/timeline` for that view anchored on the repository

#### Scenario: An epic declares a board

- **WHEN** a person selects a work item whose epic declares a board view as its default
- **THEN** the detail panel offers to open that board by name, and choosing it opens `/board` for that view

#### Scenario: No default

- **WHEN** a person selects a node that resolves to no default view, or to a view whose renderer is `graph`
- **THEN** nothing is offered

#### Scenario: Resolution fails

- **WHEN** the resolution request fails
- **THEN** the node is shown in the graph as usual and nothing is offered
