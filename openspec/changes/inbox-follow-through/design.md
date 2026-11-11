## Context

`decideInboxItem` records accept / changes / dismiss and moves the item to the next turn. The `changes` turn belongs to an agent: `inbox-watch` runs `inbox-ingest` step 5, which rewrites the item and always writes `pending`. Session-owned items (`pane`) are prompted instead, with "Revise the draft and re-queue it". Either way the person's note produces a new card.

The store is durable. `carryForwardInboxDecisions` keeps the person's settled status and feedback across re-ingests, and every change appends a revision. What's missing is a relation from an inbox item to the work it concerns. The only edges out of an inbox item are Fathom `child_of` batch links. Upstream, a review is a `work_item` labelled `review`, so its history is the work item's.

## Goals / Non-Goals

**Goals:**
- A note that fully specifies the outcome is carried out without a second card.
- The primary action needs no choice between "approve" and "request changes".
- An agent writing an inbox item can see what the person already decided about the same work, whichever source the earlier decision came from.
- A signal on settled work is kept and not shown, unless it changes a decision.

**Non-Goals:**
- Changing board reviews (`ReviewItemPanel`, `reviewDecision`). The footer mode is opt-in per host.
- Classifying notes in the app. The app makes no model call. Triage is an agent step, like revise is today.
- Perfect matching of signals to work. The person corrects a wrong match from the card.

## Decisions

### 1. Keep `changes` as the stored decision; change what the agent does with it

The footer's typed-note action writes `decision: "changes"`, so status `changes` is the agent's turn, exactly as today. No new status, no migration, and older feedback entries mean the same thing. Only the label changes ("Send to agent") and what the agent does on that turn.

*Alternative:* a new `feedback` decision and status. Rejected. It means the same as `changes` with a different name, and every reader (watcher, executor, notify text, tabs) would need a second case.

### 2. The primary button follows the note box, in an opt-in footer mode

`DecisionFooter` gains `noteSendsToAgent`. With it, a plain item shows one primary button: **Accept** while the box is empty, **Send to agent** once it holds a non-blank note. Ctrl/Cmd+Enter does the same thing. Shift is no longer needed, though Ctrl/Cmd+Shift+Enter still sends a typed note so muscle memory works. A card's option buttons keep their current behaviour: choosing one is an accept of that option, with the note attached. Without the mode, the footer is unchanged, so the board drawer and Review all do not move.

Accept with a note on a plain item goes away in this mode. That is intended: typed direction always gets triaged. Triage finishes the work in one pass when the note agrees with the draft.

*Alternative:* keep both buttons and relabel. Rejected. The person said the split carries no meaning, and 48 of 96 accepts already carry notes.

### 3. Triage outcomes and the re-queue rule

On a `changes` item the agent reads the latest feedback message and picks exactly one outcome:

| Outcome | When | Write |
|---|---|---|
| close | The note says it is done, handled, not theirs, or no action | `status: "done"`, `close_reason: <the note, quoted>`, `**Closed:** …` at the top of `content` |
| act | The note fully specifies what to do, and what goes out is the reviewed draft with at most edits the note spelled out | Carry it out (as inbox-execute step 3), then `status: "done"`, `**Done:** <what, with link>` |
| re-queue | The note asks for new work the person must see first (read and propose, rewrite, a new outbound text), or the agent is unsure | `status: "pending"`, `revision: <one line: what changed>`, content rewritten |

The line between act and re-queue is outbound text the person has not read. It mirrors the inbox's reason to exist: nothing goes out under the person's name unseen. Unsure always means re-queue, so the failure mode is today's behaviour, never a surprise send.

Triage lives in `inbox-execute` as a second section, since "act" is execution. The watcher's `changes` prompt and `inbox-ingest` step 5 both point to it. A session-owned item gets the same three-way instruction in `inboxNotifyText`.

### 4. `revision` and `close_reason` are contract keys

`normalizeInboxItemMetadata` accepts `revision` (≤200 chars, one line) and `close_reason` (≤500 chars), both optional strings. The detail pane shows `revision` above the content while the item is pending. A new decision on the item clears it, the same way a decision clears `needs_you`. `close_reason` is shown on closed items. Both are written by agents. The server only shapes them.

### 5. Dismiss carries the note

Every Dismiss button and the `d` key pass the current message. Empty stays empty. No server change: `decideInboxItem` already records `message` on dismiss.

### 6. Work context: open decisions for review

These two shape everything in part 2, and each has more than one sensible answer. Recommendations first.

**Open decision 1: what an inbox item links to.** *Resolved 2026-11-10: A (a native `work_item` in this store), accepted in the inbox.*
- **(A, recommended) A native `work_item` node in this store**, created or found by the ingest, carrying a `project` key (`vendor-rfi`, `store-tv-wall`). It reuses the work-items contract, `child_of`, readiness and the board as they are. It's the same shape upstream uses, so reviews and inbox items converge later. Cost: the ingest now owns a second kind of node and has to avoid creating duplicates.
- **(B) The Asana task as the anchor.** Mirror Asana tasks as `work_item` nodes (`source_system: asana`) and link to those. There's no second source of truth for work that's already tracked. But Vendor RFI's Slack threads and session items have no task, so a fallback is needed anyway, and it ties the model to one tool.
- **(C) A lightweight `topic` node**: title, decisions, no lifecycle. The fastest to build, but it diverges from upstream, and the convergence the person asked for doesn't happen.

**Open decision 2: how a signal is matched to work.** *Resolved 2026-11-10: A (the agent matches, the card shows it), accepted in the inbox.*
- **(A, recommended) The agent matches, and the card shows it.** The ingest searches the store (`brain_search` on title, people and links) and links with `about` at a confidence weight. The card shows "About: Vendor RFI" with a one-click "not this" that removes the edge. A low-confidence match or no match creates a new work context. That catches cross-source work like Slack ↔ Asana, at the cost of some wrong links the person fixes.
- **(B) Only explicit links match.** A signal is linked only when it contains a URL or key already on a work context (an Asana task URL in a Slack message, a PR number). It's never wrong, but it misses most of the Vendor RFI case: Slack threads about the RFI that don't link the task.

Decisions 7 and 8 assume A/A. They change if the review picks otherwise.

### 7. Settled-work signals go to history unless they change a decision

The ingest reads the matched work context's decisions (decision 8). A new signal that's consistent with them is written as a `signal` entry on the work context (title, link, one-line gist) and not as an inbox item. Examples: a thread confirming what was decided, or a reply already handled. A signal that contradicts or reopens a decision becomes an inbox item whose content starts with "**Changes:** <decision, date>". That also covers #930: new activity on a closed item reaches the person only when it's new.

### 8. Decisions are recorded on the work context

Each close, act, or accept with a note appends `{ at, decision, note, item }` to the work context's `decisions` metadata. The agent doing the triage or execution writes it, and the list is capped at the last 50. The ingest reads it before writing any item linked to that context.

### 9. Needs me groups by work context

The inbox query returns each pending item's `about` target, if it has one. The client groups pending items that share a target under one row, titled with the work context and listing its items, the way a Fathom batch lists its candidates. Items without a target stay flat.

## Risks / Trade-offs

- **The agent acts on a note it misread** and sends something. Mitigation: act is limited to the reviewed draft plus edits the note spelled out, and unsure means re-queue. The `**Done:**` line and the revision history show what happened.
- **Triage adds a hop before close.** A close note still waits for the watcher (about 30 s). Acceptable: no person attention is spent, which is the point.
- **Wrong work matches hide a real signal in history** (decision 7). Mitigation: history entries are listed on the work context, and a signal that names the person directly or asks a question always becomes a card, whatever the match.
- **Duplicate work contexts** from loose matching. Mitigation: `brain_merge` exists for this, and the ingest reports new work contexts in its counts so the person can spot duplicates.

## Migration Plan

Part 1 needs no data migration. Rollback is reverting the commits: `revision` and `close_reason` are ignored by older code.

Part 2 adds edges and work-context nodes going forward. Existing items stay ungrouped until an ingest touches them. Backfilling the 521 existing items is a separate, optional ingest pass the person can ask for.

## Open Questions

- None. Open decisions 1 and 2 are both resolved: A and A.
