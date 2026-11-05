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

1. **Load what's already there.** `brain_list` with `nodeTypes: ["inbox_item"]` and `where: [{ key: "status", op: "oneOf", values: ["pending", "changes", "accepted"] }]` (page through with the cursor). Keep a map of `externalId → {id, status, feedback}`. Items with status `changes` need revising (step 5), not re-triaging. Items with status `session` are with an interactive session the person opened: leave them alone (don't re-triage, don't close them), and skip any `changes` item that has a `pane`, since its session revises it.
2. **Pull each source** per its `enter` rule, through its connector. Keep it bounded: the last 14 days, at most ~50 signals per source.
3. **Resolve each signal to its artifact key** (the dedupe):
   - A notification email from GitHub, Asana, Notion, or Google Docs is about that artifact. Key it as the artifact (`github:<owner>/<repo>#<n>`, `asana:task/<gid>`, `notion:page/<id>#discussion/<id>`, `gdoc:<fileId>#comment/<id>`), not as `gmail:thread/...`, and add the email to `links`.
   - Two signals with the same key are one item. Fold both into `links`.
   - A Fathom action item that matches an Asana task or PR already in the inbox (or in Asana) is `already_tracked`. Link it, don't create a duplicate.
4. **Triage and write.** For each artifact that needs the person, `brain_write` one item (batch them, up to 50 per call):
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
   - `metadata`: `source`, `url` (the artifact), `from`, `action` (`reply`, `create_task`, `comment`, `review`, `update`, `decide`, `ignore`), `priority` (0 urgent … 4 whenever; due today or blocking someone = 1), `links` (every signal, `{label, url}`), `occurred_at` (when the signal arrived). Carry `status` and `feedback` forward unchanged for existing items. The write tool also protects them, but don't rely on it.
   - Nothing worth doing (FYI, newsletters, automated noise)? Don't write it.
5. **Revise items sent back.** For each item with status `changes`, read the latest `feedback` message, rewrite `content` (and `action` if needed) to address it, and write it with `status: "pending"`, keeping `feedback` as is.
6. **Close what resolved at the source.** For an open item whose `exit` rule now holds (email archived, task completed, thread resolved, PR reviewed), write it with `status: "done"`.
7. **Report** in two lines: counts (new, updated, revised, closed per source) and anything that failed (a connector error, a source you skipped).

## Fathom: batches, skeptical by default

Fathom recaps over-report. They call discussion a "decision" and raise things already tracked. For each recent meeting the person attended:

1. Write one **batch** item: `externalId: "fathom:<recordingId>"`, `action: "decide"`, content = a two-line meeting summary.
2. For each recap action item or decision, write a **candidate** (`externalId: "fathom:<recordingId>#<n>"`) with a `verdict`:
   - `already_tracked`: put the existing Asana task, PR, or thread in `links`. `action: "ignore"`.
   - `not_actionable`: discussion, not a commitment. `action: "ignore"`.
   - `not_mine`: someone else owns it. `action: "ignore"`.
   - `knowledge`: worth remembering, no action. `action: "ignore"`. Optionally also `brain_write` a note.
   - `new_action`: a real commitment by the person. Requires a transcript timestamp and quote in `content`, otherwise downgrade it. `action: "create_task"` (or whatever fits) with the draft.
3. `brain_link` each candidate to its batch: `edgeType: "child_of"`, `srcId` candidate → `dstId` batch.
4. Learn from overrides: candidates whose `feedback` flipped your verdict (dismissed a `new_action`, accepted an `ignore`) are examples. Read the last ~10 before triaging a new recap.

## Items from a live Claude session

When the person, in any Claude session, wants a decision queued instead of asked inline, write `source: "session"`, `externalId: "session:<short-slug>"`, the draft in `content`, and the session's herdr pane in metadata as `pane` (`$HERDR_PANE_ID`). Same contract otherwise.
