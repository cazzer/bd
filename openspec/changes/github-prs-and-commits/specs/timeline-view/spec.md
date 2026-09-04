## MODIFIED Requirements

### Requirement: The timeline lists an anchor's timed neighbours newest first

The timeline SHALL list the anchor's neighbours that carry an event time, newest first, narrowed to the chosen types and to the view's source systems, and SHALL page through them with the store's timeline cursor without repeating or skipping a row. Each row SHALL show the item's event time, title, type, source system, and how it relates to the anchor, and every external link found among the item's top-level metadata values. The timeline SHALL state how many neighbours matching the selection carry no event time, so that an incomplete picture is named rather than silent. Activating a row SHALL open that node selected in the graph view. The timeline SHALL never show a node's content.

#### Scenario: A repository's history

- **WHEN** the anchor is a repository with issues opened in March and in June, and one file with no event time
- **THEN** the June issue is listed above the March one, each with its time, title, type, source, and relation to the repository, the issue rows carry their GitHub links, and the view says one neighbour has no time

#### Scenario: Issues, pull requests, and commits interleave

- **WHEN** the anchor is a repository whose GitHub node and git root have been merged, with issues, pull requests, and commits loaded
- **THEN** all three kinds are listed in one order by event time, each row naming its type, and deselecting the `commit` chip leaves the issues and pull requests in place

#### Scenario: A file's history

- **WHEN** the anchor is a `file` node that three loaded commits changed
- **THEN** the three commits are listed newest first, each related to the file as `touches`

#### Scenario: A pull request that closes an issue

- **WHEN** the anchor is an issue and a loaded pull request closes it
- **THEN** the pull request is listed with its relation shown as `closes`

#### Scenario: Paging

- **WHEN** more timed neighbours match than one page holds
- **THEN** the timeline says more exist and a control loads the next page without repeating or skipping a row

#### Scenario: Nothing timed

- **WHEN** every neighbour matching the selection lacks an event time
- **THEN** no rows are listed and the view says how many neighbours have no time

#### Scenario: Activating a row

- **WHEN** a person activates a row
- **THEN** the graph view opens with that node selected, and the browser's back control returns to the timeline
