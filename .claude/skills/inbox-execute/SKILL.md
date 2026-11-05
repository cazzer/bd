---
name: inbox-execute
description: Use when asked to carry out accepted inbox items — "run the inbox", "execute accepted items", "do what I approved". Reads inbox_item nodes with status accepted, performs each proposed action through the person's connectors, and marks them done.
---

# Inbox execute

The person accepted these items in breakdown's inbox. Your job is to do exactly what each one proposed. Nothing more, nothing else.

## Steps

1. `brain_list` with `nodeTypes: ["inbox_item"]` and `where: [{ key: "status", op: "equals", value: "accepted" }]`. If none, say so in one line and stop.
2. For each item, `brain_get` it. Read `content` (the `### Draft` section is what gets sent or created) and the latest `feedback` entry. An accept note there ("send it but drop the last line") is part of the instruction. Apply it.
3. **Do the action through the matching connector**, using the item's `url`/`links` to find the target:
   - `reply`: reply in the same thread (Gmail reply, Slack thread reply, Notion/Docs comment reply).
   - `create_task`: create the Asana task using your Asana house-format skill when one is available.
   - `comment` / `update`: comment on or update the named Asana task, PR, or doc.
   - `review`: submit the PR review with the drafted comments.
   - `decide` / `ignore` / `none`: nothing to send. Mark it done.
   - The draft names a channel or recipient you can't resolve, or the action is ambiguous: don't guess. Write it back with `status: "pending"`, `needs_you: "<what's missing, one line>"` in metadata, and a `### Needs you` note at the top of `content`.
4. Mark it done: `brain_write` the same item (`sourceSystem: "inbox"`, same `externalId`, same `title`) with `status: "done"`, `feedback` carried forward unchanged, and a `**Done:** <what you did, with link>` line at the top of `content`.
5. If the item has a `pane` in metadata (it came from a live session), tell that session with `herdr agent prompt <pane> "<one line: what was done, link>"`.
6. Report one line per item: what was done, with its link, or why it went back to pending.

Never execute an item whose status isn't `accepted` when you read it.
