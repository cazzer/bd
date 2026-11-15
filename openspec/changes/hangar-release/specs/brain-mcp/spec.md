## ADDED Requirements

### Requirement: Hangar outcome requests and releasable sessions

The server SHALL expose a write tool that asks a person to accept or table an ended hangar session. It SHALL take a session id, the requested outcome, and a note, and SHALL file an inbox item bound to that session. A session-bound token SHALL be refused it, and so SHALL read-only mode. The tool SHALL NOT set the outcome itself. The session listing tool SHALL accept a `releasable` filter that selects sessions whose outcome is set and whose disk is still held.

#### Scenario: Request and list

- **WHEN** an agent asks to table stopped session S
- **THEN** an inbox item for S is pending, S's outcome is still unset, and S is not yet releasable

#### Scenario: Releasable after a decision

- **WHEN** the person tables S and hangar has not yet acknowledged the release
- **THEN** listing sessions with `releasable: true` includes S
