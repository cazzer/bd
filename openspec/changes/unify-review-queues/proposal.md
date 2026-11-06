## Why

There are two places where a person decides what an agent proposed. The board's review drawer and the Review all run (decision-card-reviews) show a decision card: the question, the options with the recommended one first, the on-accept steps, and the evidence. Accepting names the option chosen. The inbox (`inbox_item` nodes, InboxView) shows a title, the proposed action as markdown, and Accept / Request changes / Dismiss.

So the same kind of decision looks and behaves differently depending on where it came from:
- An inbox batch ("6 Fathom action items, ignore 4") can't say which option the person picked. The executor re-reads the prose to guess.
- A review waiting on the person doesn't appear in the inbox at all. "What needs me" has two answers.

Both queues are now in daily use, so the gap costs time on every decision.

There is a second problem. Items reach the inbox before the agent has read the thing they are about. Of 98 open items on 2026-11-06:
- "Review #971 … I haven't read the diff."
- "Review the draft travel policy … **I haven't read it.**"
- Three Fathom items say "No transcript fetched" or "I didn't fetch the transcript".

The person then does the reading the agent skipped, which defeats the queue. Only digested items should be loaded into it. A digested item is one whose agent opened the primary artifact and wrote what it found.

## What Changes

- **Inbox items may carry a decision card.** An inbox item's metadata gains the same `question`, `options`, `recommend`, and `on_accept` keys a review card has, under the same limits.
  - The card is normalized by the review card normalizer, shared rather than copied.
  - An item without a card reads as a question-only card whose question is its title, exactly as a legacy review does.
- **An inbox Accept may name an option.**
  - `inboxDecision` takes an optional `option`. The server refuses it (nothing written) when the stored card does not offer that option.
  - The feedback entry records the option, so `inbox-execute` acts on the chosen option and doesn't re-read prose.
- **One card UI.** The card body and decision footer the review panel draws become one source-agnostic component.
  - The review panel and the inbox detail pane both render through it.
  - Each host supplies its own decision write and its own extra actions (Dismiss for the inbox).
- **One "Needs me" list.**
  - The inbox's Needs me tab also lists the open board reviews the shell's review queue already reads, tagged with their project.
  - A source filter narrows the list to one source.
  - Picking a review opens it in the inbox's detail pane through the review panel, deciding through `reviewDecision` as the drawer does.
  - The board, its drawer, the review pill, and Review all are unchanged.
- **One pair of session links.** "Go to agent / Go to session" and "Talk it through / Open session" render through one component on both kinds of item. Each kind keeps its own server mutation.
- **Only digested items reach Needs me.**
  - An inbox item's metadata gains `read`: the artifacts the agent actually opened. Each entry is a `{ ref, depth }` pair, where `depth` is `full` or `skimmed`.
  - An item with a primary `url` that is missing from `read` is stored with a new status, `undigested`, instead of `pending`. The person never sees it in Needs me.
  - The same applies to every writer: `brain_write`, `inbox request` from a session, and the ingest skill.
  - The ingest skill picks `undigested` items up on its next pass. It reads the artifact (fetches the transcript, reads the diff), rewrites the context, and only then writes the item as `pending`.
  - The server cannot judge whether the reading was good; this app makes no model call. What the server enforces is that the agent declared what it opened, so skipping the read becomes a visible omission rather than a silent one.
  - Existing items are left as they are. A one-off pass by the ingest skill re-digests the open ones that say they skipped the read.
- The `inbox-ingest` skill writes a card for a batch or a multi-way choice, and digests before it writes. The `inbox-execute` skill reads the chosen option from the feedback.

Rejected:
- **One store**, either moving reviews into `inbox_item` or the inbox into beads. Beads is the work of record, and a review's notification goes to the requesting agent's pane. Triaged email and meeting notes don't belong in the issue tracker. The split is real; only the presentation was duplicated.
- **Folding the inbox into the Review all modal.** The modal is a timed run over one project's reviews. The inbox is a persistent list with history and statuses (with agent, closed) that the run has no place for.
- **A second card normalizer for the inbox.** Two copies of the card rules drift.
- **Refusing undigested items outright.** The signal would be lost: an email that needs a reply still needs one even if the agent could not open the attachment. Holding the item out of Needs me keeps the signal and keeps it off the person's desk.
- **Rejecting phrases like "I haven't read" at write time.** That is brittle, and it teaches agents to stop admitting it. The declared `read` list is checkable; prose is not.

## Capabilities

### New Capabilities
- `decision-queue`: one place to see and decide everything waiting on the person. It covers:
  - the inbox item's card;
  - an inbox decision that names an option;
  - the merged Needs me list with its source filter;
  - deciding a review from the inbox;
  - the shared session links.

  It builds on `decision-cards` (decision-card-reviews) and `review-sessions`, both unarchived.
- `inbox-digestion`: what an inbox item must declare about what its agent read, and the `undigested` hold for an item that skipped its primary artifact.

### Modified Capabilities
None in `openspec/specs/`. The review and inbox requirements this change builds on still live in unarchived changes, and the inbox has no change of its own yet.

## Impact

- **Core:**
  - `packages/core/src/reviews.ts` exports the card normalizer.
  - `packages/core/src/inbox.ts` gives the item a card, lets a decision name an option, and adds `read` and the `undigested` status, with tests.
- **CLI:** `bin/inbox request` gains `--read '<depth>|<ref>'`, repeatable.
- **Server:** `apps/web/server/routers/inbox.ts` (`inboxDecision` takes `option`) and `dto` (the inbox item carries its card).
- **Web, new:** `DecisionCard` and `SessionLinks`, extracted from ReviewItemPanel and ReviewSessionLinks.
- **Web, changed:** `ReviewItemPanel.tsx` and `InboxView.tsx` render through them; `InboxView.tsx` also gets the merged list and the filter.
- **Skills:** `.claude/skills/inbox-ingest` and `inbox-execute`.
- **What doesn't change:** no migration, environment variable, model call, or new dependency, and `node_type` is unchanged.
- **Upstream:** the extraction (`DecisionCard`, `SessionLinks`) is upstreamable on its own. The inbox parts stay in this fork with the inbox.
