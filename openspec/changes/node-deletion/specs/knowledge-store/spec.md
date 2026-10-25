## ADDED Requirements

### Requirement: Nodes can be deleted without losing their history

The store SHALL support deleting a node. A deleted node SHALL NOT be returned by search, lookup by identifier, structured listing, traversal, timeline, or any other read, and SHALL NOT be reachable as the endpoint of an edge. Its recorded history SHALL survive the deletion intact, so that what the node held and who changed it remain answerable afterwards. Deleting SHALL be attributable to an ingest run, as every other write to a node is, and SHALL be accepted in batches.

Deleting a node that is already deleted SHALL succeed and change nothing, so that a caller retrying a partially applied batch is not punished for it.

#### Scenario: A deleted node leaves every read

- **WHEN** a node is deleted
- **THEN** searching for its content returns nothing, looking it up by its identifiers returns nothing, listing its type does not include it, and expanding a neighbour does not reach it

#### Scenario: Its history survives

- **WHEN** a node is deleted and its history is then read
- **THEN** every revision recorded before the deletion is still present and unmodified

#### Scenario: The deletion is itself recorded

- **WHEN** a node is deleted
- **THEN** a revision is recorded marking it deleted, attributed to the run that performed the deletion

#### Scenario: Deleting is attributable

- **WHEN** a caller attempts to delete a node without an ingest run
- **THEN** the deletion is refused and nothing is changed

#### Scenario: Deleting twice

- **WHEN** a node that is already deleted is deleted again
- **THEN** the call succeeds, the node remains deleted, and no second deletion revision is recorded

#### Scenario: Deleting a survivor of a merge

- **WHEN** a node that other nodes were merged into is deleted
- **THEN** the deletion succeeds, and the nodes that redirect to it are no longer reachable through it either

### Requirement: Edges of a deleted node are not traversed

An edge SHALL stop being returned or traversed as soon as either of its endpoints is deleted, without the edge itself being destroyed. Restoring the endpoint SHALL bring the edge back with its original type, provenance, and weight.

#### Scenario: An edge with a deleted endpoint

- **WHEN** one endpoint of an edge is deleted
- **THEN** the edge is not returned by a read of the surviving endpoint's neighbours, and the surviving endpoint's degree does not count it

#### Scenario: The edge is not lost

- **WHEN** the deleted endpoint is restored
- **THEN** the edge is returned again, carrying the same type, provenance, and weight it had before

### Requirement: A deleted node can be restored

The store SHALL support restoring a deleted node, returning it and its edges to every read exactly as they were. Restoration SHALL be attributable to an ingest run and SHALL be recorded as a revision. Restoring a node that is not deleted SHALL succeed and change nothing.

#### Scenario: Restoring

- **WHEN** a deleted node is restored
- **THEN** it is returned by search and lookup again, its edges are traversable again, and its history shows both the deletion and the restoration

#### Scenario: Restoring something that was never deleted

- **WHEN** a node that is not deleted is restored
- **THEN** the call succeeds, the node is unchanged, and no revision is recorded

### Requirement: Re-loading a deleted node's source brings it back

Deletion SHALL remove what is in the store, not record a permanent objection to it. When a loader writes a node whose identifiers match a deleted one, the store SHALL revive that node and apply the write, rather than skipping it or creating a second node alongside it.

This is deliberately unlike a merge, which a re-load leaves in effect: a merge is a claim about identity that stays true, whereas a deletion is a statement about what the store should currently hold. Keeping a type permanently out of a view is the job of a view's filter, not of deletion.

#### Scenario: A loader re-encounters a deleted node

- **WHEN** a loader writes a node whose source system and external id match a deleted node
- **THEN** that node is no longer deleted, holds the newly written content, and is returned by reads again

#### Scenario: No duplicate is created

- **WHEN** a deleted node's source is re-loaded
- **THEN** exactly one node exists for those identifiers, not a live one beside a deleted one

## MODIFIED Requirements

### Requirement: Every change to a node is recorded as a revision

The store SHALL keep an append-only history for every node. Whenever a node's type, title, content, metadata, merge pointer, or deleted state changes, the store SHALL record a revision holding the node's full state after the change, the ingest run that made it, and when it was recorded. Recording SHALL be a property of the store itself, not of any particular write path: a write that changes a node cannot skip it. A write that leaves those fields unchanged SHALL NOT record a revision. Revisions for one node SHALL be numbered consecutively from one, in the order they were recorded, and SHALL NOT be modified or removed by any write to the node — including a deletion, which SHALL leave the node's existing revisions intact.

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

#### Scenario: A node is deleted

- **WHEN** a node is deleted
- **THEN** a revision is recorded showing it deleted, attributed to the run that performed the deletion, and every revision recorded before it is unchanged

#### Scenario: Nodes that predate history

- **WHEN** the store is upgraded with nodes already in it
- **THEN** every existing node has an initial revision holding its state at upgrade time, attributed to the run that last wrote it

#### Scenario: Concurrent writes to one node

- **WHEN** two writes change the same node at the same time
- **THEN** both are recorded as distinct, consecutively numbered revisions, and neither number is duplicated
