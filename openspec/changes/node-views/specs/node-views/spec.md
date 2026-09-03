## Purpose

Lets a person or agent define how a set of nodes is shown — a view — as an ordinary node in the store, attach it to a node as that node's default, and have every descendant inherit it; and gives the web app a feed view that draws such a view as a list.

## ADDED Requirements

### Requirement: A view is a node with a validated contract

A node of type `view` SHALL carry, in its metadata, a `renderer` that is one of `graph`, `feed`, or `code`, and a `filter` that is a structural listing selection: node types, source systems, an updated-since instant, and predicates on top-level metadata keys, validated exactly as the store's structured listing validates them. The contract SHALL be enforced at every path that writes a `view` node, before anything is persisted, and SHALL NOT be enforced by the database, so that the set of node types stays open. Keys the contract does not name SHALL pass through unchanged.

#### Scenario: A valid view is persisted

- **WHEN** a writer creates a node of type `view` whose renderer is `feed` and whose filter selects nodes of type `work_item` with status `open`
- **THEN** the node is stored and is returned by structured listing of type `view` with that renderer and filter in its metadata

#### Scenario: Unknown renderer

- **WHEN** a writer creates a `view` whose renderer is `timeline`
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

### Requirement: A default view is declared by an edge

An edge of type `default_view` from a node to a `view` node SHALL mean that the view is the source node's preferred way of being shown. The edge SHALL be asserted through the same paths as any other edge, carrying its own provenance, so that re-importing the source node from its origin system leaves the declaration intact. Nothing SHALL constrain how many `default_view` edges a node carries; when a node carries more than one, the edge with the greater weight SHALL win, and among equal weights the lesser view id. A `default_view` edge whose target is not a canonical `view` node SHALL be ignored by resolution.

#### Scenario: Re-import preserves the declaration

- **WHEN** a person declares a default view on a node that an importer owns, and that importer runs again over the same source
- **THEN** the node's content and metadata reflect the import, and its default view is unchanged

#### Scenario: Two declarations on one node

- **WHEN** a node carries two `default_view` edges with weights 0.5 and 0.9
- **THEN** the view reached by the 0.9 edge is the node's default

#### Scenario: Declaration points at a non-view

- **WHEN** a node's only `default_view` edge targets a node whose type is not `view`
- **THEN** the node resolves to no default view

### Requirement: A node's effective view is inherited along `child_of`

A node's effective default view SHALL be the default view declared on the node itself, or otherwise on its nearest ancestor along `child_of` edges that declares one. Resolution SHALL accept a batch of node ids and answer for every id in a single round trip, reporting for each the view's id and the id of the node whose declaration supplied it, or that none applies. Endpoints that have been merged SHALL be treated as the surviving node, so that a declaration on a merged-away duplicate is honoured through its survivor. Resolution SHALL terminate on a `child_of` cycle and SHALL stop at a documented depth bound. When a node has more than one parent, the nearest declaration SHALL win; among declarations at equal depth, the greater edge weight, then the lesser view id.

#### Scenario: Own declaration wins

- **WHEN** a child declares view A and its parent declares view B
- **THEN** the child resolves to A, supplied by itself

#### Scenario: Nearest ancestor

- **WHEN** a grandchild declares nothing, its parent declares nothing, and its grandparent declares view B
- **THEN** the grandchild resolves to B, supplied by the grandparent

#### Scenario: Nothing declared

- **WHEN** neither a node nor any of its ancestors declares a default view
- **THEN** the node resolves to no default view, and the answer says so rather than failing

#### Scenario: Batch

- **WHEN** a caller resolves twenty ids, some with declarations, some without, some sharing ancestors
- **THEN** one answer per id is returned in one round trip, each independent of the others

#### Scenario: Declaration on a merged-away ancestor

- **WHEN** a node's parent has been merged into another node, and the survivor declares a view
- **THEN** the node resolves to the survivor's view

#### Scenario: Cycle in the hierarchy

- **WHEN** `child_of` edges form a cycle among a node's ancestors and none of them declares a view
- **THEN** resolution terminates and reports no default view

#### Scenario: Two parents at the same depth

- **WHEN** a node has two parents, each declaring a different view through `default_view` edges of equal weight
- **THEN** the node resolves to the view with the lesser id, and the same one on every call

#### Scenario: Depth bound

- **WHEN** the nearest declaration lies beyond the documented depth bound
- **THEN** the node resolves to no default view

### Requirement: The feed view is addressable

The web app SHALL serve a feed view under the path `/feed`, addressed by the id of the view node it renders, so that a feed can be reloaded, bookmarked, and shared. A path that is not `/graph` or `/feed` SHALL still redirect to `/graph` carrying its parameters. `/feed` with no view id, or with an id that names no canonical `view` node, SHALL show an empty state naming the problem with a way to the graph, and SHALL NOT redirect.

#### Scenario: Opening a feed by address

- **WHEN** a person opens `/feed` with a view id
- **THEN** that view's rows are shown, and reloading the page shows the same feed

#### Scenario: Feed with no view

- **WHEN** a person opens `/feed` with no view parameter or with an id that names no view
- **THEN** an empty state says so and offers the graph, and the address is left as it is

#### Scenario: Unknown path still redirects

- **WHEN** a person opens `/list` with parameters
- **THEN** the address is replaced with `/graph` carrying the same parameters

### Requirement: The feed view renders a view's selection as rows

The feed SHALL list the nodes selected by the view's filter, most recently updated first, and SHALL page through them with the store's listing cursor. Each row SHALL show the node's title and type, its work-item status, priority, and assignee when present in its metadata, and every external link found among the node's top-level metadata values. Activating a row SHALL open that node selected in the graph view. The feed SHALL never show a node's content.

#### Scenario: Work items with links

- **WHEN** the view selects open work items and one of them carries a `url` in its metadata
- **THEN** its row shows the title, status, priority, and assignee, and the link opens the URL in a new tab

#### Scenario: A row without work-item fields

- **WHEN** the view selects nodes that are not work items
- **THEN** each row shows title and type, and the absent fields are simply not shown

#### Scenario: Paging

- **WHEN** more nodes match the filter than one page holds
- **THEN** the feed says more exist and a control loads the next page without repeating or skipping a node

#### Scenario: Activating a row

- **WHEN** a person activates a row
- **THEN** the graph view opens with that node selected, and the browser's back control returns to the feed

### Requirement: A node's preferred view is offered, never forced

When a node is opened in the graph and it resolves to a default view whose renderer is not `graph`, the graph SHALL offer to open that view, naming it, and SHALL NOT navigate on its own. Resolution SHALL be requested after the graph is drawn and its failure SHALL leave the graph exactly as it would be without the feature.

#### Scenario: A child inherits a feed

- **WHEN** a person selects a work item whose epic declares a feed view as its default
- **THEN** the detail panel offers to open that feed by name, and choosing it opens `/feed` for that view

#### Scenario: No default

- **WHEN** a person selects a node that resolves to no default view, or to a view whose renderer is `graph`
- **THEN** nothing is offered

#### Scenario: Resolution fails

- **WHEN** the resolution request fails
- **THEN** the node is shown in the graph as usual and nothing is offered
