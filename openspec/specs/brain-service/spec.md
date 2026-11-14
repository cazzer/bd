# brain-service Specification

## Purpose
Runs the brain's HTTP server as one supervised, long-running service on the machine, so every agent session can bind to it by URL without launching its own process. It stays portable to a non-macOS host such as the SkyOS cluster.
## Requirements
### Requirement: Health endpoint

The HTTP server SHALL answer `GET /healthz` without an MCP session. It SHALL return HTTP 200 with a JSON body stating the server is ready, whether it is read-only, and the database target (host, port, database name, never the password) when the database answers a probe. It SHALL return HTTP 503 with a body naming the failure when it does not. The endpoint SHALL be subject to the same local-only request guard as `/mcp`, and SHALL never write.

#### Scenario: Healthy

- **WHEN** the server is running and its database is reachable
- **THEN** `GET /healthz` returns 200 with `ready: true`, the read-only flag, and a database target containing no password

#### Scenario: Database goes away after startup

- **WHEN** the database stops while the server keeps running
- **THEN** `GET /healthz` returns 503 naming the database failure, and the server process stays up

### Requirement: Supervised service on macOS

The project SHALL provide a single command to install, uninstall, and report the status of the HTTP server as a per-user login service on macOS. Once installed, the server SHALL start at login, SHALL be restarted after it exits for any reason, including a fail-fast exit because the database was not yet up, and SHALL write its standard error to a log file under `~/Library/Logs/breakdown/`. Installing SHALL be idempotent, and SHALL resolve the absolute paths it needs at install time so the service does not depend on the login shell's `PATH`. Uninstalling SHALL stop the service and remove what install created, and nothing else. Status SHALL report whether the service is loaded and the result of `GET /healthz`.

#### Scenario: Install then reboot

- **WHEN** the user installs the service and later logs in again
- **THEN** the HTTP server is running without any terminal open, and `GET /healthz` returns 200 once the database is up

#### Scenario: Database starts after the service

- **WHEN** the service starts at login before the database container is accepting connections
- **THEN** the server exits fail-fast, is restarted by the supervisor, and is serving within a bounded number of retries once the database is up

#### Scenario: Install twice

- **WHEN** the user runs install while the service is already installed
- **THEN** the service is left installed once, running the current configuration, with no duplicate entry

#### Scenario: Uninstall

- **WHEN** the user runs uninstall
- **THEN** the server is stopped, the service definition is removed, and the logs and database are left in place

### Requirement: Portable server configuration

The HTTP server SHALL take its port and bind address from command-line arguments with documented defaults, and SHALL read no environment variable beyond those the project already allows. It SHALL depend on no macOS-specific path or facility, so the same command runs unmodified under another supervisor. Only the service installer SHALL be macOS-specific.

#### Scenario: Started by another supervisor

- **WHEN** the HTTP server is started on Linux by a command line naming a port, with `DATABASE_URL` in its environment
- **THEN** it serves `/mcp` and `/healthz` exactly as it does on macOS

#### Scenario: Defaults

- **WHEN** the HTTP server is started with no port or bind arguments
- **THEN** it listens on `127.0.0.1` at the documented default port

