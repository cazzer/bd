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

Every write SHALL be associated with an ingest run recording the source system, an optional actor identifying who or what drove the run, start and finish times, and counts of nodes and edges written. The source system is the provenance of the content; the actor is the identity at the keyboard or the connected client — a person, an agent client, or a loader script — and the two SHALL be recorded separately. Merging one node into another SHALL be a write in this sense: it SHALL require an ingest run and SHALL mark the nodes it changes as last written by that run. A run SHALL be queryable so that everything a given load produced can be identified after the fact.

#### Scenario: Auditing a bad load

- **WHEN** an operator asks which nodes and edges a given ingest run produced
- **THEN** the store returns them, distinguishable from content produced by other runs

#### Scenario: Two agents writing under one source system

- **WHEN** two different agent clients each open a run with source system `agent` and different actors
- **THEN** each run records its own actor, and a node written by one is attributable to that actor and not the other

#### Scenario: A run opened without an actor

- **WHEN** a caller opens a run naming only a source system
- **THEN** the run is created with no actor recorded, and every existing caller keeps working unchanged

#### Scenario: A merge is attributed

- **WHEN** a node is merged into a survivor under a given run
- **THEN** the merged node reports that run as the run that last wrote it, and the merge cannot be performed without a run

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

### Requirement: Every change to a node is recorded as a revision

The store SHALL keep an append-only history for every node. Whenever a node's type, title, content, metadata, or merge pointer changes, the store SHALL record a revision holding the node's full state after the change, the ingest run that made it, and when it was recorded. Recording SHALL be a property of the store itself, not of any particular write path: a write that changes a node cannot skip it. A write that leaves those fields unchanged SHALL NOT record a revision. Revisions for one node SHALL be numbered consecutively from one, in the order they were recorded, and SHALL NOT be modified or removed by any write to the node.

#### Scenario: A node is created

- **WHEN** a node is written for the first time
- **THEN** exactly one revision exists for it, numbered one, holding the written state and attributed to the writing run

#### Scenario: Content is changed

- **WHEN** a node is written again with different content
- **THEN** a second revision exists holding the new content, the first revision still holds the old content, and the two are attributed to their respective runs

#### Scenario: Metadata alone is changed

- **WHEN** a node is written again with identical title and content but a different metadata value
- **THEN** a new revision is recorded holding the new metadata

#### Scenario: Unchanged re-load

- **WHEN** the same batch of nodes is written twice with no differences
- **THEN** the second write records no revisions, even though each node was touched by a different run

#### Scenario: A node is merged away

- **WHEN** a node is merged into a survivor
- **THEN** a revision is recorded for the merged node showing its new merge pointer, attributed to the run that performed the merge

#### Scenario: Nodes that predate history

- **WHEN** the store is upgraded with nodes already in it
- **THEN** every existing node has an initial revision holding its state at upgrade time, attributed to the run that last wrote it

#### Scenario: Concurrent writes to one node

- **WHEN** two writes change the same node at the same time
- **THEN** both are recorded as distinct, consecutively numbered revisions, and neither number is duplicated

### Requirement: A node's history is readable with what changed

The store SHALL return a node's revisions newest-first, bounded by a caller-supplied limit with a means to fetch older revisions. Each revision SHALL state which of type, title, content, metadata, and merge pointer differ from the revision before it, and for metadata SHALL name each top-level key that changed together with its previous and new values. The first revision SHALL report every present field as changed. History SHALL be per node as stored: asking for a merged-away node's history returns that node's own revisions, including the one that merged it, not its survivor's. Content SHALL be omitted from each revision unless the caller asks for it, since it can be large and its hash already reveals whether it changed.

#### Scenario: Reading a status change

- **WHEN** a node's metadata `status` was changed from `open` to `closed` and its history is read
- **THEN** the newest revision reports metadata as changed, names `status` with previous value `open` and new value `closed`, and reports title and content as unchanged

#### Scenario: Reading history without content

- **WHEN** history is read with the default options for a node whose content is large
- **THEN** each revision carries the content hash but not the content, and asking for content returns it

#### Scenario: Paging through a long history

- **WHEN** a node has more revisions than the requested limit
- **THEN** the newest revisions up to the limit are returned, the response says more exist, and a second request continues from where the first stopped without repeating or skipping a revision

#### Scenario: History of an unknown node

- **WHEN** history is requested for an id that names no node
- **THEN** the request is rejected with an error naming the id

### Requirement: Nodes can be listed by structure without query text

The store SHALL return canonical nodes matching structural filters with no search text: node types, source systems, updated at or after an instant, and predicates on top-level metadata keys where a key equals a scalar value or is one of a small set of scalar values. Predicates SHALL be validated data, never an expression the caller composes. Results SHALL be ordered most recently updated first with a deterministic tie-break, bounded by a caller-supplied limit, and pageable by a cursor that never repeats or skips a node. Merged-away nodes SHALL NOT be listed. Metadata predicates SHALL be served by an index rather than a scan of every node's metadata.

#### Scenario: Listing by type and a metadata value

- **WHEN** a caller lists nodes of type `work_item` whose metadata `status` equals `open`
- **THEN** exactly the open work items are returned, newest first, and no closed item appears

#### Scenario: Membership predicate

- **WHEN** a caller lists nodes whose metadata `priority` is one of 0 or 1
- **THEN** items with priority 0 or 1 are returned and no other

#### Scenario: Paging

- **WHEN** more nodes match than the limit
- **THEN** the response says more exist and a second request with the returned cursor continues without repeating or skipping a node

#### Scenario: Malformed predicate

- **WHEN** a predicate names an unknown operation or a non-scalar value
- **THEN** it is rejected naming the predicate, and nothing is queried
