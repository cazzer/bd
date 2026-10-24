## ADDED Requirements

### Requirement: Board read and live change stream

The server SHALL expose a board read that accepts an optional set of project keys and returns, for every work item in those projects (or in every registered project when none are named), its id, title, project, status, priority, issue type, assignee, board column, nearest epic, and open blockers, without content, bounded in size like the listing. It SHALL expose the list of registered projects with each one's key, checkout path, and last-ingest outcome. It SHALL expose a subscription that streams a change event — naming the project and the ids of the nodes created or updated — each time a re-ingest of a registered project changes the store, and a refresh request that re-ingests every registered project on demand and reports each project's outcome. The subscription SHALL travel over the same loopback server as every other procedure and SHALL be closed when the server shuts down, so that shutdown never waits on a connected browser.

#### Scenario: Reading the board for two projects

- **WHEN** the board asks for projects `tides` and `strides`
- **THEN** every work item in those two projects comes back with its column and nearest epic, and none from any other project

#### Scenario: Subscribing to changes

- **WHEN** a browser subscribes to board changes and an item in a registered project is then updated in its tracker
- **THEN** the subscription receives an event naming that project and the updated item's id

#### Scenario: Manual refresh

- **WHEN** a person requests a refresh
- **THEN** every registered project is re-ingested and the response names, per project, how many items were created, updated, and unchanged, or why its ingest failed

#### Scenario: Shutdown with a subscriber connected

- **WHEN** the server is asked to stop while a browser holds an open subscription
- **THEN** the subscription is ended and the server exits without waiting for the browser to disconnect
