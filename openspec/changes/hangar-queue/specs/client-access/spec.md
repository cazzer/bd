## MODIFIED Requirements

### Requirement: Tokens carry a scope

Every token SHALL be created with a scope (`human`, `agent`, or `hangar`), chosen at creation and shown when listing. Each web API procedure SHALL declare the scopes it admits, and a procedure that declares none SHALL be refused to every token, so that a new procedure must choose.

People's decisions SHALL admit `human` only. These are deciding, releasing, or handing off inbox items, review decisions and review sessions, notes and other human writes, and opening or focusing sessions. `inbox.request`, `inbox.complete`, and the reads that the inbox and review-request scripts use SHALL also admit `agent`. Only the hangar endpoints SHALL admit `hangar`. The connect flow SHALL set a cookie only for a `human` token. The MCP server SHALL admit `human` and `agent`.

#### Scenario: Worker cannot approve its own request

- **WHEN** a worker holding an `agent` token calls the web API to decide an inbox item
- **THEN** it is refused with 403 and nothing is written

#### Scenario: Worker files a request

- **WHEN** a worker holding an `agent` token files an inbox request over the web API
- **THEN** the item is created, attributed to the worker's client

#### Scenario: Worker over MCP

- **WHEN** the same worker calls `/mcp` with its `agent` token
- **THEN** it is served

#### Scenario: Hangar token stays on its endpoints

- **WHEN** the `hangar` token calls a tRPC procedure or `/mcp`
- **THEN** it is refused with 403

### Requirement: Per-client tokens are minted and revoked locally

There SHALL be one live token per named client. A token SHALL be generated from at least 32 random bytes, carry a recognizable prefix, be shown exactly once at creation, and be stored only as a hash.

Tokens SHALL be created, listed, and revoked by a command run on the host. The single exception is a session token: a `hangar`-scoped claim creates it bound to the claimed session, and it is revoked when that session ends. No MCP tool or tRPC procedure SHALL create, list, or revoke a token.

Listing SHALL show each client's name, scope, bound session if any, creation time, last use, and revocation state, never the token. Creating a token from the host for a client that already has a live token SHALL be refused, naming the client and how to revoke it.

#### Scenario: Create and use

- **WHEN** the operator creates a token for `driver`
- **THEN** the command prints the token once, the store holds only its hash, and a request with that token is admitted

#### Scenario: No model can mint a credential

- **WHEN** the MCP tool list and the web API's procedures are enumerated
- **THEN** none of them creates, lists, or revokes a token

#### Scenario: Session token listed

- **WHEN** hangar has claimed session S and the operator lists tokens
- **THEN** the session's client appears with scope `agent` and session S, and no token text

#### Scenario: Last use recorded

- **WHEN** a client's token admits a request
- **THEN** listing tokens shows a last-use time for that client within 60 seconds of its latest admitted request
