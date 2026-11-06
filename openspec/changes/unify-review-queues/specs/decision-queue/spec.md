# Spec Delta

## Purpose

One place to see and decide everything waiting on the person. Inbox items and board reviews are shown and answered as the same decision card. Each one is still written back through its own queue.

## ADDED Requirements

### Requirement: An inbox item may carry a decision card

An inbox item's metadata SHALL accept the review decision card's `question`, `options`, `recommend`, and `on_accept` keys under the same rules and limits. Every writer of inbox items SHALL apply them through the normalizer the review card uses.

#### Scenario: Batch with options

- **WHEN** an agent writes an inbox item for a meeting's action items with options `track` and `ignore`, `recommend: ignore`, and two on-accept steps
- **THEN** the inbox serves the item with its question, both options, the recommendation, and the steps as written

### Requirement: An invalid inbox card is refused at write

An inbox item whose card breaks the card rules SHALL be refused, naming the item and the field, and its batch SHALL write nothing.

#### Scenario: Recommendation names no option

- **WHEN** an agent writes an inbox item whose card recommends `C`, but its options are `A` and `B`
- **THEN** the write is refused, naming the item and `recommend`, and nothing in that batch is written

### Requirement: An inbox item without a card reads as a question-only card

An inbox item with no card SHALL read as a card whose question is the item's title, with no options.

#### Scenario: Item written before this change

- **WHEN** the inbox serves an item written before this change
- **THEN** it shows the title as the question with Accept, Request changes, and Dismiss, as before

### Requirement: An inbox accept names an option when the card has options

An Accept of an inbox item whose card has options SHALL name one of them. The server SHALL record its id in the decision's feedback entry. An Accept of an item without options SHALL name none and SHALL be recorded as before.

#### Scenario: Choosing the non-recommended option

- **WHEN** the person chooses `track` on a card that recommends `ignore`
- **THEN** the item moves to accepted and its newest feedback entry holds `option: track`

### Requirement: An inbox accept naming an option the card does not offer is refused

The server SHALL refuse an inbox Accept, writing nothing, when the named option is not offered by the item's stored card. The refusal SHALL say the card changed.

#### Scenario: Card changed underneath

- **WHEN** the person accepts option `B`, but an agent has meanwhile rewritten the item with options `A` and `C`
- **THEN** nothing is written, the inbox says the card changed, and it shows the current card

### Requirement: Inbox items and reviews are presented through one card

The inbox detail pane and the board's review panel SHALL present a decision through the same card: the question, the options with the recommended one first, the on-accept steps, then the evidence. Both SHALL offer "Accept <recommended>", "Choose <other>" for each other option (or plain Accept without options), and Request changes with a required message, on the same keys.

#### Scenario: Same card, two sources

- **WHEN** the person opens an inbox item and a board review that carry the same question and options
- **THEN** both show the question, the options in the same order, and the same action labels

### Requirement: Each decision is written through its own queue

A decision on an inbox item SHALL be written through the inbox's decision, which also offers Dismiss. A decision on a review SHALL be written through the board's review decision, which notifies the requesting agent.

#### Scenario: Dismiss is inbox-only

- **WHEN** the person views a review and an inbox item
- **THEN** only the inbox item offers Dismiss

### Requirement: Needs me lists open reviews beside inbox items

The inbox's Needs me list SHALL hold the pending inbox items and the open reviews of every registered project, as the shell's review queue reads them. Each review SHALL be tagged with its project, and the list's count SHALL include the reviews.

#### Scenario: A review waits beside an email

- **WHEN** one email reply is pending in the inbox and one review is open on project `shlo`
- **THEN** Needs me lists both, with the review tagged `shlo`

### Requirement: Needs me can be filtered by source

A source filter SHALL narrow Needs me to one source: reviews, or one inbox source such as email. The filter SHALL be held in the address.

#### Scenario: Reviews only

- **WHEN** the person picks the Reviews filter with an email and a review pending
- **THEN** only the review is listed, and reloading the page keeps the filter

### Requirement: A review decided from the inbox behaves as from the drawer

Picking a review in Needs me SHALL open it in the inbox's detail pane. Deciding it there SHALL have the same effect as deciding it in the board's drawer, and the review SHALL leave the list on the next read. The board, its drawer, the review queue pill, and Review all SHALL be unchanged.

#### Scenario: Deciding a review from the inbox

- **WHEN** the person accepts a review's recommended option from the inbox
- **THEN** the tracker records the decision and the option, the requesting agent is notified, and the review leaves Needs me

### Requirement: Every card offers the same session links

Every card SHALL offer going to the requesting agent or session when one is recorded, and opening a new interactive session primed on the item. A terminal multiplexer failure SHALL be shown as one line on the card. Neither link SHALL write a decision.

#### Scenario: Talk it through from an inbox item

- **WHEN** the person opens a new session on an inbox item
- **THEN** a new tab opens with an agent primed on the item, and the item moves to "in your session" as it does today
