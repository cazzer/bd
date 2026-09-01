## ADDED Requirements

### Requirement: Results carry each node's degree

Retrieval SHALL return, for each node in its result, the number of distinct nodes connected to it across the whole store — not merely within the returned subgraph. Degree SHALL be counted over canonical nodes: endpoints resolved through merges, and merge-induced self-connections excluded.

#### Scenario: Degree counts beyond the returned subgraph

- **WHEN** a node has twenty connections but only three of them are within the returned subgraph
- **THEN** its reported degree is twenty

#### Scenario: Degree across a merge

- **WHEN** two nodes are merged, and the merged-away node had connections the survivor did not
- **THEN** the survivor's reported degree includes those connections, counted once each

#### Scenario: A self-connection created by a merge

- **WHEN** two connected nodes are merged into one
- **THEN** the resulting node's degree does not count that connection, and the node is not reported as connected to itself

#### Scenario: An unconnected node

- **WHEN** a node has no edges at all
- **THEN** its reported degree is zero rather than absent

### Requirement: Neighbour fetch is bounded and ordered

Fetching a node's neighbours SHALL accept a maximum count and SHALL return at most that many, ordered by descending edge weight with a deterministic tie-break. The result SHALL indicate whether neighbours were withheld, and SHALL support retrieving the remainder.

#### Scenario: A hub with more neighbours than the limit

- **WHEN** a node with 500 neighbours is fetched with a limit of 25
- **THEN** exactly the 25 highest-weighted neighbours are returned, and the result indicates more exist

#### Scenario: Equal weights order deterministically

- **WHEN** several neighbours share the same edge weight and the limit falls among them
- **THEN** repeated identical requests return the same neighbours in the same order

#### Scenario: Fetching the remainder

- **WHEN** the caller requests the neighbours beyond those already returned
- **THEN** the next set is returned in the same order, with no neighbour repeated or skipped

#### Scenario: Fewer neighbours than the limit

- **WHEN** a node has three neighbours and the limit is 25
- **THEN** all three are returned and the result indicates none were withheld
