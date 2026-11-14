## ADDED Requirements

### Requirement: Hangar tools

The server SHALL expose a write tool that requests a hangar session for a work item. It takes a repo, a work item id, and a flavor, and answers with the session id and hangar's status. The server SHALL also expose read tools for hangar's status and for listing sessions, filtered by state or work item. The write tool SHALL be refused in read-only mode, like every other write tool. No hangar tool SHALL claim a request, change a session's state, or return a token.

#### Scenario: Request from a skill

- **WHEN** a driver skill calls the request tool for work item W with flavor `display-browser`
- **THEN** it receives the new session's id and either "online" or "offline since …", and the session is queued

#### Scenario: Status

- **WHEN** an agent calls the status tool
- **THEN** it receives online, offline since a time, or never checked in, plus the number of queued and running sessions
