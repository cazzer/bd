# beads-project-registration Specification

## Purpose
A person or Claude registers a beads project by key and checkout path without running `bd` and without database access, so a Breakdown without `bd` (the Jetson) gains projects that the laptop relay then loads.
## Requirements

### Requirement: Register a beads project without running bd

The system SHALL register a beads project from a project key and a checkout path alone, without running `bd` and without database access by the caller. A registration SHALL write only the project's registry record (the key and the path) and SHALL leave every work item and edge untouched. It SHALL be attributed to the caller and SHALL count as a registration everywhere a local beads ingest's registration counts: the server's beads watcher, the relay's project list (`GET /relay/v1/projects`), and the board's project list. The key SHALL obey the existing project key contract (`[a-z0-9._-]{1,64}`, trimmed); a malformed key SHALL be refused naming `project`.

#### Scenario: Register a new project on a server without bd

- **WHEN** a caller registers key `underground` at `/Users/me/dev/underground` on a Breakdown with no `bd`
- **THEN** the response reports the project as created with that key and path, and `GET /relay/v1/projects` lists `{ key: "underground", path: "/Users/me/dev/underground" }`

#### Scenario: Work items are not touched

- **WHEN** a project that already has work items and dependency edges is registered again at its own path
- **THEN** no work item, edge, or revision changes and the response reports the project as unchanged

#### Scenario: Malformed key

- **WHEN** a caller registers key `Under Ground`
- **THEN** the registration is refused naming `project` and nothing is written

### Requirement: Registration is idempotent and never re-points a project

Registering a key already registered at the same path SHALL succeed without changing anything. Registering a key already registered at a different path SHALL be refused with a conflict that names the key, the stored path, and the requested path, and SHALL write nothing. No registration SHALL remove a project.

#### Scenario: Same key, same path

- **WHEN** `underground` is registered at the same path twice
- **THEN** both calls succeed, the second reports `unchanged`, and the registry holds one record

#### Scenario: Same key, other path

- **WHEN** `underground` is registered at `/Users/me/dev/underground` and then at `/Users/me/tmp/underground`
- **THEN** the second call is refused as a conflict naming both paths, and the registry still points at the first

### Requirement: The path is checked where bd will run

On a Breakdown that has `bd` (one that watches its own checkouts), the path SHALL be a directory that exists on this host, SHALL be its own realpath (no symlink on the way), and SHALL hold `.beads/`; otherwise the registration SHALL be refused saying which check failed. On a Breakdown without `bd` (where the relay pushes), the server SHALL NOT read the path: it SHALL require only an absolute, normalized path (no `.` or `..` segments, no trailing slash, at most 1024 characters, no control characters) and SHALL store it as given, leaving the existence and `.beads/` checks to the relay, which serves a project only when it holds that key at that path on its own command line.

#### Scenario: Server with bd, missing beads store

- **WHEN** a server that has `bd` is asked to register a directory with no `.beads/`
- **THEN** the registration is refused saying the directory holds no `.beads/`, and nothing is written

#### Scenario: Server without bd, relative path

- **WHEN** a server without `bd` is asked to register `dev/underground`
- **THEN** the registration is refused saying the path must be absolute

#### Scenario: Server without bd, path it cannot see

- **WHEN** a server without `bd` is asked to register `/Users/me/dev/underground`, which does not exist on that server
- **THEN** the registration succeeds and the path is stored as given

### Requirement: People register projects over the web API

The web API SHALL expose a registration mutation that only `human` callers reach (a `human`-scoped token, or a tokenless loopback request). It takes `project` and `path` and returns the key, the stored path, and whether the project was created or unchanged. An `agent`, `hangar`, or `relay` token SHALL be refused.

#### Scenario: Human token registers a project

- **WHEN** a request with a `human` token calls the registration mutation with a valid key and path
- **THEN** the project is registered and the response names the key, the path, and `created`

#### Scenario: Relay token is refused

- **WHEN** a request with a `relay` token calls the registration mutation
- **THEN** it is refused, as every non-relay endpoint refuses a relay token, and nothing is written
