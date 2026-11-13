## Purpose

How a client other than the local machine reaches Breakdown's web API and MCP HTTP server: opt-in exposure, per-client tokens and their lifecycle, browser connection, and attribution of what each client writes.

## ADDED Requirements

### Requirement: Exposure beyond loopback is opt-in

Each server SHALL bind `127.0.0.1` unless started with a bind address argument. A request SHALL be refused with HTTP 403, before any handler runs, when its `Host` header is neither a loopback name (`127.0.0.1`, `localhost`, `[::1]`) at the server's port nor a hostname the operator listed with an allowed-host argument, either at the server's port or without a port (a fronting proxy on its scheme's default port). An `Origin` whose host is an allowed host SHALL name one of those same authorities; an `Origin` on a loopback name MAY carry any port. Allowed hosts SHALL be given only on the command line, never read from the environment.

#### Scenario: Default start

- **WHEN** a server starts with no bind or allowed-host arguments
- **THEN** it listens on `127.0.0.1` only and behaves for local clients exactly as before this change

#### Scenario: Tailnet name allowed

- **WHEN** a server is started bound to a non-loopback address with `breakdown.tail.example` allowed, and a request carrying a valid token arrives with `Host: breakdown.tail.example:<port>`
- **THEN** the request reaches its handler

#### Scenario: Behind a fronting proxy

- **WHEN** a proxy on the same machine terminates HTTPS for `breakdown.tail.example` and forwards to the server with `Host: breakdown.tail.example` and the client's address in `X-Forwarded-For`
- **THEN** the request passes the `Host` check and, as a forwarded request, needs a client token

#### Scenario: Another port on the same host

- **WHEN** a page served from `http://breakdown.tail.example:8080` makes the browser POST to the web API on its own port with the cookie attached
- **THEN** the request is refused with 403

#### Scenario: Foreign Host refused

- **WHEN** a request arrives with a `Host` that is neither loopback nor allowed, with or without a valid token
- **THEN** it is refused with 403 and nothing is read or written

### Requirement: Off-loopback requests carry a client token

A request whose peer address is not loopback SHALL carry a client token, as `Authorization: Bearer <token>` or as the session cookie set by the connect flow, on every path including health checks; otherwise it SHALL be refused with HTTP 401 before any handler runs. The only exceptions SHALL be the browser client's static files (which hold no data) and the connect endpoint itself, and both still pass the `Host` check. A request from a loopback peer with a loopback `Host` SHALL need no token, unless it carries a forwarding header (`X-Forwarded-For`, `Forwarded`, `X-Real-IP`) naming any address that is not loopback — a proxy acting for a remote client is not the local machine. A token that is unknown or revoked SHALL be refused exactly as a missing one. Revoking a token SHALL also end any MCP session it opened, at the latest when that session next makes a request or the revocation is next checked. The 401 response SHALL NOT say whether a token exists.

#### Scenario: Valid token from the tailnet

- **WHEN** a request from a non-loopback peer carries the token issued to `worker-1` to the web API or to `/mcp`
- **THEN** it is served as a loopback request would be

#### Scenario: Missing token

- **WHEN** a request from a non-loopback peer carries no token
- **THEN** it is refused with 401

#### Scenario: Revoked token

- **WHEN** the token for `phone` has been revoked and a request carries it
- **THEN** it is refused with 401, and a request carrying any other client's live token still succeeds

#### Scenario: Local session unchanged

- **WHEN** a Claude Code session on the same machine calls `/mcp` on `127.0.0.1` with no token
- **THEN** it is served as before

### Requirement: Tokens carry a scope

Every token SHALL be created with a scope, `human` or `agent`, chosen at creation and shown when listing. The web API, whose writes are a person's decisions (accepting an inbox request, a review decision, notes), SHALL refuse a request admitted by an `agent` token with HTTP 403, and the connect flow SHALL refuse to set a cookie for one. The MCP server SHALL accept both scopes.

#### Scenario: Worker cannot approve its own request

- **WHEN** a worker holding an `agent` token calls the web API to decide an inbox item
- **THEN** it is refused with 403 and nothing is written

#### Scenario: Worker over MCP

- **WHEN** the same worker calls `/mcp` with its `agent` token
- **THEN** it is served

### Requirement: Per-client tokens are minted and revoked locally

There SHALL be one token per named client. A token SHALL be generated from at least 32 random bytes, carry a recognizable prefix, be shown exactly once at creation, and be stored only as a hash. Tokens SHALL be created, listed, and revoked only by a command run on the host, never through an MCP tool or the web API. Listing SHALL show each client's name, creation time, last use, and revocation state, never the token. Creating a token for a client that already has a live token SHALL be refused, naming the client and how to revoke it.

#### Scenario: Create and use

- **WHEN** the operator creates a token for `driver`
- **THEN** the command prints the token once, the store holds only its hash, and a request with that token is admitted

#### Scenario: No model can mint a credential

- **WHEN** the MCP tool list and the web API's procedures are enumerated
- **THEN** none of them creates, lists, or revokes a token

#### Scenario: Last use recorded

- **WHEN** a client's token admits a request
- **THEN** listing tokens shows a last-use time for that client within 60 seconds of its latest admitted request

### Requirement: Writes are attributed to the token's client

A write admitted by a client token SHALL be recorded with an actor that names the token's client. Over MCP, the actor SHALL also keep the identity the MCP client reported in its handshake, so `worker-1` running `claude-code 2.1.0` is distinguishable from `worker-1` running another client. A write admitted without a token (a loopback request) SHALL keep the actor it records today.

#### Scenario: MCP write from a worker

- **WHEN** a client holding the `worker-1` token, which introduced itself as `claude-code` version `2.1.0`, writes a node over HTTP
- **THEN** the ingest run's actor names both `worker-1` and `claude-code 2.1.0`

#### Scenario: Web write from the phone

- **WHEN** the board, connected with the `phone` token, writes a note or decides an inbox item
- **THEN** the ingest run's actor is `phone`, and its source system is unchanged

### Requirement: Browsers connect with a cookie, not a URL

The web server SHALL accept a token submitted in a POST body and answer, for a valid token, with an HttpOnly, SameSite=Strict cookie that admits later requests; an invalid token SHALL be refused with 401 and set nothing. A token SHALL never be accepted from a query string. A request admitted by the cookie whose method is not GET or HEAD SHALL carry an `Origin` header whose host is loopback or allowed; otherwise it SHALL be refused with 403. Revoking the token SHALL end every cookie carrying it.

#### Scenario: Phone connects

- **WHEN** the board is opened over the tailnet without a cookie
- **THEN** it shows a form asking for a token, and after a valid one is submitted the board loads without further prompts

#### Scenario: Cross-site write with the cookie

- **WHEN** a page on a foreign origin makes the browser POST to the web API with the cookie attached
- **THEN** the request is refused with 403 and nothing is written

#### Scenario: Client shell loads without a token

- **WHEN** a browser with no cookie requests the board's static files from an allowed host
- **THEN** they are served, while every data request from that browser gets 401 until it connects

#### Scenario: Token in a URL

- **WHEN** a request carries a token only as a query parameter
- **THEN** it is treated as carrying no token
