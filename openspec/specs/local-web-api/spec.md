# local-web-api Specification

## Purpose
The contract between the browser and the knowledge store on a single machine — a typed, local-only surface that exposes reading and a narrow set of human writes, and that cannot become a way around the guarantees the store enforces.
## Requirements
### Requirement: Local only, no credential beyond the database

The server SHALL listen only on the loopback interface and SHALL require no credential other than the database connection string. It SHALL NOT implement authentication, and SHALL NOT be reachable from another host on the network.

#### Scenario: Server binds to loopback

- **WHEN** the server starts
- **THEN** it accepts connections from the local machine only, and a request from another host on the network cannot reach it

#### Scenario: Database unreachable at startup

- **WHEN** the server starts with a connection string pointing at no running database
- **THEN** it exits with a message naming the connection target and the failure, rather than failing on the first request

### Requirement: Writes preserve every store invariant

Every write the server exposes SHALL go through the same code path that enforces ingest-run attribution, the deduplication key, content validation, and the merge invariants. The server SHALL NOT expose direct table access, arbitrary SQL, or any operation that writes a node or edge without attribution.

#### Scenario: Human writes are attributed

- **WHEN** a person creates a note, edits content, or asserts an edge through the server
- **THEN** the resulting rows are attributed to an ingest run identifying the person as the source, distinguishable from loader-written and agent-written content

#### Scenario: No arbitrary SQL

- **WHEN** a request carries SQL syntax in any field
- **THEN** it is treated as literal text and never executed

#### Scenario: A rejected write persists nothing

- **WHEN** a write fails validation
- **THEN** nothing is persisted and the response names the offending input and why it was rejected

### Requirement: Read surface serves the explorer's needs

The server SHALL expose search returning a scored subgraph, a bounded neighbour fetch, node retrieval with full content, and a store summary. Results SHALL carry the properties the explorer renders: each node's degree across the store and its inclusion provenance, and each edge's type, weight, and source system.

#### Scenario: Search returns renderable results

- **WHEN** the explorer submits a query
- **THEN** the response contains nodes with degree and inclusion provenance, edges with weight and source system, and the effective bounds that were applied

#### Scenario: Neighbour fetch is bounded and ordered

- **WHEN** the explorer requests a node's neighbours with a limit
- **THEN** at most that many are returned, ordered by descending edge weight, and the response indicates whether more exist

### Requirement: The client is typed end to end without a code generation step

Client and server SHALL share types directly from the server's own definitions, so a change to a procedure's inputs or outputs surfaces as a compile error in the browser code with no schema generation or build step between them.

#### Scenario: Changing a procedure's return type

- **WHEN** a server procedure's return type changes and a caller is not updated
- **THEN** typechecking the web app fails, naming the caller

### Requirement: Failures are actionable to the caller

An error response SHALL identify what was wrong with the request specifically enough to correct it, and SHALL NOT leak a stack trace, an internal file path, or the database connection string.

#### Scenario: Invalid input

- **WHEN** a request carries an out-of-range option or a malformed identifier
- **THEN** the response names the field and the acceptable values

#### Scenario: Unexpected server failure

- **WHEN** an unhandled failure occurs
- **THEN** the response carries a safe message while the full detail goes to the server's own log only

