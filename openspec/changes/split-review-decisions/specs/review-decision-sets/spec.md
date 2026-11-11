## Purpose

Lets an agent ask several separate decisions about one item in one command, and lets the person see them together and answer each one on its own. Each decision is an ordinary review with its own Accept.

## ADDED Requirements

### Requirement: One command files one review per card

`review-request <item-id> <card.md>...` SHALL accept one to six card files, every positional after the item id ending in `.md`. It SHALL file or reuse one review under the item for each card, in the order given.
- Each review SHALL be a review as one card files it today: the card in its metadata, the body as its description, its images under the review image root, the caller's pane and socket, and a `blocks` edge on the item unless the item is an epic.
- The command SHALL show one herdr notification naming the item and the number of reviews, and open the board once.
- It SHALL print every review id with its key and its question, then tell the caller once to end its turn.
- Each review's decision SHALL reach the caller's pane on its own, as one review's does today.

#### Scenario: Four decisions for one epic

- **WHEN** an agent runs `review-request shlo-btp city.md budget.md logos.md gates.md`, each card holding one question with its options
- **THEN** four open reviews sit under `shlo-btp`, each with its own question, options, and Accept, and the agent sees one notification and one list of the four ids

#### Scenario: Accepting one of several

- **WHEN** the person accepts the `budget` review and leaves the other three open
- **THEN** the agent's pane receives one `Review <id> accepted: …` prompt for that review, and the other three stay open and blocking

### Requirement: A multi-card call validates everything before filing anything

The command SHALL validate every card and stage every image before it creates or changes any bead. It SHALL refuse, filing nothing and naming the card and the field, when:
- any card breaks the card rules;
- two cards in the call have the same key;
- more than six cards are given;
- a card file and an image path are mixed in one call.

When a bead write fails after other reviews in the call were filed, the command SHALL name the reviews it filed and the card it stopped at, exit non-zero, and say that re-running the same command reuses the filed reviews by key.

#### Scenario: One bad card among three

- **WHEN** an agent runs `review-request tides-abc a.md b.md c.md` and `b.md` recommends an option it doesn't offer
- **THEN** the command refuses naming `b.md` and `recommend`, and no review under `tides-abc` is created or changed

#### Scenario: Repeated key

- **WHEN** `a.md` and `b.md` both set `key: layout`
- **THEN** the command refuses naming both files and the key, and nothing is filed

#### Scenario: Failure partway

- **WHEN** the second of three `bd create` calls fails
- **THEN** the command names the first review as filed and the second card as where it stopped, and re-running the same command reuses the first review and files the other two

### Requirement: A card review is identified by its key

Every card SHALL have a key: its frontmatter `key`, else its filename stem lower-cased, with each run of characters outside `a-z`, `0-9`, `_`, `-` replaced by `-` and leading or trailing `-` removed. A key SHALL be 1 to 40 characters, start with a letter or digit, and hold only `a-z`, `0-9`, `_`, `-`. A card whose key can't be formed so SHALL be refused, naming the card and `key`. The review's metadata SHALL record the key.

For each card, the command SHALL reuse the open review under the item with the same key. When none has it:
- **Single-card call:** it SHALL reuse the newest open review that has no key, as today.
- **Multi-card call:** it SHALL file a new review, leave any keyless open review alone, and warn naming each keyless open review it left.

When several open reviews share a key, it SHALL reuse the newest and warn naming the count. Reuse SHALL behave as it does today: images, card, and description are replaced, the caller's pane is recorded, `review:changes` is removed, and a comment records the update.

#### Scenario: Re-request after changes on one of several

- **WHEN** the person sends the `logos` review back, and the agent runs `review-request shlo-btp logos.md` with a revised card
- **THEN** the `logos` review is updated in place and loses `review:changes`, and the other three reviews are untouched

#### Scenario: Review filed before this change

- **WHEN** `tides-abc` has one open review with no key and an agent runs `review-request tides-abc card.md`
- **THEN** that review is reused and now carries key `card`

#### Scenario: Multi-card call beside an old review

- **WHEN** `tides-abc` has one open keyless review and an agent runs `review-request tides-abc a.md b.md`
- **THEN** two new reviews keyed `a` and `b` are filed, the keyless review is unchanged, and the command warns naming it

### Requirement: The image form keeps its behavior

`review-request <item-id> --summary <text> <image>...` SHALL file and reuse exactly as before this change: it reuses the newest open review that has no key, writes no key, and never loads the frontmatter parser. A keyed review SHALL NOT be reused by the image form.

#### Scenario: Image form beside keyed reviews

- **WHEN** `tides-abc` has open reviews keyed `a` and `b` and no keyless one, and an agent runs `review-request tides-abc --summary 'header' shot.png`
- **THEN** a new keyless review is filed, and `a` and `b` are untouched

### Requirement: The review contract carries the key

A review's metadata SHALL accept an optional `key` under the key rules above. The key SHALL be absent when missing, null, or empty, and a stored key SHALL normalize to itself. A key that breaks the rules SHALL make the review invalid, as a bad option id does. A review without a key SHALL normalize exactly as it did before this change.

#### Scenario: Load of a keyed review

- **WHEN** the beads loader reads a review whose metadata holds `key: "budget"`
- **THEN** the stored review holds `key: "budget"`, and a reload reports it unchanged

#### Scenario: Malformed key

- **WHEN** a review's stored metadata holds `key: "Has Spaces"`
- **THEN** the review reads as invalid, and the item stays on the board and in the queue

### Requirement: A card review's title names its question

A review filed from a card SHALL be titled `Review: <question>`, cut to 120 characters. A reused card review's title SHALL be updated to its current question. A review filed by the image form SHALL keep its current title, `Review: <item title>`.

#### Scenario: Siblings on the board

- **WHEN** four card reviews are filed under `shlo-btp`
- **THEN** the board and `bd list` show four reviews, each titled with its own question

### Requirement: Pending reviews carry their parent work item

Each pending review row SHALL carry its parent: the `child_of` target one hop from the review, resolved as the board item read resolves its parent. That resolution folds through `merged_into`, keeps only a work item of the same project other than the review itself, and breaks ties by the heavier edge, then `beads`, then the lesser id. The row SHALL carry the parent's canonical node id, external id, and title, or null when the review has none. Reading the queue SHALL stay one statement.

#### Scenario: Review under an epic

- **WHEN** a pending review is a child of `shlo-btp`
- **THEN** its queue row carries `shlo-btp`'s node id, external id, and title

#### Scenario: Review without a parent

- **WHEN** a pending review has no `child_of` edge
- **THEN** its queue row carries a null parent, and it is listed as before

### Requirement: Needs me groups reviews by their parent work item

Needs me SHALL group a review row by its parent work item, using the same grouping it applies to inbox items `about` a work item. Rows with the same work item SHALL be grouped when there are two or more, whichever queue they come from. Each grouped row SHALL keep its own detail view and decision. The source filter SHALL apply before grouping, as it does today.

#### Scenario: Three reviews under one epic

- **WHEN** three pending reviews are children of `shlo-btp`
- **THEN** Needs me shows them together under `shlo-btp`'s title, and each opens and is decided on its own

#### Scenario: Review and inbox item about the same work

- **WHEN** one pending review is a child of work item `W`, and one pending inbox item is `about` `W`
- **THEN** Needs me shows the two together under `W`'s title

### Requirement: The command steers agents toward one decision per card

`review-request` usage, printed for `--help` and on an argument error, SHALL show the card form, with several cards, before the image form. It SHALL state that a card holds one decision, that several decisions are several cards in one call, and that text, tables, and code belong in the card rather than in an image.

The refusals for a question over 140 characters and for an evidence body over its 300-word budget SHALL keep their current content. They SHALL add that several decisions belong in several cards, with the command line for that. The image form's warning for a summary over 280 characters SHALL point to the card form with several cards.

The command SHALL NOT refuse or warn based on the wording of a summary or question, or on image filenames.

#### Scenario: Body over budget

- **WHEN** a card's body holds 450 words outside its fenced blocks
- **THEN** the refusal names the 300-word budget and the count, and adds `several decisions? one card each: review-request <item-id> a.md b.md …`

#### Scenario: Help

- **WHEN** an agent runs `review-request --help`
- **THEN** the first usage line is the card form with several cards, and the text says one decision per card and no images of text
