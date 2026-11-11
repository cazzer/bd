# Design

## Context

There are two decision surfaces today.

1. **The board's review panel** (`ReviewItemPanel.tsx`, about 1,100 lines).
   - It reads one bead through `boardItem` and decides through `reviewDecision`, which writes the tracker and notifies the requesting agent's pane.
   - It already separates the card body (`ReviewCardBody.tsx`: question, options, on-accept, evidence) from its decision footer (`DecisionFooter`, `OptionAction`, `ChooseAnother`).
   - The footer still talks to `reviewDecision` directly.
2. **The inbox** (`InboxView.tsx`).
   - It reads `inbox_item` nodes through `inbox` and decides through `inboxDecision` (accept / changes / dismiss).
   - It renders the item's content with `EvidenceView` and has its own session buttons.

The card's data shape (`CardLike` in `lib/reviewCard.ts`) is already structural: question, options, recommend. The core normalizer (`normalizeCard` in `packages/core/src/reviews.ts`) is private to `normalizeReviewMetadata`.

The shell already reads the review queue for every registered project (`ReviewQueueProvider`, live over SSE). The inbox polls `inbox` every 15 s.

## Goals / Non-Goals

**Goals:**
- One card component and one set of decision actions, with each queue's write kept as is.
- Inbox items can carry a card, and an accept can name an option.
- Needs me shows both queues.

**Non-Goals:**
- Merging the stores or the decision endpoints.
- Changing the board, the drawer, the pill, or Review all.
- Attachments (images, mermaid, diff) on inbox cards. The inbox's evidence is its markdown content, which `EvidenceView` already renders with diagrams and diffs.
- A server-side merged endpoint. The client merges two reads it already makes.

## Decisions

### 1. Share the normalizer, not a copy

Export core's card normalizer as `normalizeDecisionCard(raw) → Card | null | invalid`. `normalizeReviewMetadata` and `normalizeInboxItemMetadata` both call it.

The inbox treats an invalid card as an invalid item: the batch is refused, naming the field. This matches the inbox's other fields. Reviews keep storing it as an invalid review, because a tracker load must never fail.

*Alternative:* copy the rules into `inbox.ts`. Rejected because the 140-character question limit and the option id pattern would drift.

### 2. The option goes in the feedback entry

`InboxFeedback` gains `option?: string`. `decideInboxItem` takes `option` and, under the row lock it already takes, checks it against the stored card:
- The stored card has options and none was named: refused ("choose an option").
- An option was named that the card doesn't offer: refused ("the card changed").

This is the same rule `reviewDecision` applies to the tracker's record. `inbox-execute` reads the newest accepted entry's option.

*Alternative:* a `seen` snapshot as reviews send. Deferred, because the option-id check already catches the case that matters (the agent revised the options).

### 3. `DecisionCard` takes a decider, not a queue

Extract from ReviewItemPanel a `DecisionCard` component. Props:
- `card`: `CardLike` plus `onAccept` and `evidence`;
- `decide(decision, { option, message }) → Promise<Outcome>`;
- `extraActions`;
- `sessionLinks`;
- `shortcuts`.

ReviewItemPanel keeps its reading, refusal, and notification logic and passes a `decide` that calls `reviewDecision`. InboxView passes one that calls `inboxDecision` and adds Dismiss through `extraActions`. The "card moved" text and recovery (`isCardMovedRefusal`) apply to both, because the inbox refusal uses the same wording.

*Alternative:* render ReviewItemPanel for inbox items through an adapter that fakes a `BoardItem`. Rejected because the panel's header (bead id, parent, chips, graph link) and thread are bead-shaped. Faking them would leak.

### 4. Merge Needs me in the client, from reads already made

InboxView reads the review queue from `ReviewQueueContext`, which the shell keeps live. It merges those rows with the pending inbox items:
- Rows are typed `{ kind: "inbox" | "review" }`.
- They are sorted by priority, then age.
- A source filter (chips: All, Reviews, then the inbox sources present) is held in the URL (`?source=`), like `item`.

Picking a review sets `?item=<project>/<bead>`. The detail pane then renders `ReviewItemPanel` with `compactHeader` and `showGraphLink`, sharing the shell's draft map.

*Alternative:* a server `needsMe` query joining both. Rejected for this slice because both reads already exist and one is live. A server join would add a third poller.

### 5. One `SessionLinks` with per-kind mutations

`ReviewSessionLinks` becomes `SessionLinks({ canFocus, focus(), open() })`, with the same text and status line. The review panel passes `reviewSession` calls and the inbox passes `inboxFocusSession` / `inboxOpenSession`. Inbox labels follow the review ones: "Go to session" for an item already in a session, "Talk it through ↗" to open one.

### 6. Digestion is a declared `read` list, checked structurally

`normalizeInboxItemMetadata` normalizes `read`. The status decision lives in the upsert path that already sets `pending` for new items (`carryForwardInboxDecisions`):
- A new item, or a stored `undigested` one, whose `url` is not covered by `read` is written as `undigested`.
- A stored `undigested` item that is now covered becomes `pending`.
- Any other stored status is carried forward as today.

"Covered" means a `ref` equals the `url` or starts with it. That way a PR's `/files` or a doc's `#heading` counts as the artifact.

`undigested` joins `INBOX_STATUSES`. It is not in `OPEN_INBOX_STATUSES` for counting, and it gets its own tab after Needs me. `release` joins the feedback kinds: a human run sets `pending` and records the entry, under the same row lock `decideInboxItem` takes.

The server checks only that a read was declared. Whether the reading was any good stays between the person and the agent, through Request changes. That is the rule for an app with no model call.

*Alternative:* a `digested: true` flag. Rejected because one boolean is trivially set. A list of refs names what was opened, can be checked against `url`, and shows up in the item's context.

*Alternative:* scan the content for "haven't read". Rejected (see the proposal).

`bin/inbox request` gains `--read 'full|<ref>'`. The `inbox-queue` skill (outside the repo, `~/.claude/skills/inbox-queue`) is updated to pass it, so session-queued items are held too.

### 7. Upstream split

`DecisionCard`, `SessionLinks`, and the exported normalizer touch only upstream code. They land as their own commits first, so they can be offered upstream without the inbox. Everything inbox-shaped comes after.

## Risks / Trade-offs

- **The ReviewItemPanel extraction regresses the drawer or Review all** (keys, arming delay, hint portal). → Mitigation: keep `ReviewItemPanel.test.ts` and `ReviewRunModal.test.ts` green unchanged before the inbox uses the component. Re-check the drawer and the run live.
- **The two reads update at different speeds** (reviews live, inbox every 15 s), so the merged list can reorder under the cursor. → Mitigation: keep the selected id stable across reads, as the inbox already does, and never move the cursor on a poll.
- **Agents game `read`** by listing the URL without opening it. → Mitigation: the skill says to list only what was opened, and the person still sees the context. A thin context is a Request changes away. The check stops honest omissions, not dishonesty, and the honest omissions are what the 11/6 inbox shows.
- **Items with a `url` that can't be read** (a paywalled doc, an attachment) are held forever. → Mitigation: the agent lists it at depth `skimmed` with what it could see, or the person releases the item by hand.
- **Agents writing cards for every inbox item** would add noise. → Mitigation: the `inbox-ingest` skill asks for a card only for batches and multi-way choices. A reply draft stays a plain item with Accept.

## Migration Plan

No data migration. Existing inbox items have no card and read as question-only. Rollback is reverting the commits. Feedback entries with `option` are ignored by older code.
