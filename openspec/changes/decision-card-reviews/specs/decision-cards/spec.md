## Purpose

Lets an agent ask a person for any human-in-the-loop decision — visual, architectural, or operational — as a card the person can answer quickly: the question first, the recommended option visible at once, the evidence one expand away, and an answer that names the option chosen. Narrows `board-reviews` (board-visual-reviews) and `review-queue` (review-queue).

## ADDED Requirements

### Requirement: A review may carry a decision card

A review's `review` metadata SHALL accept, beside `images`, `pane`, `socket`, and `summary`, a decision card: `question` (decision-shaped text of at most 140 characters), `options` (an optional list of 2 to 6 entries, each with a unique `id`, a `label`, and optional `what` and `risk`), `recommend` (the id of one of the options; allowed only with options), `on_accept` (an optional list of at most 8 short steps the agent will take on acceptance), and `attachments` (an optional list of at most 20 entries, each of kind `image` with an absolute `path`, or of kind `mermaid` or `diff` with a text `source`, each with an optional `caption` and an optional `pair` of `before` or `after`). The contract SHALL be applied by one normalizer at every writer, never by the database. A card that breaks the contract SHALL be stored as an invalid review rather than failing the tracker's load, and the normalizer SHALL be idempotent. A review without a card (`images` and `summary` only) SHALL normalize exactly as before and SHALL read as a question-only card whose question is the summary's first line.

#### Scenario: Card with options

- **WHEN** a review bead's metadata holds a question, options A, B, and C, `recommend: A`, two on-accept steps, and a mermaid attachment
- **THEN** the review's work item carries all of them as written, and the review queue lists it by its question

#### Scenario: Recommendation names no option

- **WHEN** a review bead's card recommends `D` but its options are A, B, and C
- **THEN** the tracker still loads, the review is stored as invalid, and the drawer says the review could not be read

#### Scenario: Legacy review

- **WHEN** a review bead's metadata holds only `images` and `summary`, as filed before this change
- **THEN** it loads unchanged, shows its summary first and its images, and is decided as before

### Requirement: The evidence is markdown in the bead description

A card's evidence SHALL be the review bead's description, rendered in the drawer and the run by the app's read-only markdown renderer, including GFM tables, a fenced `mermaid` block drawn as a diagram, and a fenced `diff` block shown with added and removed lines distinguished. Diagram rendering SHALL be loaded only when a review needs it. A diagram whose source does not parse SHALL show its source and the parse error, never a blank space. Rendering SHALL keep the renderer's existing safety: no raw HTML, script, or markup string from the evidence or a diagram source executes.

#### Scenario: Tables and a diagram

- **WHEN** a person opens a card whose evidence holds two tables and a `mermaid` ER diagram
- **THEN** both tables render as tables and the diagram renders as a diagram, and the diagram code was fetched only when this card was opened

#### Scenario: Broken diagram

- **WHEN** a card's mermaid source has a syntax error
- **THEN** the drawer shows the source as text with the error, and the rest of the card renders

### Requirement: An agent requests a card with one markdown file

`review-request <item-id> <card.md>` SHALL read one markdown file whose YAML frontmatter holds the card (`question`, `options`, `recommend`, `on_accept`, `attachments`) and whose body is the evidence, validate all of it before anything is filed, and file or reuse the review bead as the image form does, with the body as the bead description and image attachments copied into the review image root. Image attachment paths SHALL resolve relative to the card file. Images SHALL be optional. The command SHALL refuse, filing nothing, naming the offending field, when the frontmatter is missing or not valid YAML, the question is missing or longer than 140 characters, an option id repeats, `recommend` names no option, an attachment's kind is unknown, an image is missing or not an image, or the evidence body exceeds its length budget. `review-request <item-id> --summary <text> <image>...` SHALL keep working exactly as before, and SHALL never load the frontmatter parser.

#### Scenario: Architecture decision without images

- **WHEN** an agent runs `review-request shlo-k54.4.1 card.md` where the card asks a question, offers A/B/C with A recommended, and holds a migration `diff` and two tables in its body
- **THEN** a review bead is filed whose description is the body and whose metadata holds the card, with no images

#### Scenario: Question too long

- **WHEN** the card's question is 160 characters
- **THEN** the command refuses with a message naming `question` and its 140-character limit, and nothing is filed

#### Scenario: Old form

- **WHEN** an agent runs `review-request tides-abc --summary 'board header' a.png`
- **THEN** the review is filed exactly as before this change

### Requirement: The drawer and the run present the card for a quick decision

The drawer and the Review all run SHALL show, in this order, the card's question, the recommended option (its label, what, and risk) marked as recommended, the other options, the on-accept steps, the attachments, and the evidence. On a 1440 × 900 window the question, the recommended option, and the decision actions SHALL be visible without scrolling; the evidence SHALL start collapsed when the card has a question and options, and expand in place. A `before` attachment followed by an `after` attachment SHALL render side by side under their labels. The layout SHALL be chosen from 2–3 prototypes through a visual review before it is built.

#### Scenario: Opening a card

- **WHEN** a person opens the shlo card at 1440 × 900
- **THEN** the question, option A marked recommended with its risk, and the decision buttons are visible without scrolling, and the evidence is collapsed under a control that expands it

#### Scenario: Before and after

- **WHEN** a card has an image marked `before` followed by one marked `after`
- **THEN** they render side by side, labelled Before and After

### Requirement: A decision names the option chosen

For a card with options, the decision actions SHALL be "Accept <recommended label>", one "Choose <label>" for each other option, and "Request changes" (message required, as before). Accepting or choosing SHALL send the option id with the decision; the server SHALL refuse an option id the tracker's record of the review does not offer, and SHALL refuse an accept without an option for a card that has options. The tracker comment SHALL read `Accepted: <id> — <message>` (`Accepted: <id>.` with no message), the close reason `Review accepted: <id>`, and the agent's prompt `Review <bead-id> accepted: <id> — <message>` (`Review <bead-id> accepted: <id>.` with no message). A review without options SHALL be decided exactly as before.

#### Scenario: Choosing a non-recommended option

- **WHEN** a person presses "Choose B" on the shlo card with the message "skip the tracking migration"
- **THEN** the bead gets the comment `Accepted: B — skip the tracking migration` and closes, and the requesting pane is prompted `Review <bead-id> accepted: B — skip the tracking migration`

#### Scenario: Option not on the card

- **WHEN** a request accepts option `Z` for a card whose options are A, B, and C
- **THEN** the server refuses and nothing is written to the tracker

#### Scenario: Legacy review decided

- **WHEN** a person accepts an image-only review with no message
- **THEN** the comment is `Accepted.` and the prompt `Review <bead-id> accepted.`, as before
