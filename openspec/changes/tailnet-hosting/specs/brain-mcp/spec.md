## ADDED Requirements

### Requirement: HTTP mode is local by default

In HTTP mode the server SHALL listen on `127.0.0.1` unless started with a bind address argument, and SHALL admit off-loopback requests only as the client-access capability defines (an allowed `Host` and a valid client token). It SHALL refuse with HTTP 403, before any tool runs, a request whose `Host` is neither loopback (`127.0.0.1`, `localhost`, `[::1]` at its port) nor an allowed host, and a request of any method carrying an `Origin` whose host is neither loopback nor allowed. A request without `Origin` (a non-browser client) SHALL be allowed past the Origin check. A loopback peer with a loopback `Host` SHALL need no token, so local sessions keep working unchanged.

#### Scenario: Default bind

- **WHEN** the HTTP server is started with no bind argument and a request arrives from another host on the network
- **THEN** it cannot reach the server

#### Scenario: DNS rebinding

- **WHEN** a browser page on a foreign site whose name resolves to the server's address sends a request to the server's port
- **THEN** the request carries a foreign `Host` and is refused with 403 without reaching a tool

#### Scenario: Cross-site browser request

- **WHEN** a request arrives with `Host: 127.0.0.1:<port>` and `Origin: https://evil.example`
- **THEN** it is refused with 403 and nothing is read or written

#### Scenario: Worker over the tailnet

- **WHEN** the server is bound to a non-loopback address with its tailnet name allowed, and a worker sends an initialize request with `Host` set to that name and a valid bearer token
- **THEN** the session is established, and the same request without the token is refused with 401

## REMOVED Requirements

### Requirement: HTTP mode is local only

**Reason**: Remote hangar workers, the driver, the laptop and the phone reach Breakdown over Tailscale (epic bd-d38). Off-loopback access now comes with per-client authentication.
**Migration**: None for local clients; the default bind is still `127.0.0.1`. Remote clients use "HTTP mode is local by default" together with client-access.
