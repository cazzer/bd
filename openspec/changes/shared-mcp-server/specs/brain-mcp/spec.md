## ADDED Requirements

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

## MODIFIED Requirements

### Requirement: Fail fast on misconfiguration

The server SHALL validate its database connection at startup and SHALL exit with an actionable message when it is unusable, rather than failing on first tool call. The server SHALL require no credential other than the database connection string. In HTTP mode it SHALL also exit before serving, with a message naming the problem, when its port or bind address is invalid or the port is already in use.

#### Scenario: Database unreachable at startup

- **WHEN** the server starts with a connection string pointing at no running database
- **THEN** it exits with an error naming the connection target and the failure

#### Scenario: Port already in use

- **WHEN** the HTTP server starts on a port another process already holds
- **THEN** it exits with an error naming the port and saying it is in use, and does not retry silently

#### Scenario: Invalid port

- **WHEN** the HTTP server is started with a port that is not an integer from 1 to 65535
- **THEN** it exits with an error naming the value it was given
