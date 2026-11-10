## Why

The inbox gets decisions in front of the person quickly. The step after the decision is still slow, and that is now the cost.

**The person's direction comes back to them as another card.** Of 21 items sent back with a note (store, 2026-11-10), 14 needed a second decision. Most of those notes were complete instructions already:
- "already sent a message, close this"
- "this is done, no action needed"
- "we caught up over the phone so no need to reply over email"
- "this question isn't addressed at me, ignore it and close this issue"

The revise step (`inbox-ingest` step 5) always rewrites the item and sets it back to `pending`. So "close this" comes back as a card titled "Close: …", and the person accepts their own instruction. Two of those were still waiting on 11/10.

**Accept and Request changes are the same gesture once a note is typed.** The person often types direction and presses Accept because they agree overall. 48 of 96 accepts carry a note. The executor applies an accept note, so that path mostly works. But the choice between the two buttons carries no meaning, and the person has to make it on every item.

**The inbox remembers artifacts, not work.** Each item is keyed on its source (`asana:task/…`, `slack:<channel>/<ts>`), and a re-ingest never reopens one the person closed. But no inbox item links to anything other than its Fathom batch: 521 items, 0 edges to a work item or project. One piece of work spans many keys. Vendor RFI is an Asana task, a doc comment, several Slack threads, and 17 session items. So:
- A new signal about settled work becomes a fresh card. The agent writing it has no way to see that the person already decided.
- A decision recorded on one card ("Sam already wrote this") never reaches the next agent that touches the same work from another source.
- New activity on a closed item gets written into it and is never seen (#930, 11/9).

Upstream, breakdown is a store of work items with reviews hanging off them. The inbox here is a separate pile of tickets about artifacts. This change makes it work the same way.

## What Changes

**Part 1: direction is acted on, not re-asked**
- **One primary button whose meaning follows the note box.** An empty box reads **Accept**. A typed note reads **Send to agent** and records the decision as `changes`, the agent's turn. Request changes is no longer a separate button on inbox items.
  - A card's option buttons are unchanged: choosing an option with a note is an accept of that option, and the note goes with it.
  - Dismiss keeps a typed note as its feedback message. Today every Dismiss button drops it.
- **The agent triages the note into one of three outcomes:**
  - **close:** the note says done, ignore, or no action. The item is written `done` with the note as its close reason.
  - **act:** the note fully specifies the outcome. The agent carries it out and writes the item `done`.
  - **re-queue:** the note asks for something the person has not seen. The agent writes the item back as `pending` with a one-line `revision`.
- **The rule for re-queue:** anything sent under the person's name that the person has not read comes back. A substantially rewritten reply, new review comments, or a new ticket body is re-queued. A small edit the note spelled out ("drop the last line", "send it to Robin instead") is acted on. When the agent is unsure, it re-queues.
- **The watcher triages.** `inbox-watch`'s `changes` run uses the new triage step instead of revise-only. A session that queued the item is told to triage, not "Revise the draft and re-queue".

**Part 2: inbox items hang off the work they are about**
- **An inbox item links to the work it is about** with an `about` edge to a work-context node. The kind of node is open decision 1 in the design.
- **The ingest matches before it writes.** Before writing an item, the agent looks for the work context the signal belongs to and reads its settled decisions. A signal on settled work is added to that work's history. It becomes a card only when it would change a recorded decision, and the card names which one.
- **Decisions are recorded on the work context.** A close, act, or accept with a note writes a one-line decision onto the work context's record. The next agent sees it from any source.
- **Needs me groups by work.** Items about the same work context show as one entry with its items under it, the same way a Fathom batch shows its candidates.

## Capabilities

### New Capabilities
- `inbox-feedback`: the note-dependent primary action, Dismiss keeping its note, and the agent's close / act / re-queue triage with its re-queue rule.
- `inbox-work-context`: the `about` link, match-before-write in the ingest, decisions recorded on the work context, settled-work signals going to history, and Needs me grouped by work.

### Modified Capabilities
- `decision-queue` (from `unify-review-queues`, not yet archived): an inbox card no longer shows Request changes beside Accept; the primary action follows the note box. Board reviews are unchanged.

## Impact

- `packages/core/src/inbox.ts`: `revision` and `close_reason` metadata keys; an `about` edge reader for grouping; no new status.
- `apps/web/src/components/DecisionCard.tsx`: a `noteSendsToAgent` footer mode (inbox only); `InboxView.tsx` passes it, and its Dismiss buttons and `d` key pass the message.
- `apps/web/server/routers/inbox.ts`: `inboxNotifyText` for `changes` tells the session to triage.
- `bin/inbox-watch`: the `changes` prompt runs the triage step.
- `.claude/skills/inbox-execute`, `.claude/skills/inbox-ingest`: the triage step, match-before-write, decision recording.
- `~/.claude/skills/inbox-queue` (outside the repo): the triage instructions for a session.
- No migration, no new dependency, no model call. Triage runs in the person's Claude session, the same way revise does today.
