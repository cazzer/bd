# app-navigation Specification

## Purpose
Gives every view the same header, so a reader can reach any other view, carry the project they are working in from view to view, and get to the review queue and the inbox from anywhere.
## Requirements
### Requirement: Every view shares one header

Every routed view (graph, board, roadmap, feed, code, timeline, inbox, search) SHALL show the same header. In order, it SHALL hold the project switcher; nav links to Graph, Board, Roadmap, Inbox, and Search; a Views menu; search; the hangar and relay status; and the review control. The link for the current view SHALL be marked as current. A view's own controls (titles, filters, Refresh, tabs) SHALL sit in a toolbar below the header, never in it. The header SHALL be a bar of one height at the top of the page, in the page's flow above the view, and SHALL keep its position and size while views load and when the reader moves between views. While a drawer covers a narrow screen, the header SHALL be inert.

#### Scenario: Reaching the inbox from the graph

- **WHEN** a reader on the graph activates Inbox in the header
- **THEN** the inbox opens, and Inbox is marked as the current link

#### Scenario: Header stays put

- **WHEN** a reader moves from the board to the roadmap and then to the timeline
- **THEN** the switcher, nav links, and review control stay at the same position on every view

### Requirement: The Views menu lists saved views

The header's Views menu SHALL list the store's saved view nodes that an address can open, grouped by renderer in the order Feeds, Code views, Timelines, Boards, each by title. Saved graph views SHALL NOT be listed while the graph route cannot open one. Choosing one SHALL open it in its renderer, carrying the reader's `project`. A renderer with no saved views SHALL NOT be listed. While a saved view is open, the menu SHALL mark it as current. When the menu cannot be read, it SHALL say so and the rest of the header SHALL still work.

#### Scenario: Opening a saved timeline

- **WHEN** the store holds a timeline view titled "Shipping log" and a reader chooses it from the Views menu
- **THEN** the timeline opens on that view

#### Scenario: No saved feeds

- **WHEN** the store holds no feed views
- **THEN** the Views menu shows no feed group

#### Scenario: The open view is marked

- **WHEN** a reader is on the timeline view "Shipping log" and opens the Views menu
- **THEN** "Shipping log" is marked as the current page, no nav link is marked current, and Board opens the plain board

### Requirement: The chosen project follows the reader

Every route SHALL accept `project=<key>`, and every link the header draws SHALL carry the current `project` parameters, as SHALL a view's own address changes and the links a view draws to another view. The header's project switcher SHALL offer "All projects" and each registered project, with the same labels and one-at-a-time choice the board uses. Board, roadmap, and search SHALL be scoped by `project`, as they are today. On graph, feed, code, timeline, and inbox, choosing a project SHALL change only the address and the header's links; the switcher SHALL state, visibly and to assistive technology, that this view is not filtered by project.

#### Scenario: Project survives a detour

- **WHEN** a reader on `/board?project=tides` opens Graph and then Roadmap from the header
- **THEN** the graph's address carries `project=tides`, and the roadmap opens on tides

#### Scenario: Unscoped view says so

- **WHEN** a reader on the inbox chooses `skyos` from the switcher
- **THEN** the address gains `project=skyos`, the inbox list is unchanged, and the switcher says the inbox is not filtered by project

#### Scenario: Shared link

- **WHEN** a reader opens `/timeline?view=v1&project=tides`
- **THEN** the switcher reads tides and the header's Board link opens `/board?project=tides`

### Requirement: The review control reaches the queue and the inbox

The header's review control SHALL show the number of pending reviews, updated live as today, and the number of inbox items needing the reader. Opening it SHALL show the review queue as today: each pending review opens the review drawer over the current view, and "Review all" walks the queue. It SHALL also offer a "Go to inbox" link that opens the inbox's Needs me, carrying `project`. A review decided from the queue SHALL leave the inbox's Needs me without a reload. When the inbox count cannot be read, the control SHALL still show and run the review queue.

#### Scenario: Going to the inbox

- **WHEN** a reader opens the review control and activates "Go to inbox"
- **THEN** the inbox opens on Needs me

#### Scenario: Deciding clears the inbox

- **WHEN** a reader accepts a review from the queue while the inbox lists it under Needs me
- **THEN** the review is gone from Needs me without a reload

#### Scenario: Inbox items counted

- **WHEN** there are 2 pending reviews and 3 inbox items needing the reader
- **THEN** the control shows both counts and names which is which to assistive technology

### Requirement: The header fits a phone

The header SHALL fit on one row without horizontal page scroll at every width from 390 px up. From 80rem wide everything is inline. From 56rem to 80rem the nav links and the Views menu SHALL stay inline, with search behind a search button and the status pills shown as a dot and count. Below 56rem the nav links, the Views menu and search SHALL collapse into one menu button that names the current place. The project switcher and the review control SHALL stay visible at every width. Below 40rem the hangar and relay status MAY move into the menu, and then the menu button SHALL show a warning while either is offline. Every control SHALL be operable by keyboard and named for assistive technology.

#### Scenario: Phone navigation

- **WHEN** a reader at 390 px wide opens the menu button and chooses Roadmap
- **THEN** the roadmap opens with the chosen project and the menu closes

#### Scenario: Laptop navigation

- **WHEN** a reader at 1100 px wide is on the board
- **THEN** the nav links and the Views menu are shown inline, and no control is cut off

#### Scenario: Status behind the menu

- **WHEN** a reader at 390 px wide has hangar offline and the menu is closed
- **THEN** the menu button shows a warning

