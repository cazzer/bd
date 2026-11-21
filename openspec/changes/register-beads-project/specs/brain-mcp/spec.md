## ADDED Requirements

### Requirement: Project registration tool

The server SHALL expose a write tool that registers a beads project from a key and a checkout path, with the beads-project-registration rules for idempotence, conflicts, and path checks, and attributed to the agent and the connected client. The tool SHALL be refused in read-only mode like every write tool, and SHALL be refused to a hangar session token, so a remote worker cannot choose which checkouts are watched. Its response SHALL name the key, the stored path, whether the project was created or unchanged, and that the laptop relay serves the project only once the key is on its own `--project` list.

#### Scenario: Claude registers a project

- **WHEN** a Claude session on the Mac calls the registration tool with `underground` and its checkout path
- **THEN** the project is registered, and the response says it was created and that the relay picks it up within 5 minutes if `underground` is on its `--project` list

#### Scenario: Hangar session token is refused

- **WHEN** a client admitted by a hangar session token calls the registration tool
- **THEN** the call is refused and nothing is written

#### Scenario: Read-only mode

- **WHEN** the server runs read-only and the registration tool is called
- **THEN** the call is refused like every write tool
