## Purpose

Shows the reviews agents are waiting on as a live queue inside the breakdown web app, so a person can see, open, and decide them from any view without the review CLI opening or taking over browser tabs.

## ADDED Requirements

### Requirement: Pending reviews form a queue

A review SHALL be pending when it is a work item of a registered beads project, labelled `review` exactly, not closed, and not labelled `review:changes`. The pending queue SHALL be every pending review across every registered project, oldest request first, each with its project, bead id, title, the first line of its review summary, its image count, and when it was requested. It SHALL be read from the store alone; showing it SHALL NOT create, change, or delete any stored row.

#### Scenario: A new review joins the queue

- **WHEN** an agent files a review bead in a registered project
- **THEN** the queue contains it, with its project, bead id, title, summary line, and image count

#### Scenario: Sent-back and closed reviews are not pending

- **WHEN** a review is decided with "changes requested" (labelled `review:changes`), or accepted (closed)
- **THEN** the queue no longer contains it

#### Scenario: An item without the exact label

- **WHEN** an open work item carries the label `review:changes` but not `review`, or a label such as `reviewed`
- **THEN** the queue does not contain it

### Requirement: The queue indicator is on every view

Every view of the app SHALL show a queue indicator holding a status light and the pending count, placed in that view's own header so it covers none of the view's controls. The light SHALL show whether the tab's live stream is connected, connecting, or offline, and SHALL carry a text equivalent for assistive technology. The count SHALL change without a reload within two seconds of a review being filed or decided, in ordinary conditions, while the tab is shown. A count of zero SHALL read as an empty queue, not as an error. The indicator SHALL open the queue panel.

#### Scenario: Count on a non-board view

- **WHEN** a person is on the graph view and an agent files a review
- **THEN** the indicator's count goes up by one without a reload, and the graph keeps its search and selection

#### Scenario: Stream offline

- **WHEN** the server's live stream cannot be reached
- **THEN** the status light reads offline and the count shows the last known value

### Requirement: Reviews are decided from the queue

The queue panel SHALL list the pending reviews. Picking one SHALL open the review drawer for that review over the current view, without changing the view or its address. A decision taken in that drawer SHALL behave exactly as it does from the board, and the decided review SHALL leave the queue without a reload. Closing the drawer SHALL return focus to the queue item that opened it, or to the indicator when that item has left the queue.

#### Scenario: Accepting from the feed

- **WHEN** a person on the feed view picks a queued review and accepts it
- **THEN** the review is closed in its tracker, it leaves the queue, the count drops by one, and the feed view and its address are unchanged

#### Scenario: Picking on the board

- **WHEN** a person on the board picks a queued review
- **THEN** the review's drawer opens and the board's columns and chosen projects are unchanged

### Requirement: The queue can be reviewed in sequence

The queue panel SHALL offer to review every pending review in turn. Doing so SHALL open a dialog over the current view, without changing the view or its address, that shows one review at a time with its position in the run (for example "2 of 5"), its summary, images, and comments, and the decision form. Accepting or requesting changes SHALL write the decision exactly as the drawer does and, once it is written, SHALL show the next review in the run; skipping SHALL show the next review without writing anything. A failed write SHALL keep the review on screen with the failure shown. A review that stops being pending while the run is open SHALL be passed over, and one that becomes pending SHALL join the end of the run. After the last review the dialog SHALL say how many were accepted, sent back, and skipped. Closing the dialog SHALL end the run and return focus to the queue indicator.

#### Scenario: Working through the queue

- **WHEN** three reviews are pending and a person reviews all, accepts the first, skips the second, and requests changes on the third
- **THEN** each decided review is written and leaves the queue, the dialog moves to the next review after each answer, and it ends saying one accepted, one sent back, one skipped

#### Scenario: Decided elsewhere meanwhile

- **WHEN** during a run the next review is accepted from another tab
- **THEN** the dialog passes over it and shows the review after it

#### Scenario: Write fails

- **WHEN** a decision in the run fails to write
- **THEN** the same review stays on screen with the tracker's message, and the run does not advance

### Requirement: One live stream per tab

A tab of the app SHALL hold at most one live change stream to the server, shared by the queue indicator and the board, and SHALL hold none while the tab is hidden. When a hidden tab is shown again, it SHALL re-read the queue (and the board, when shown) so that nothing changed while it was hidden is missed.

#### Scenario: Board and indicator together

- **WHEN** a person has the board open in a shown tab
- **THEN** the tab holds exactly one live stream, and both the board and the indicator update from it

#### Scenario: Hidden tab

- **WHEN** a tab of the app is hidden while a review is filed, and is then shown again
- **THEN** it held no stream while hidden, and on being shown its count includes the new review

### Requirement: Requesting a review does not take over a tab

`review-request` SHALL NOT open a tab, navigate a tab, or bring a tab forward when Chrome already has a tab open on the breakdown app (any view); the review reaches the person through the queue and the herdr notification. It SHALL open a new Chrome tab on the review's board link only when Chrome has no tab on the app or is not running. When it cannot tell whether such a tab exists, it SHALL warn and open a new tab. In every case it SHALL still show the herdr notification and print the review bead id.

#### Scenario: App tab already open

- **WHEN** an agent runs `review-request` while Chrome has a tab on the app's graph view
- **THEN** no tab is opened, navigated, or brought forward, the herdr notification fires, and the review appears in that tab's queue

#### Scenario: No app tab

- **WHEN** an agent runs `review-request` and no Chrome tab is on the app
- **THEN** a new tab opens on `/board?project=<key>&item=<bead id>`

#### Scenario: Probe fails

- **WHEN** the check for an open app tab fails
- **THEN** the command warns, opens a new tab on the review's board link, and still notifies
