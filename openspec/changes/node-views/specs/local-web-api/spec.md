## MODIFIED Requirements

### Requirement: Read surface serves the explorer's needs

The server SHALL expose search returning a scored subgraph, a bounded neighbour fetch, node retrieval with full content, a store summary, structured listing, and batched default-view resolution. Results SHALL carry the properties the explorer renders: each node's degree across the store and its inclusion provenance, and each edge's type, weight, and source system. Structured listing SHALL accept the same filters, limit, and cursor as the store's listing, SHALL return each node's metadata but never its content, and SHALL be bounded in size with the cursor reflecting what was actually returned. Default-view resolution SHALL accept a batch of node ids and answer for each in one request.

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
