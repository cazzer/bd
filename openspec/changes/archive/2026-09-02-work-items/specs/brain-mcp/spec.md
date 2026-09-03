## ADDED Requirements

### Requirement: Structured listing tool

The server SHALL expose a tool that lists nodes by node types, source systems, updated-since, and metadata predicates, with no query text, returning identity, title, and metadata but not content, bounded and pageable like every other read tool. It SHALL be a read tool available in read-only mode.

#### Scenario: Agent lists open work items

- **WHEN** the agent calls the listing tool with node type `work_item` and the predicate `status equals open`
- **THEN** it receives the open work items newest first, with a cursor when more exist

### Requirement: Work item tools

The server SHALL expose a read tool that returns the readiness report and a write tool that patches a work item's fields, attributed to an ingest run identifying the agent and the connected client. The patch tool SHALL be refused in read-only mode like every write tool.

#### Scenario: Agent asks what is ready

- **WHEN** the agent calls the readiness tool
- **THEN** it receives ready items ordered by priority, blocked items with their open blockers, and cycle members

#### Scenario: Agent closes a work item

- **WHEN** the agent patches a work item's status to `closed` with a reason
- **THEN** the item is closed with `closed_at` set, the response names the ingest run, and the node's history shows the change attributed to that run

## MODIFIED Requirements

### Requirement: Batch write and link tools

The server SHALL expose a tool that creates or updates nodes and a tool that asserts edges, each accepting either a single item or a batch in one call. Writes made through the server SHALL be attributed to an ingest run identifying the writing agent as the source system and the connected MCP client, as it identified itself when the session began, as the actor — so agent-authored content is distinguishable from content loaded by other means, and one client's writes are distinguishable from another's. The server SHALL require no configuration to record the actor. A written node of type `work_item` SHALL be validated and defaulted against the work-item contract before anything is persisted. An asserted `blocks` edge that would form a cycle SHALL be refused with an error naming the refused edge's endpoints, and nothing from that call SHALL be persisted.

#### Scenario: Agent loads a repository in bulk

- **WHEN** the agent writes 50 nodes in a single call
- **THEN** all 50 are persisted in one transaction, are immediately searchable, and share one ingest run

#### Scenario: Agent links two existing nodes

- **WHEN** the agent asserts an edge between two node ids with a relationship type
- **THEN** the edge is stored with the agent as source system and a weight the agent supplied or a documented default

#### Scenario: Agent re-loads a source it has already written

- **WHEN** the agent writes the same nodes again with unchanged content
- **THEN** no duplicates are created and the response reports how many nodes were created versus updated versus unchanged

#### Scenario: Writes name the connected client

- **WHEN** a client that introduced itself as `claude-code` version `2.1.0` writes a node
- **THEN** the ingest run for that write records an actor derived from that name and version, with no environment variable or argument involved

#### Scenario: Agent writes a work item with a bad priority

- **WHEN** the agent writes a batch containing a `work_item` with priority 7
- **THEN** the whole call is rejected naming the item and `priority`, and no node from the batch is persisted

#### Scenario: Agent links a cycle

- **WHEN** the agent asserts a `blocks` edge that would close a cycle
- **THEN** the call is refused with an error that names the edge's endpoints and says the edge was not stored
