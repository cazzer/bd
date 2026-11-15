## MODIFIED Requirements

### Requirement: A review is an ordinary bead that follows one convention

A review request SHALL be a beads issue of type `task`, labelled `review`, whose parent is the item under review, and whose beads metadata key `review` holds `images`, `pane` (the requester's herdr pane id, or absent), `socket` (the herdr server socket that pane id belongs to, or absent), and `summary` (what to look at). Each entry in `images` SHALL be either an absolute host path under the review image root (`~/.local/share/breakdown/reviews/<project>/<bead-id>/`, for a review filed against the local server) or a relative path `<project>/<item-id>/<run>/<NN-name>` (for one filed against a remote server, which resolves it against its media root). A relative path is `/`-joined segments that each start with a letter or digit and hold only letters, digits, `.`, `_`, and `-`. When the item under review is not an epic, it SHALL also depend on the review bead with a `blocks` dependency; an epic SHALL be gated by the parent link alone, because the tracker refuses to close an epic with an open child. A decision to accept SHALL add a comment and close the bead; a decision to request changes SHALL add a comment and the label `review:changes`, leaving the bead open.

#### Scenario: Epic under review

- **WHEN** a review is requested for an epic
- **THEN** the review bead is the epic's child, and the tracker refuses to close the epic until the review bead is closed

#### Scenario: Task under review

- **WHEN** a review is requested for a task
- **THEN** the review bead is the task's child and the task depends on it

#### Scenario: A remote-filed review renders

- **WHEN** a review records `images: ["bd/bd-1/0a1b2c3d4e5f/01-a.png"]` and the server's media root holds that file
- **THEN** the board shows the image from `/review-images/bd/bd-1/0a1b2c3d4e5f/01-a.png`

#### Scenario: A Mac-path review still renders

- **WHEN** a review filed before this change records `/Users/me/.local/share/breakdown/reviews/bd/bd-1.1/01-a.png`, and the container's media root was seeded from that directory
- **THEN** the board shows the image from `/review-images/bd/bd-1.1/01-a.png`

#### Scenario: A climbing relative path is invalid

- **WHEN** a review records `images: ["../a.png"]` or `images: ["a/../b.png"]`
- **THEN** the review normalizes to `{ invalid: true }`
