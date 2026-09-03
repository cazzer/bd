## MODIFIED Requirements

### Requirement: A node's preferred view is offered, never forced

When a node is opened in the graph and it resolves to a default view whose renderer is not `graph`, the graph SHALL offer to open that view, naming the renderer and the view, and SHALL NOT navigate on its own. For a `feed` renderer the offer SHALL open `/feed` for that view. For a `code` renderer the offer SHALL open `/code` for that view with the selected node as the node to show, so that a file reached in the graph is read directly. Resolution SHALL be requested after the graph is drawn and its failure SHALL leave the graph exactly as it would be without the feature.

#### Scenario: A child inherits a feed

- **WHEN** a person selects a work item whose epic declares a feed view as its default
- **THEN** the detail panel offers to open that feed by name, and choosing it opens `/feed` for that view

#### Scenario: A file inherits a code view

- **WHEN** a person selects a `file` whose repository root declares a code view as its default
- **THEN** the detail panel offers to open that code view by name, and choosing it opens `/code` for that view with the file shown

#### Scenario: No default

- **WHEN** a person selects a node that resolves to no default view, or to a view whose renderer is `graph`
- **THEN** nothing is offered

#### Scenario: Resolution fails

- **WHEN** the resolution request fails
- **THEN** the node is shown in the graph as usual and nothing is offered
