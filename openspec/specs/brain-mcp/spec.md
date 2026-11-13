# brain-mcp Specification

## Purpose
Exposes the brain over the Model Context Protocol so an agent running on a model subscription can both load content in and query it back out — searching, navigating, writing in batches, linking, and merging — without the server ever making a model call of its own.
## Requirements
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

The server SHALL validate its database connection at startup and SHALL exit with an actionable message when it is unusable, rather than failing on first tool call. The server SHALL require no credential other than the database connection string. In HTTP mode it SHALL also exit before serving, with a message naming the problem, when its port or bind address is invalid or the port is already in use.

#### Scenario: Database unreachable at startup

- **WHEN** the server starts with a connection string pointing at no running database
- **THEN** it exits with an error naming the connection target and the failure

#### Scenario: Port already in use

- **WHEN** the HTTP server starts on a port another process already holds
- **THEN** it exits with an error naming the port and saying it is in use, and does not retry silently

#### Scenario: Invalid port

- **WHEN** the HTTP server is started with a port that is not an integer from 0 to 65535 (0 means an ephemeral port chosen by the OS)
- **THEN** it exits with an error naming the value it was given

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

### Requirement: Shared HTTP transport

The server SHALL offer a Streamable HTTP mode in which one long-running process serves every tool the stdio mode serves, with the same names, inputs, outputs, read-only behavior, and response bounds, at a single `/mcp` endpoint. Each client that initializes SHALL get its own MCP session, and every write made in that session SHALL be attributed to the client as it identified itself when that session began, exactly as over stdio. Sessions SHALL share one database connection pool, not one per session. A request naming a session the server does not hold (expired, or lost to a restart) SHALL be answered with HTTP 404, so the client starts a new session rather than failing silently.

#### Scenario: Two clients share one server

- **WHEN** a client that introduced itself as `claude-code` and a client that introduced itself as `codex` each initialize against the same running HTTP server and each write a node
- **THEN** both writes succeed, each lands in an ingest run whose actor names its own client, and the server process count is still one

#### Scenario: Same tools over both transports

- **WHEN** a client lists tools over HTTP and another lists them over stdio against the same database and read-only setting
- **THEN** both receive the same tool names and input schemas

#### Scenario: Session lost to a restart

- **WHEN** the HTTP server restarts and a client sends a request carrying the session id it held before the restart
- **THEN** the server answers 404 for that session, and a fresh initialize from the same client succeeds

### Requirement: HTTP mode is local only

In HTTP mode the server SHALL listen only on the loopback interface, SHALL implement no authentication, and SHALL refuse at startup any configuration that would bind another address. It SHALL refuse with HTTP 403, before any tool runs, a request whose `Host` header is not `127.0.0.1:<port>`, `localhost:<port>`, or `[::1]:<port>`, and a request of any method carrying an `Origin` header that is not `http://localhost:<any port>`, `http://127.0.0.1:<any port>`, or `http://[::1]:<any port>`. A request without `Origin` (a non-browser client) SHALL be allowed.

#### Scenario: Another host on the network

- **WHEN** the HTTP server is running and a request arrives from another host on the network
- **THEN** it cannot reach the server

#### Scenario: DNS rebinding

- **WHEN** a browser page on a foreign site whose name resolves to 127.0.0.1 sends a request to the server's port
- **THEN** the request carries a foreign `Host` and is refused with 403 without reaching a tool

#### Scenario: Cross-site browser request

- **WHEN** a request arrives with `Host: 127.0.0.1:<port>` and `Origin: https://evil.example`
- **THEN** it is refused with 403 and nothing is read or written

#### Scenario: Non-loopback bind requested

- **WHEN** the HTTP server is started with a bind address other than a loopback address
- **THEN** it exits before listening, with a message saying network exposure is not supported in this mode

### Requirement: Stdio remains supported

The stdio mode SHALL remain available with unchanged behavior, so a client that can only launch a local process, or a session started while the HTTP server is down, can still reach the brain. Nothing written to standard output by the stdio mode's process SHALL be anything other than MCP protocol messages.

#### Scenario: Desktop client over stdio

- **WHEN** a client launches the server as a local process over stdio while the HTTP server is also running
- **THEN** both serve correctly against the same database, and the stdio client's writes are attributed to it

#### Scenario: Stdout carries only protocol

- **WHEN** the stdio mode starts and receives an initialize request
- **THEN** the first byte written to standard output begins a JSON-RPC message

