## ADDED Requirements

### Requirement: History tool

The server SHALL expose a tool that returns a node's revision history: revisions newest-first, each with its number, when it was recorded, the ingest run that made it with source system and actor, which fields changed versus the previous revision, and for metadata which keys changed with their previous and new values. The tool SHALL be a read tool: advertised and usable in read-only mode, and bounded like every other response. Content SHALL be included per revision only when the agent asks for it.

#### Scenario: Agent asks how a work item changed

- **WHEN** the agent calls the history tool for a node whose metadata `status` was changed from `open` to `closed` by a person in the web app
- **THEN** the response's newest revision names `status` with previous value `open` and new value `closed`, and attributes it to a run with source system `human`

#### Scenario: History in read-only mode

- **WHEN** the server is configured read-only and the agent calls the history tool
- **THEN** the call succeeds and the tool appears in the advertised tool list

#### Scenario: Long history is bounded

- **WHEN** a node's history exceeds the response budget or the requested limit
- **THEN** the response contains the newest revisions that fit, states that it was truncated, and indicates how to fetch older revisions

## MODIFIED Requirements

### Requirement: Batch write and link tools

The server SHALL expose a tool that creates or updates nodes and a tool that asserts edges, each accepting either a single item or a batch in one call. Writes made through the server SHALL be attributed to an ingest run identifying the writing agent as the source system and the connected MCP client, as it identified itself when the session began, as the actor — so agent-authored content is distinguishable from content loaded by other means, and one client's writes are distinguishable from another's. The server SHALL require no configuration to record the actor.

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

### Requirement: Merge tool for duplicates the agent notices

The server SHALL expose a tool that merges one node into another. Because no similarity scoring runs in the read path, duplicate detection is the agent's judgment, and the tool SHALL make acting on it a single call. A merge made through the server SHALL be attributed to an ingest run identifying the agent as source system and the connected client as actor, and the response SHALL report that run's id.

#### Scenario: Agent spots a duplicate

- **WHEN** the agent calls the merge tool with a duplicate node id and a survivor node id
- **THEN** the merge is applied, and subsequent searches return only the survivor

#### Scenario: Merge targets the same node twice

- **WHEN** the agent merges a node that has already been merged into the same survivor
- **THEN** the call succeeds without changing anything, rather than erroring

#### Scenario: A merge shows up in history

- **WHEN** the agent merges a node and then reads that node's history
- **THEN** the newest revision reports the merge pointer as changed and is attributed to a run with source system `agent` and the client's actor
