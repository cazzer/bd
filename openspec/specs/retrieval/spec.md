# retrieval Specification

## Purpose
Turns query text into a bounded, scored subgraph — full-text search picks the entry points and graph traversal supplies the surrounding context, so callers get relevance plus its neighborhood instead of a flat list of documents, without any model call in the read path.
## Requirements
### Requirement: Text search selects seeds

Given query text, retrieval SHALL rank nodes by full-text relevance and return the highest-scoring ones as seeds. The query syntax SHALL support quoted phrases, alternation, and term exclusion. Callers SHALL be able to set the number of seeds and a minimum relevance score. Each seed SHALL carry its relevance score, and — for an exact match — a highlighted snippet showing the matched text in context. A fuzzy seed MAY omit the snippet, since approximate matching produces no parsed query to highlight against.

The minimum relevance score SHALL default to a small positive value rather than zero, because a query consisting only of exclusions matches every document lacking the excluded term at rank zero.

#### Scenario: Query with clear matches

- **WHEN** a caller searches for `"batch upsert"` with a seed limit of 5
- **THEN** at most 5 seed nodes are returned, ordered by descending relevance, each with its score and a snippet highlighting the match

#### Scenario: Phrase and exclusion syntax

- **WHEN** a caller searches for `postgres -supabase`
- **THEN** nodes matching `postgres` are returned and nodes containing `supabase` are excluded

#### Scenario: Query below the relevance floor

- **WHEN** every candidate scores below the caller's minimum relevance
- **THEN** an empty seed set is returned without error

### Requirement: Fuzzy fallback when exact search finds nothing

When full-text search returns no seeds, retrieval SHALL retry using approximate string matching against node titles and content, and SHALL mark the results as fuzzy so the caller can tell the difference.

#### Scenario: Misspelled query

- **WHEN** a caller searches for `postgress` and full-text search returns nothing
- **THEN** nodes about `postgres` are returned, flagged as fuzzy matches, and expanded into a subgraph the same way exact seeds are

#### Scenario: Fuzzy fallback also finds nothing

- **WHEN** neither exact nor approximate matching finds a node above the floor
- **THEN** an empty result is returned, stating that both modes were tried

### Requirement: Bounded subgraph expansion

Retrieval SHALL expand outward from the seeds along edges up to a caller-specified maximum depth and total node budget. Traversal SHALL follow edges in both directions, SHALL NOT revisit a node, SHALL attenuate a node's score with each hop and by the weight of the edge traversed, and SHALL stop when either bound is reached. Results SHALL be deterministic for identical inputs.

#### Scenario: Depth bound reached

- **WHEN** a caller requests depth 2 from a seed whose neighborhood is 4 hops deep
- **THEN** only nodes within 2 hops of a seed are returned

#### Scenario: Node budget reached

- **WHEN** the neighborhood contains 500 nodes and the caller sets a budget of 40
- **THEN** exactly 40 nodes are returned, retaining the highest-scoring ones

#### Scenario: Cycle in the graph

- **WHEN** the traversal reaches a node it has already visited
- **THEN** the node appears once in the result and traversal does not loop

#### Scenario: Hub node with many neighbors

- **WHEN** an expanded node has 10,000 neighbors and the per-hop fanout cap is 25
- **THEN** at most 25 of its neighbors enter the frontier, chosen by descending edge weight

#### Scenario: Repeated identical query

- **WHEN** the same query is run twice against unchanged data
- **THEN** the two results are identical, including ordering

### Requirement: Single round-trip execution

Seed selection and expansion SHALL be executed as one database query, returning seed nodes, expanded nodes, and the edges connecting them together. The read path SHALL NOT call any external service.

#### Scenario: Retrieval issues one query

- **WHEN** a retrieval call completes
- **THEN** one query was issued to the database, and its result contains the nodes and the connecting edges

### Requirement: Filtering by type, source, and recency

Callers SHALL be able to restrict retrieval by node type, source system, and a minimum updated-at timestamp. Filters SHALL apply to both seed selection and expansion.

#### Scenario: Restricting to one source system

- **WHEN** a caller filters to source system `github`
- **THEN** no node from another source system appears among seeds or expanded nodes

#### Scenario: Filtered-out node blocks the path behind it

- **WHEN** a node matching the filter is reachable only by traversing through a node that does not match
- **THEN** it is absent from the result, because a filtered-out node is excluded from the graph rather than hidden from the output

#### Scenario: Query matching only excluded terms

- **WHEN** a caller searches for `-supabase` with no positive term
- **THEN** an empty seed set is returned, rather than an arbitrary slice of every document lacking the term

### Requirement: Results explain why each node was included

Every returned node SHALL carry its final score and its provenance within the result: either that it was a seed with a given relevance, or the path of edges by which it was reached from a seed.

#### Scenario: Node reached by traversal

- **WHEN** a node is returned that was not a seed
- **THEN** the result identifies the seed it was reached from and the edge types traversed to reach it

### Requirement: The store's vocabulary is discoverable

Retrieval SHALL expose a summary of what the store contains: the node types, source systems, and edge types in use with their counts, and the most recently updated nodes. Callers SHALL be able to navigate the graph deliberately rather than relying on search alone.

#### Scenario: Caller orients before searching

- **WHEN** a caller requests the store summary
- **THEN** it receives the node types, source systems, and edge types in use, each with a count, and a list of recently updated nodes

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

