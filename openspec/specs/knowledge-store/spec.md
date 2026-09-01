# knowledge-store Specification

## Purpose
Holds everything breakdown knows as typed nodes joined by provenance-carrying edges, with the full-text indexing, batch write, and deduplication behavior that repeated loading from repos, chat, and documents requires.
## Requirements
### Requirement: Typed nodes with stable identity

Every node SHALL have a stable internal identifier, a node type, the source system it came from, an external identifier within that source system, a title, textual content, and a free-form metadata object. Node type SHALL be an open discriminator so that later kinds of node (work items, specs, conversations) can be stored without changing the model.

#### Scenario: Node created from an external source

- **WHEN** a caller writes a node with source system `github` and external id `repo/owner#42`
- **THEN** the node is retrievable by its internal id, and by the pair (source system, external id)

#### Scenario: Unrecognized node type

- **WHEN** a caller writes a node whose type has never been used before
- **THEN** the write succeeds and the type is recorded as given, without schema migration

### Requirement: Content is indexed for full-text search

Node title and content SHALL be indexed for full-text search as a derived value maintained by the store, not by callers. Title matches SHALL rank above body matches for the same query. The index SHALL be updated automatically whenever title or content changes, with no separate reindexing step and no external service.

#### Scenario: Newly written node is immediately searchable

- **WHEN** a node is written and a search is run for a distinctive word in its content
- **THEN** the node is returned, with no intervening indexing job

#### Scenario: Title match outranks body match

- **WHEN** one node has a term in its title and another has the same term only in its body
- **THEN** the title match scores higher

#### Scenario: Content edited

- **WHEN** a node's content is updated to remove a term
- **THEN** a subsequent search for that term no longer returns the node

### Requirement: Edges carry provenance and confidence

Every edge SHALL record its source node, target node, relationship type, a confidence weight between 0 and 1, the source system that produced it, and the ingest run that created it. Edges asserted more than once by the same source system SHALL collapse to a single edge rather than accumulating duplicates.

#### Scenario: Same relationship asserted twice by one source

- **WHEN** a source asserts the edge (A, `mentions`, B) twice
- **THEN** exactly one edge exists for (A, `mentions`, B) from that source system

#### Scenario: Same relationship asserted by two systems

- **WHEN** the edge (A, `mentions`, B) is asserted by both `slack` and `github`
- **THEN** both assertions are retained and distinguishable by source system

#### Scenario: Weight out of range

- **WHEN** a caller writes an edge with weight `1.4`
- **THEN** the write is rejected with an error naming the offending edge

### Requirement: Idempotent batch writes

The write path SHALL accept batches of nodes and edges in a single call and SHALL be idempotent with respect to a deterministic dedup key. Re-running the same load over unchanged input SHALL NOT create duplicate nodes or edges, and SHALL NOT change the created timestamps of existing rows.

#### Scenario: Load re-run over unchanged input

- **WHEN** the same batch of 5,000 nodes is written twice
- **THEN** the store contains 5,000 nodes, and their creation timestamps are unchanged by the second write

#### Scenario: Load re-run over changed content

- **WHEN** a node is written again with different content
- **THEN** the existing node is updated in place and its updated timestamp advances

#### Scenario: Partial failure in a batch

- **WHEN** one node in a batch of 500 violates a constraint
- **THEN** the whole batch is rejected with an error identifying the offending node, and no node from that batch is persisted

### Requirement: Duplicate entities can be merged

The store SHALL support declaring that two nodes refer to the same entity. After a merge, one node SHALL be the survivor, the other SHALL redirect to it, and lookups by the merged node's identifiers SHALL resolve to the survivor. Edges attached to the merged node SHALL be reachable from the survivor without losing their original provenance, and the merged node SHALL NOT be returned as its own result by search.

#### Scenario: Entity mentioned in two systems is merged

- **WHEN** a `slack` person node is merged into a `github` person node
- **THEN** looking up the slack node's (source system, external id) returns the github node, and edges originally attached to the slack node are reachable from it

#### Scenario: Merged node re-written by its original source

- **WHEN** the slack loader writes that person again
- **THEN** the write updates the merged-away node's content and the merge remains in effect

#### Scenario: Search over merged nodes

- **WHEN** a search matches content on a merged-away node
- **THEN** the survivor is returned once, and the merged-away node is not returned separately

### Requirement: Writes are attributable to an ingest run

Every write SHALL be associated with an ingest run recording the source system, start and finish times, and counts of nodes and edges written. A run SHALL be queryable so that everything a given load produced can be identified after the fact.

#### Scenario: Auditing a bad load

- **WHEN** an operator asks which nodes and edges a given ingest run produced
- **THEN** the store returns them, distinguishable from content produced by other runs

### Requirement: People are a distinct authoring source

Content written by a person SHALL be attributed to an ingest run identifying the person as its source system, so that hand-authored nodes and edges remain distinguishable from those written by a loader or by an agent. Person-authored writes SHALL be subject to the same validation, deduplication, and attribution rules as any other write.

#### Scenario: Hand-authored content is separable

- **WHEN** a person creates a note and an agent writes a node in the same period
- **THEN** each is attributable to its own ingest run, and the two sources can be told apart after the fact

#### Scenario: A person's write is validated like any other

- **WHEN** a person submits content that exceeds the size limit or contains control characters
- **THEN** it is rejected with the same error naming the offending input, and nothing is persisted

### Requirement: Notes can annotate an existing node

A note SHALL be creatable either standing alone or as an annotation of an existing node. Annotating SHALL create a separate node joined to the annotated node by an edge, and SHALL NOT modify the annotated node's own content. Annotation SHALL be permitted regardless of the annotated node's source system.

#### Scenario: Annotating a node whose source is a file

- **WHEN** a person annotates a node loaded from a repository file
- **THEN** a separate note node is created, an edge joins it to the annotated node, and the annotated node's content and hash are unchanged

#### Scenario: Re-loading a source after it was annotated

- **WHEN** the loader writes the annotated node again from the unchanged file
- **THEN** the node reports as unchanged and the annotation and its edge survive

#### Scenario: A standalone note

- **WHEN** a person creates a note that annotates nothing
- **THEN** it is persisted and searchable, with no edges

### Requirement: Edges can be asserted, retracted, and reweighted by hand

A person SHALL be able to create an edge between two nodes, remove an edge they created, and change an edge's weight. Retracting SHALL remove only the assertion made by that source system, leaving assertions of the same relationship by other sources intact.

#### Scenario: Retracting a hand-authored edge leaves other sources alone

- **WHEN** the same relationship has been asserted by both a person and a loader, and the person retracts theirs
- **THEN** the loader's assertion remains and the relationship is still present from that source

#### Scenario: Reweighting an edge

- **WHEN** a person changes the weight of an edge they asserted
- **THEN** the new weight is stored, and a weight outside the permitted range is rejected naming the edge

#### Scenario: Asserting an edge that already exists from the same source

- **WHEN** a person asserts a relationship they have already asserted
- **THEN** no duplicate is created and the operation succeeds

