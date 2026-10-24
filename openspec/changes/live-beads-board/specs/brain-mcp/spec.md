## MODIFIED Requirements

### Requirement: Batch write and link tools

The server SHALL expose a tool that creates or updates nodes and a tool that asserts edges, each accepting either a single item or a batch in one call. Writes made through the server SHALL be attributed to an ingest run identifying the writing agent as the source system and the connected MCP client, as it identified itself when the session began, as the actor — so agent-authored content is distinguishable from content loaded by other means, and one client's writes are distinguishable from another's. The server SHALL require no configuration to record the actor. Every written node's `occurred_at`, when present, SHALL be normalized to the store's canonical event-time form before anything is persisted, whatever the node's type. A written node of type `work_item` SHALL be validated and defaulted against the work-item contract before anything is persisted. A written node of type `view` SHALL be validated against the view contract, whose renderers are `graph`, `feed`, `code`, `timeline`, and `board`, before anything is persisted. An asserted `blocks` edge that would form a cycle SHALL be refused with an error naming the refused edge's endpoints, and nothing from that call SHALL be persisted.

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

#### Scenario: Agent writes a node with an event time

- **WHEN** the agent writes a node of any type whose metadata `occurred_at` is `2026-03-04T10:00:00+02:00`
- **THEN** the node is persisted with `occurred_at` as `2026-03-04T08:00:00.000Z`, and a later timeline anchored on a node it is linked to lists it at that instant

#### Scenario: Agent writes a node with a bad event time

- **WHEN** the agent writes a batch containing a node whose `occurred_at` is `last Tuesday`
- **THEN** the whole call is rejected naming the item and `occurred_at`, and no node from the batch is persisted

#### Scenario: Agent writes a work item with a bad priority

- **WHEN** the agent writes a batch containing a `work_item` with priority 7
- **THEN** the whole call is rejected naming the item and `priority`, and no node from the batch is persisted

#### Scenario: Agent writes a view with an unknown renderer

- **WHEN** the agent writes a batch containing a `view` whose renderer is `kanban`
- **THEN** the whole call is rejected naming the item and `renderer`, and no node from the batch is persisted

#### Scenario: Agent writes a timeline view

- **WHEN** the agent writes a `view` whose renderer is `timeline` and whose filter names two node types
- **THEN** the node is stored, and the web app's timeline view draws it

#### Scenario: Agent writes a board view

- **WHEN** the agent writes a `view` whose renderer is `board` and whose filter selects `work_item` nodes whose `project` is one of two project keys
- **THEN** the node is stored, and the web app's board view draws it

#### Scenario: Agent declares a default view

- **WHEN** the agent writes a `view` node and then asserts a `default_view` edge from a work item to it
- **THEN** both are stored, and resolving that work item, or any of its `child_of` descendants, names the view

#### Scenario: Agent links a cycle

- **WHEN** the agent asserts a `blocks` edge that would close a cycle
- **THEN** the call is refused with an error that names the edge's endpoints and says the edge was not stored
