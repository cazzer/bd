## ADDED Requirements

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
