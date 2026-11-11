---
name: inbox-ingest
description: Use when asked to fill, refresh, or sync the inbox / review queue — "ingest my inbox", "what needs me", "refresh the review queue", "pull in email/Asana/Slack/Notion/Docs/GitHub/Fathom". Reads the person's sources through their connectors (read-only), triages what needs a decision, and writes inbox_item nodes through brain_write.
---

# Inbox ingest

You fill breakdown's inbox: one `inbox_item` per thing that needs the person's decision, with a proposed action they can accept, send back, or dismiss at `http://localhost:5310/inbox`.

**Read-only toward every source.** You read Gmail, Asana, Slack, Notion, Google Drive/Docs, GitHub, and Fathom through the connectors. You never send, post, comment, edit, complete, or label anything during ingest. Writes go to breakdown only (`brain_write`, `brain_link`). Doing the action happens later, after the person accepts, in the `inbox-execute` skill.

## Rules of the road

The person's inclusion rules are in `local/needs-me.yaml` (fall back to `config/needs-me.example.yaml`). Read it first. It names, per source, what puts an item in (`enter`), what takes it out (`exit`), and the canonical key (`key`).

If the person named specific sources ("just Asana"), ingest only those.

## Steps

1. **Load what's already there.** `brain_list` with `nodeTypes: ["inbox_item"]` and `where: [{ key: "status", op: "oneOf", values: ["pending", "changes", "accepted", "undigested"] }]` (page through with the cursor). Keep a map of `externalId → {id, status, feedback}`. Items with status `changes` need revising (step 5), not re-triaging. Items with status `undigested` are held because no one read their artifact yet: digest them first (step 4, "Digest before you write"). Items with status `session` are with an interactive session the person opened: leave them alone (don't re-triage, don't close them), and skip any `changes` item that has a `pane`, since its session revises it.
2. **Pull each source** per its `enter` rule, through its connector. Keep it bounded: the last 14 days, at most ~50 signals per source.
3. **Resolve each signal to its artifact key** (the dedupe):
   - A notification email from GitHub, Asana, Notion, or Google Docs is about that artifact. Key it as the artifact (`github:<owner>/<repo>#<n>`, `asana:task/<gid>`, `notion:page/<id>#discussion/<id>`, `gdoc:<fileId>#comment/<id>`), not as `gmail:thread/...`, and add the email to `links`.
   - Two signals with the same key are one item. Fold both into `links`.
   - A Fathom action item that matches an Asana task or PR already in the inbox (or in Asana) is `already_tracked`. Link it, don't create a duplicate.
3b. **Match the signal to its work, then check what's settled** (inbox-follow-through). Every inbox item is a decision about some piece of work, and the work, not the item, remembers what the person decided.
   - **Find the work item.** `brain_search` (and `brain_list` with `nodeTypes: ["work_item"]`) on the signal's subject, people, and links: the Asana task, the RFI, the PR, the hire. A confident match is the same piece of work whatever the source (a Slack thread about the Vendor RFI is the Vendor RFI's, even if it doesn't link the task).
   - **None, or only a weak one?** Create it: `brain_write` a `work_item` (`sourceSystem: "inbox"`, `externalId: "work:<kebab-slug>"`, a plain title like "Vendor RFI", `metadata.project` a short key like `vendor-rfi`). Reuse that slug for every later signal about it. Count it in the report as a new work item, so the person can spot a duplicate (`brain_merge` fixes one).
   - **Read its `decisions` and `signals`** (`brain_get`) before triaging. Then:
     - **Settled already** (a decision covers what this signal asks or reports: answered, handled, closed, not theirs): don't write an inbox item. Append `{ at, title, url, gist }` to the work item's `signals` and move on.
     - **Changes or reopens a decision**, or **asks the person a question directly**: write the inbox item (step 4), and start its content with `**Changes:** <the decision it affects, with its date>` when it reopens one.
   - **Link it.** After writing an item, `brain_link` it to the work item: `edgeType: "about"`, `srcId` item → `dstId` work item, `weight` your confidence (0.9+ sure, 0.6 likely). One `about` per item. The card shows "About: <work>", and the person's "not this" removes a wrong link; don't re-add a link they removed unless the signal is plainly about it.
   - Writing to a work item: `brain_get` it first and resend its whole metadata with your entry appended. A write replaces the node, so a partial one wipes it.
4. **Digest before you write.** Before writing an item, open its primary artifact through the connector and read it: the PR's diff (not just its description), the doc's body, the full thread, the meeting's transcript (not just the recap). Record each thing you opened in `metadata.read` as `{ ref: <url>, depth: "full" | "skimmed" }`. An item whose `url` no `read` entry covers is stored as **undigested** and kept out of the person's Needs me, so "I haven't read the diff" never reaches them. If you can't open it (access denied, attachment), say why in one line of Context and list what you could see at depth `skimmed`. Then **triage and write.** For each artifact that needs the person, `brain_write` one item (batch them, up to 50 per call):
   - `nodeType: "inbox_item"`, `sourceSystem: "inbox"`, `externalId`: the artifact key.
   - `title`: short and specific, what the decision is about ("Reply to Todd on Chromebox alpha devices", not "Slack message").
   - `content`: markdown in this shape:
     ```
     **What happened:** one to three sentences, with who and when.

     **Proposed action:** what you'd do if accepted, in one line.

     ### Draft
     <the exact reply / ticket body / review comments, ready to send as-is>

     ### Context
     <only what the person needs to decide: quotes, related tickets, open questions>
     ```
     Write drafts in the person's voice (their `writing-style.md`/CLAUDE.md voice guide if loaded). Name anything you couldn't confirm.
   - `metadata`: `source`, `url` (the artifact), `read` (what you opened, see above), `from`, `action` (`reply`, `create_task`, `comment`, `review`, `update`, `decide`, `ignore`), `priority` (0 urgent … 4 whenever; due today or blocking someone = 1), `links` (every signal, `{label, url}`), `occurred_at` (when the signal arrived). Carry `status` and `feedback` forward unchanged for existing items. The write tool also protects them, but don't rely on it.
   - **A card when there's a real choice.** A batch, or a decision with two to six distinct ways to go, also gets the decision card keys: `question` (≤140 chars, decision-shaped), `options` (`[{ id, label, what?, risk? }]`, ids like `track`/`ignore`), `recommend` (one option id), and `on_accept` (the steps you'll take). The person then accepts an option by name, and the executor gets it in the feedback. A reply draft or a single proposed action stays a plain item: no card.
   - Nothing worth doing (FYI, newsletters, automated noise)? Don't write it.
5. **Triage items sent back.** For each item with status `changes`, follow the **Triage** section of the `inbox-execute` skill: close it, act on it, or re-queue it, by the person's latest note. Don't default to re-queue. A note that already says what to do is carried out, not handed back as a new card.
6. **Close what resolved at the source.** For an open item whose `exit` rule now holds (email archived, task completed, thread resolved, PR reviewed), write it with `status: "done"`.
7. **Report** in two lines: counts (new, updated, revised, closed per source, plus signals kept as history and new work items) and anything that failed (a connector error, a source you skipped).
   - **Linking check, before you report:** count the items you wrote this run that have no `about` link (`brain_neighbors`, edge type `about`). Report it as "linked N of M". List any unlinked `new_action`, `reply`, or `review` item by title, since those should always have work. A Fathom agent that links none of its candidates has skipped Fathom step 4. Send it back to link them before you report.
   - **Wait for every source agent.** Don't end the run while one is still working. If one can't finish, name it and the meetings or signals it left undone, so the person can rerun just those.

## Fathom: batches, skeptical by default

Fathom recaps over-report. They call discussion a "decision" and raise things already tracked. For each recent meeting the person attended:

1. Fetch the meeting's **transcript**, not only the recap, and list it in `read` (`{ ref: <fathom call url>, depth: "full" }`). Then write one **batch** item: `externalId: "fathom:<recordingId>"`, `action: "decide"`, content = a two-line meeting summary, and a card: `question: "Track or ignore <n> action items from <meeting>?"`, options `track` / `ignore`, recommending what the verdicts say.
2. For each recap action item or decision, write a **candidate** (`externalId: "fathom:<recordingId>#<n>"`) with a `verdict`:
   - `already_tracked`: put the existing Asana task, PR, or thread in `links`. `action: "ignore"`.
   - `not_actionable`: discussion, not a commitment. `action: "ignore"`.
   - `not_mine`: someone else owns it. `action: "ignore"`.
   - `knowledge`: worth remembering, no action. `action: "ignore"`. Optionally also `brain_write` a note.
   - `new_action`: a real commitment by the person. Requires a transcript timestamp and quote in `content`, otherwise downgrade it. `action: "create_task"` (or whatever fits) with the draft.
3. `brain_link` each candidate to its batch: `edgeType: "child_of"`, `srcId` candidate → `dstId` batch.
4. **Match every candidate and the batch to their work, as in step 3b of Steps. A Fathom item is not exempt.** A meeting touches several pieces of work, so match each candidate on its own:
   - `new_action` and `already_tracked`: always link `about` the work item it advances (create one if none fits). For `already_tracked`, it's the work of the task or PR you put in `links`.
   - `knowledge`: link it when it's about a known piece of work, and append it to that work's `signals`. That's what keeps a decision from the meeting findable later.
   - `not_actionable` and `not_mine`: link only when the match is obvious. Don't create a work item for them.
   - The batch: link `about` the one work item the meeting is mostly about, if there is one (a "Sr. Software Engineer, Platform Kick Off" is the Platform SWE hire). Skip it for mixed meetings like a standup.
   - Before writing a candidate, read the matched work's `decisions`. A candidate a decision already settles is `already_tracked` or `knowledge`, never `new_action`.
5. Learn from overrides: candidates whose `feedback` flipped your verdict (dismissed a `new_action`, accepted an `ignore`) are examples. Read the last ~10 before triaging a new recap.

## Items from a live Claude session

When the person, in any Claude session, wants a decision queued instead of asked inline, write `source: "session"`, `externalId: "session:<short-slug>"`, the draft in `content`, and the session's herdr pane in metadata as `pane` (`$HERDR_PANE_ID`). Same contract otherwise.
