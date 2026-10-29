## Purpose

Lets an agent ask a person to accept its visual work, lets the person look at the screenshots and answer from the board, and delivers the answer to the tracker and back to the agent that asked.

## ADDED Requirements

### Requirement: A review is an ordinary bead that follows one convention

A review request SHALL be a beads issue of type `task`, labelled `review`, whose parent is the item under review, and whose beads metadata key `review` holds `images` (absolute paths of the screenshots, each under the review image root `~/.local/share/breakdown/reviews/<project>/<bead-id>/`), `pane` (the requester's herdr pane id, or absent), `socket` (the herdr server socket that pane id belongs to, or absent), and `summary` (what to look at). When the item under review is not an epic, it SHALL also depend on the review bead with a `blocks` dependency; an epic SHALL be gated by the parent link alone, because the tracker refuses to close an epic with an open child. A decision to accept SHALL add a comment and close the bead; a decision to request changes SHALL add a comment and the label `review:changes`, leaving the bead open.

#### Scenario: Epic under review

- **WHEN** a review is requested for an epic
- **THEN** the review bead is the epic's child, and the tracker refuses to close the epic until the review bead is closed

#### Scenario: Task under review

- **WHEN** a review is requested for a task
- **THEN** the review bead is the task's child and the task depends on it

### Requirement: An agent requests a review with one command

`review-request <item-id> --summary <text> <image>...` run inside a registered checkout, or inside a git worktree of one, SHALL copy every image into the review image root under that project and bead, file the review bead per the convention with the caller's herdr pane and herdr socket, open Chrome on the board's drawer for that bead, show a herdr notification, print the bead id, and tell the caller to end its turn and wait for a prompt. When the item already has an open review bead, the command SHALL reuse it: replace its images and summary, record the caller's pane, remove `review:changes`, and add a comment saying the review was updated. The command SHALL refuse, changing nothing, when the checkout is not registered with breakdown, when the breakdown server cannot be reached to check, when the item does not exist, or when any image path is missing or not an image.

#### Scenario: First request

- **WHEN** an agent in the tides checkout runs `review-request tides-abc --summary 'board header' a.png b.png`
- **THEN** a review bead under `tides-abc` holds both images under `~/.local/share/breakdown/reviews/tides/<bead-id>/`, Chrome opens `/board?project=tides&item=<bead-id>`, and the agent is told the bead id and to end its turn

#### Scenario: Re-request after changes

- **WHEN** the agent runs `review-request tides-abc` again while that review is open with `review:changes`
- **THEN** the same bead now holds only the new images, the `review:changes` label is gone, and a comment records the update

#### Scenario: Unregistered checkout

- **WHEN** the command runs in a checkout no project is registered for
- **THEN** it exits non-zero naming the checkout and how to register it, and no bead or file is created

#### Scenario: Missing image

- **WHEN** one of the image paths does not exist
- **THEN** it exits non-zero naming that path, and no bead or file is created

### Requirement: Review data reaches the store with the bead

Loading a tracker SHALL carry a review bead's `review` metadata and its comment thread (author, text, time, oldest first) onto its work item, so that a new comment or a changed screenshot list is a change to the item. Items that are not reviews SHALL load exactly as before. Malformed review metadata SHALL NOT refuse the load; the item SHALL load with its review marked invalid.

#### Scenario: Review bead with images and comments

- **WHEN** a tracker holding a review bead with two images and three comments is loaded
- **THEN** the work item carries the two image paths, the pane, the summary, and the three comments in order

#### Scenario: Comment added

- **WHEN** a comment is added to a review bead and the tracker is re-loaded
- **THEN** the item is reported updated and the board is told it changed

#### Scenario: Plain bead unchanged

- **WHEN** a tracker with no review beads is re-loaded after this change
- **THEN** every item's stored metadata is what it was before

### Requirement: The drawer shows a review and takes the decision

On the board, a review item's drawer SHALL show its summary, every screenshot as a thumbnail that enlarges on activation, its comment thread, and Accept and Request changes actions with a message box. Request changes SHALL require a message; Accept SHALL allow an empty one. A decision SHALL be written to the item's tracker in its registered checkout, and the board SHALL reflect it without a reload. A failed write SHALL show the tracker's error in the drawer and SHALL leave the message in the box. A closed review SHALL show its thread and outcome without the actions. A screenshot that cannot be served SHALL show as missing, naming its path, without hiding the rest.

#### Scenario: Accept

- **WHEN** a person accepts a review with the message "looks right"
- **THEN** the review bead gains a comment containing "looks right", is closed, and the card moves to Closed without a reload

#### Scenario: Request changes

- **WHEN** a person requests changes with "header overlaps on narrow widths"
- **THEN** the review bead gains that comment and the label `review:changes`, and stays open

#### Scenario: Tracker write fails

- **WHEN** the tracker refuses the write
- **THEN** the drawer shows the tracker's error and the message is still in the box

### Requirement: The requesting agent is told the decision

After a decision is fully written, the agent pane recorded on the tracker's record of the review SHALL receive, through the herdr server socket recorded with it, the prompt `Review <bead-id> accepted: <message>` (`Review <bead-id> accepted.` when an accept carries no message) or `Review <bead-id> changes requested: <message>`. When the review has no pane or no recorded socket, or the decision was not fully written, no pane SHALL be prompted. Each of these, and a pane that is gone or refuses the prompt, SHALL be logged and SHALL NOT fail or undo the decision; the comment in the tracker remains the record. The drawer SHALL say, before deciding, which pane the decision will reach, and after, whether the agent was notified and why not when it was not.

#### Scenario: Agent is waiting

- **WHEN** a person requests changes on a review whose pane is live
- **THEN** that pane receives `Review <bead-id> changes requested: <message>` and the drawer says the agent was notified

#### Scenario: Pane is gone

- **WHEN** a person accepts a review whose pane no longer exists
- **THEN** the review is still closed with its comment, and the drawer says the agent could not be notified and why

#### Scenario: Accept with no message

- **WHEN** a person accepts a review whose pane is live without typing a message
- **THEN** that pane receives `Review <bead-id> accepted.`

#### Scenario: Session unknown

- **WHEN** a person decides a review that records a pane but no herdr socket
- **THEN** no pane is prompted, the decision is still written, and the drawer says the pane's herdr session is unknown
