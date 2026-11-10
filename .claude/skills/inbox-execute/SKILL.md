---
name: inbox-execute
description: Use when asked to carry out accepted inbox items — "run the inbox", "execute accepted items", "do what I approved" — or to triage items sent back with a note (status changes). Performs each proposed action through the person's connectors and marks it done; a sent-back note is closed, acted on, or re-queued.
---

# Inbox execute

The person accepted these items in breakdown's inbox. Your job is to do exactly what each one proposed. Nothing more, nothing else.

## Steps

1. `brain_list` with `nodeTypes: ["inbox_item"]` and `where: [{ key: "status", op: "equals", value: "accepted" }]`. If none, say so in one line and stop.
   Skip any item with a `pane` in metadata: a live session owns it (it queued the draft, or the person opened it there) and the server already prompted that session. Executing it here would do it twice.
2. For each item, `brain_get` it. Read `content` (the `### Draft` section is what gets sent or created) and the latest `feedback` entry. An accept note there ("send it but drop the last line") is part of the instruction. Apply it.
   **A card item** (it has `options`): the latest accept entry's `option` is the person's choice. Carry out that option and its `on_accept` steps, not the recommendation. If they chose a different option than the draft was written for, act on their choice. For example, `track` on a Fathom batch means creating the candidates' tasks, while `ignore` means just closing it. An accept with no `option` on a card item came from before cards existed: do what the draft says.
3. **Do the action through the matching connector**, using the item's `url`/`links` to find the target:
   - `reply`: reply in the same thread (Gmail reply, Slack thread reply, Notion/Docs comment reply).
   - `create_task`: create the Asana task using your Asana house-format skill when one is available.
   - `comment` / `update`: comment on or update the named Asana task, PR, or doc.
   - `review`: submit the PR review with the drafted comments.
   - `decide` / `ignore` / `none`: nothing to send. Mark it done.
   - The draft names a channel or recipient you can't resolve, or the action is ambiguous: don't guess. Write it back with `status: "pending"`, `needs_you: "<what's missing, one line>"` in metadata, and a `### Needs you` note at the top of `content`.
4. Mark it done: `brain_write` the same item (`sourceSystem: "inbox"`, same `externalId`, same `title`) with `status: "done"`, `feedback` carried forward unchanged, and a `**Done:** <what you did, with link>` line at the top of `content`.
5. Report one line per item: what was done, with its link, or why it went back to pending.

Never execute an item whose status isn't `accepted` when you read it.

`bin/inbox-watch` runs this skill headless whenever you accept an item no session owns, so Accept acts within about 30 seconds.

## Triage: items sent back with a note

When the person types a note, the inbox's button becomes **Send to agent** and the item moves to `changes`. The note is direction, not a request for another card. For each `changes` item with no `pane`, `brain_get` it, read the latest `feedback` message, and pick exactly one outcome:

| Outcome | When | Write |
|---|---|---|
| **close** | The note says it's done, already handled, not theirs, a dupe, or needs no action ("already sent a message, close this", "this question isn't addressed at me") | `status: "done"`, `close_reason: <the note, or a one-line paraphrase>`, and `**Closed:** <why>` at the top of `content` |
| **act** | The note fully specifies what to do, and what goes out is the reviewed draft, plus at most the edits the note names ("send it but drop the last line", "send it to Robin instead", "file it under the OPS project") | Carry it out as in step 3, then write it as in step 4 (`status: "done"`, `**Done:** …`) |
| **re-queue** | The note asks for something the person hasn't seen ("go read the PR and propose real feedback", "rewrite this warmer"), or it changes what gets sent beyond the edits it names | Rewrite `content` (and `action` if needed), then write `status: "pending"` with `revision: "<one line: what changed>"` |

- **The re-queue rule:** if acting would send text under the person's name that they haven't read, re-queue. If you're unsure which outcome fits, re-queue. Re-queuing is the safe failure, because it's what used to happen every time.
- A note that agrees and adds a small edit ("I generally agree, but drop the Firebase line") is an **act**. Don't make the person accept their own edit.
- Always carry `feedback` forward unchanged. Write `title` and `externalId` as stored.
- Report one line per item: the outcome and why ("closed: note says Alex already answered").

## Record the decision on the work

When an item you closed, acted on, or carried out (an accept with a note, or any accept on a card) has an `about` link (`brain_neighbors` on the item, edge type `about`), append to that work item's `decisions`: `{ at: <now>, decision: "close" | "act" | "accept", note: <the person's note, or a one-line paraphrase of what they chose>, item: <the inbox item's id> }`. `brain_get` the work item first and resend its whole metadata with the entry appended (a write replaces the node). Don't record a re-queue: nothing is decided yet. This is how the next agent, from any source, knows what's settled.
