## Purpose

Exposes the brain over the Model Context Protocol so an agent running on a model subscription can both load content in and query it back out — searching, navigating, writing in batches, linking, and merging — without the server ever making a model call of its own.

## ADDED Requirements

### Requirement: Search, read, and navigation tools

The server SHALL expose a tool that runs retrieval for query text, a tool that fetches one or more nodes by identifier with full content, a tool that lists a node's immediate neighbors with edge types, directions, and weights, and a tool that summarizes the store's vocabulary and recent activity.

#### Scenario: Agent searches for context

- **WHEN** the agent calls the search tool with query text and no other arguments
- **THEN** the server returns a scored subgraph using documented default bounds, and the defaults used are stated in the response

#### Scenario: Agent follows an edge

- **WHEN** the agent calls the neighbors tool for a node returned by search
- **THEN** the server returns that node's adjacent nodes with edge type, direction, weight, and source system

#### Scenario: Agent orients in an unfamiliar store

- **WHEN** the agent calls the summary tool before searching
- **THEN** it receives the node types, source systems, and edge types in use with counts, and recently updated nodes

### Requirement: Batch write and link tools

The server SHALL expose a tool that creates or updates nodes and a tool that asserts edges, each accepting either a single item or a batch in one call. Writes made through the server SHALL be attributed to an ingest run identifying the writing agent as the source system, so agent-authored content is distinguishable from content loaded by other means.

#### Scenario: Agent loads a repository in bulk

- **WHEN** the agent writes 50 nodes in a single call
- **THEN** all 50 are persisted in one transaction, are immediately searchable, and share one ingest run

#### Scenario: Agent links two existing nodes

- **WHEN** the agent asserts an edge between two node ids with a relationship type
- **THEN** the edge is stored with the agent as source system and a weight the agent supplied or a documented default

#### Scenario: Agent re-loads a source it has already written

- **WHEN** the agent writes the same nodes again with unchanged content
- **THEN** no duplicates are created and the response reports how many nodes were created versus updated versus unchanged

### Requirement: Merge tool for duplicates the agent notices

The server SHALL expose a tool that merges one node into another. Because no similarity scoring runs in the read path, duplicate detection is the agent's judgment, and the tool SHALL make acting on it a single call.

#### Scenario: Agent spots a duplicate

- **WHEN** the agent calls the merge tool with a duplicate node id and a survivor node id
- **THEN** the merge is applied, and subsequent searches return only the survivor

#### Scenario: Merge targets the same node twice

- **WHEN** the agent merges a node that has already been merged into the same survivor
- **THEN** the call succeeds without changing anything, rather than erroring

### Requirement: No arbitrary SQL from the model

The server SHALL NOT expose a tool that executes caller-supplied SQL. All access SHALL go through the defined tools, with parameters validated before use.

#### Scenario: Model attempts to smuggle SQL

- **WHEN** a tool argument contains SQL syntax
- **THEN** it is treated as literal text — as query text or content — and never executed

### Requirement: Read-only mode

The server SHALL support a read-only configuration in which write, link, and merge tools are not advertised and are refused if called.

#### Scenario: Read-only server receives a write

- **WHEN** the server is configured read-only and a write tool is invoked
- **THEN** the call is refused with an error explaining that the server is read-only, and nothing is persisted

### Requirement: Bounded responses

Tool responses SHALL be bounded in size. When a result is truncated, the response SHALL say so and SHALL provide the means to retrieve the remainder.

#### Scenario: Oversized result

- **WHEN** a search returns more content than the response budget allows
- **THEN** the response contains the highest-scoring subset, states that it was truncated, and indicates how to fetch the rest

### Requirement: Fail fast on misconfiguration

The server SHALL validate its database connection at startup and SHALL exit with an actionable message when it is unusable, rather than failing on first tool call. The server SHALL require no credential other than the database connection string.

#### Scenario: Database unreachable at startup

- **WHEN** the server starts with a connection string pointing at no running database
- **THEN** it exits with an error naming the connection target and the failure
