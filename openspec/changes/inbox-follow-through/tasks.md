# Tasks

## 1. Contract: revision and close reason

- [x] 1.1 `normalizeInboxItemMetadata` accepts `revision` (one line, ≤200) and `close_reason` (≤500); refuses wrong type or length, naming item and field
- [x] 1.2 `decideInboxItem` removes `revision` on any person decision, alongside `needs_you`
- [x] 1.3 Serve both through the inbox dto
- [x] 1.4 Core and router tests: accepted, refused, cleared on decide

## 2. Footer: primary action follows the note box

- [x] 2.1 `DecisionFooter` `noteSendsToAgent` mode: one primary button, Accept when blank, Send to agent (`changes`) when typed; card option buttons unchanged and carry the note
- [x] 2.2 `cardShortcut` in that mode: Ctrl/Cmd+Enter takes the primary action; Shift variant still sends a typed note
- [x] 2.3 `InboxView` passes the mode; every Dismiss control and the `d` key pass the message
- [x] 2.4 Detail pane shows `revision` (pending) and `close_reason` (closed)
- [x] 2.5 Tests: blank → accept, typed → changes, shortcut follows the note (`DecisionFooter.test.ts`); `ReviewItemPanel.test.ts` and `ReviewRunModal.test.ts` unchanged and green
- [ ] 2.6 InboxView tests for option + note and dismiss keeping the note (no InboxView test harness exists yet; covered by code reading only)

## 3. Triage

- [x] 3.1 `inbox-execute` skill: a Triage section (close / act / re-queue, the outbound-text rule, unsure means re-queue)
- [x] 3.2 `inbox-ingest` step 5 points to the triage; `bin/inbox-watch` `changes` prompt runs it
- [x] 3.3 `inboxNotifyText` for `changes`: the three outcomes, `inbox done` for close/act, same `--key` for re-queue; router test updated
- [x] 3.4 `~/.claude/skills/inbox-queue`: same triage on a `[inbox]` changes prompt
- [x] 3.5 `pnpm check` green (1621 vitest + 124 node); live check through the watcher: close and re-queue verified 11/10
- [ ] 3.6 Live check of the act outcome (not run: it needs a real outbound send)

## 4. Work context (open decisions 1 and 2 resolved: A and A)

- [x] 4.1 `about` edge type; the inbox read returns each item's target folded through `merged_into`
- [x] 4.2 Unlink procedure removing an item's `about` edge; detail pane shows the work context with "not this"
- [x] 4.3 Work-context `decisions` and `signals` metadata (capped at 50 each), normalized at every writer
- [x] 4.4 `inbox-ingest`: match-before-write, read decisions, history vs card rule, new work contexts in the report
- [x] 4.5 `inbox-execute` triage and accept record a decision on the linked work context
- [x] 4.6 Needs me groups by work context
- [x] 4.7 Tests for the read, unlink, caps, grouping; `pnpm check` green
- [x] 4.8 Live check 11/10: a work item with two linked items shows as one group in Needs me with "About: …"; "not this" removes the link, keeps the item pending, and dissolves the group
- [ ] 4.9 First real ingest pass with match-before-write; review the new work items it reports for duplicates
