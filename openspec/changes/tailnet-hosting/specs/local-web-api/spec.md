## ADDED Requirements

### Requirement: Local by default, no credential for the local machine

The server SHALL listen on `127.0.0.1` unless started with a bind address argument, and SHALL require no credential other than the database connection string for requests from the local machine. Requests from any other host SHALL be admitted only as the client-access capability defines (an allowed `Host` and a valid client token).

#### Scenario: Server binds to loopback by default

- **WHEN** the server starts with no bind argument
- **THEN** it accepts connections from the local machine only, and a request from another host on the network cannot reach it

#### Scenario: Remote board with a token

- **WHEN** the server is bound to a non-loopback address with its tailnet name allowed, and a request from another host carries a valid client token
- **THEN** it is served; the same request without a token is refused with 401

#### Scenario: Database unreachable at startup

- **WHEN** the server starts with a connection string pointing at no running database
- **THEN** it exits with a message naming the connection target and the failure, rather than failing on the first request

## REMOVED Requirements

### Requirement: Local only, no credential beyond the database

**Reason**: The board must be reachable from the phone and laptop over Tailscale (epic bd-d38). Remote access now comes with per-client tokens.
**Migration**: None for local use; the default bind is still `127.0.0.1`. Remote access follows "Local by default, no credential for the local machine" and client-access.
