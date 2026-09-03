## ADDED Requirements

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

## MODIFIED Requirements

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
