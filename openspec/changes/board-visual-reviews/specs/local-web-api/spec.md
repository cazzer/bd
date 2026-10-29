## ADDED Requirements

### Requirement: Board item read, review images, and review decisions

The server SHALL expose a board item read that, given a project key and an item id, returns that work item's title, status, priority, issue type, labels, content, and, for a review, its summary, image paths, pane, and comment thread; an item that is not in that project SHALL be reported not found. The server SHALL serve review screenshots by their path relative to the review image root and SHALL refuse, without reading it, any request that resolves outside that root (including through `..` or a symbolic link) or names a file that is not an image. The server SHALL expose a review decision request taking a project key, an item id, a decision (`accept` or `changes`), and a message; it SHALL refuse a project that is not registered, an item that is not a review in that project, a `changes` decision with an empty message, and any decision while the server is read-only, each before running anything. The tracker commands SHALL run in the registered checkout with arguments passed directly, never through a shell, and the response SHALL report whether the tracker write succeeded (with its error when not) and whether the requesting agent was notified (with the reason when not).

#### Scenario: Reading a review item

- **WHEN** the board item read is asked for project `tides` and item `tides-r1`, a review with two images
- **THEN** the answer carries both image paths, the summary, the pane, and the comment thread

#### Scenario: Image outside the root

- **WHEN** a request asks for a review image whose path resolves to `/etc/passwd`
- **THEN** it is refused and nothing outside the review image root is read

#### Scenario: Unregistered project

- **WHEN** a review decision names a project with no registered checkout
- **THEN** it is refused naming the project, and no tracker command runs

#### Scenario: Message with shell characters

- **WHEN** a review decision's message is `"; rm -rf ~ #`
- **THEN** the tracker comment contains exactly that text and nothing else runs
