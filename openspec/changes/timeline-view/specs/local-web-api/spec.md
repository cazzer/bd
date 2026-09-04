## MODIFIED Requirements

### Requirement: Read surface serves the explorer's needs

The server SHALL expose search returning a scored subgraph, a bounded neighbour fetch, node retrieval with full content, a store summary, structured listing, batched default-view resolution, a bounded subtree read, and an anchored timeline read. Results SHALL carry the properties the explorer renders: each node's degree across the store and its inclusion provenance, and each edge's type, weight, and source system. Structured listing SHALL accept the same filters, limit, and cursor as the store's listing, SHALL return each node's metadata but never its content, and SHALL be bounded in size with the cursor reflecting what was actually returned. Default-view resolution SHALL accept a batch of node ids and answer for each in one request. The subtree read SHALL accept one root id and return the root's `child_of` descendants without content, bounded by depth and by count, stating whether it was cut short. The timeline read SHALL accept one anchor id with the store's node-type and source-system narrowing, limit, and cursor, and return the anchor's timed neighbours newest first with each one's metadata and relation to the anchor, the count of untimed neighbours, and a cursor reflecting what was actually returned, bounded in size like the listing and never carrying content.

#### Scenario: Search returns renderable results

- **WHEN** the explorer submits a query
- **THEN** the response contains nodes with degree and inclusion provenance, edges with weight and source system, and the effective bounds that were applied

#### Scenario: Neighbour fetch is bounded and ordered

- **WHEN** the explorer requests a node's neighbours with a limit
- **THEN** at most that many are returned, ordered by descending edge weight, and the response indicates whether more exist

#### Scenario: Listing a view's selection

- **WHEN** the feed requests the nodes selected by a view's filter with a limit
- **THEN** at most that many are returned, newest first, each with its metadata and no content, with a cursor that continues after the last node actually returned

#### Scenario: Resolving default views for a page of nodes

- **WHEN** the explorer asks for the default views of the nodes it has drawn
- **THEN** one answer per id comes back naming the view and the declaring node, or that none applies

#### Scenario: Reading a repository's tree

- **WHEN** the code view asks for the subtree of a root
- **THEN** the root and its descendants come back with parent ids, types, titles, external ids, and path and language metadata, no content, shallowest first, and a flag saying whether the node bound cut the answer short

#### Scenario: Reading an anchor's timeline

- **WHEN** the timeline view asks for a repository's timed neighbours narrowed to two node types with a limit
- **THEN** at most that many come back, newest event first, each with its event time, metadata, and the edge type and direction joining it to the repository, no content, the count of untimed neighbours, and a cursor that continues after the last row actually returned

#### Scenario: Timeline of an unknown anchor

- **WHEN** the timeline view asks for the timeline of an id that names no node
- **THEN** the request fails as not found, and a malformed id fails as a bad request without anything being queried
