## ADDED Requirements

### Requirement: Go to the requesting agent from a review

An open review whose requester recorded a herdr pane and session SHALL offer a control that brings that pane's tab to the front in herdr, using the review's recorded socket, without writing to the tracker or the store. When the pane no longer exists, the drawer SHALL say so in one line and nothing else SHALL change. A review without a recorded pane and session SHALL NOT offer the control, and a request for it SHALL be refused before any command runs.

#### Scenario: Requester still running

- **WHEN** a person opens review `bd-4zn.2`, filed from pane `w1:p2`, and chooses "Go to agent"
- **THEN** herdr focuses the tab holding `w1:p2`, and the review stays open and undecided

#### Scenario: Requester gone

- **WHEN** the pane closed after the review was filed and the person chooses "Go to agent"
- **THEN** the drawer shows herdr's reason (the pane was not found), and no command other than the lookup ran

### Requirement: Open an interactive session on a review

An open review SHALL offer a control that opens a new tab in a herdr workspace labelled `reviews` (created when absent), in the project's registered checkout, starts Claude in it, and gives it an opening prompt holding the card's question, its options with the recommendation marked, its on-accept steps, the evidence cut at 4,000 characters, and the bead id. The prompt SHALL tell the agent not to decide the review or comment on it. The request SHALL write nothing to the tracker or the store, SHALL be refused on a read-only server or when no herdr session is known, and SHALL close the tab it opened when the agent cannot start. A failure inside herdr SHALL be reported as data, not as a server error.

#### Scenario: Talking a card through

- **WHEN** a person chooses "Talk it through" on a card asking "Which migration?" with options A (recommended) and B
- **THEN** a new tab titled with the bead id opens in the `reviews` workspace in the project's checkout, and its agent's first prompt lists A as recommended and B, and says the decision is made in the board

#### Scenario: Agent won't start

- **WHEN** herdr cannot start the agent in the new tab
- **THEN** the tab is closed, and the drawer shows the reason
