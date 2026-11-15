## Context

See proposal.md for the motivation and specs/ for the requirements. This builds on hangar-queue and hangar-release:

- **`hangar_check_ins`** has one row per hangar: `last_seen_at`, `version`, `interval_s`, and `capacity jsonb`.
  - `recordCheckIn` upserts the row.
  - `touchCheckIn` (from every claim) updates `last_seen_at` only.
  - `getHangarStatus` reads the newest row and the session counts in one statement.
- **Session state** lives in `hangar_session` node metadata:
  - `state`, `flavor`, `disk_path`, `outcome`, `requested_at`;
  - `run_by` edges to work items;
  - read through `normalizeHangarSessionMetadata` and `loadSession`.
- **"Awaiting review"** (hangar-release semantics): `state` in (`stopped`, `failed`), `disk_path` present, and `outcome` absent. That is, ended sessions hangar keeps a disk for until a person decides.

## Goals / Non-Goals

**Goals:**
- One read path that explains every queued session (or a given set) in a fixed number of statements, however many sessions are queued.
- A classifier that is pure and unit-testable, separate from the SQL.

**Non-Goals:**
- Any change to claim or admission behavior.
- Tracking capacity history. Only the latest report per hangar is kept.

## Decisions

### 1. Store as sent; parse leniently on read

`recordCheckIn` keeps today's checks: the capacity must be an object (or null) of at most 10,000 serialized characters, otherwise `invalid_request`. It writes `capacity_at = now()` when the capacity is non-null, and `NULL` with it otherwise.

`parseHangarCapacity(raw: unknown): HangarCapacity` reads each field on its own:
- `slots`: non-negative integers per flavor.
- `blocked`: strings per flavor, capped at 500 characters for display.
- `free`: four finite numbers.
- `sessions`, `disk`: each read as a whole.
- `usage`: entries whose `session` is a uuid and whose byte counts are non-negative finite numbers, lowercased, capped at 200 entries.

A field that doesn't parse becomes absent, so one bad field never hides the good ones, and the parser never throws.

*Alternative:* a zod schema with `.catch()`. Rejected because per-field fallbacks in zod read worse than ten lines of guards, and core has no zod dependency (the web server does).

### 2. Precedence: fits beats blocked; disk-awaiting-review is disk plus evidence

The classifier evaluates over online hangars that reported a parsed capacity:

1. No online hangar → `offline`. `since` is the newest `last_seen_at`, or `never`.
2. Online, but no capacity among them → `unknown`.
3. Any hangar with `slots[flavor] > 0` → `next`, with `ahead`: the number of queued sessions with the same flavor and an earlier `(requested_at, id)`. That is the claim order, so the count is honest.
4. No hangar names the flavor in `slots` or `blocked` → `not_offered`.
5. Every naming hangar's reason starts with `disk:` (case-sensitive, after trimming), and the awaiting-review list is non-empty → `disk_awaiting_review`, with `reasons` (per hangar) and `sessions`.
6. Otherwise → `capacity`, with `reasons`: `{hangar, reason}` for each hangar that names the flavor in `blocked`. A flavor in `slots` at `0` with no `blocked` entry reads "no free slot".

This puts `next` before `not_offered`, unlike the order in the bead's sketch. A request is blocked only when no online hangar fits it, so any fit wins.

The awaiting-review list is global, not per hangar. Breakdown knows a session's `claimed_by`, but disks are counted on hangar's side, and with one hangar in practice the global list is the useful one. If more than one hangar is online, each listed session carries its `claimed_by`, so the reader can match.

### 3. Batch read: two statements

`explainQueuedSessions(db, { ids? })` runs two statements:

1. **Check-ins, `now()`, and the awaiting-review sessions** (with their work items through `run_by`, folded through `merged_into` like `loadSession`), in one statement using CTEs aggregated to JSON.
2. **Queued sessions** (all of them, or `ids`), with `ahead` computed by a window function over every queued session: `row_number() OVER (PARTITION BY flavor ORDER BY requested_at, id) - 1`. The function computes over all queued sessions first, then filters to `ids`, so the count is right for a subset.

The pure classifier `classifyQueuedWait(session, context)` then maps each one. The awaiting-review list is capped at 20 sessions, oldest ended first, with a `total` count, so a full disk with many sessions stays bounded.

### 4. Surfaces reuse the same result

- **`getHangarStatus`** adds `capacity` (parsed, or null) and `capacityAt` for the hangar it already reports (the newest check-in).
- **MCP `brain_hangar_status`** prints the capacity summary: slots, blocked reasons, free figures, and the reported time.
- **`brain_hangar_sessions`** calls `explainQueuedSessions` for the queued sessions on the page and attaches `waiting`.
- **tRPC:**
  - `hangarStatus` (agent scope, existing) adds the capacity fields.
  - `hangarSessions` (human, existing) attaches `waiting` to queued sessions.
  - No new procedure.
- **Board:** `HangarStatusPill` gets a title/tooltip line with the slots and the blocked reasons. `HangarSessions` renders `waiting` on a queued row, with each awaiting-review session linking to its work item through the board's existing item link.

The DTO shape `waiting` is one object everywhere:
`{ kind, text, since?, ahead?, reasons?: {hangar, reason}[], sessions?: {id, claimed_by, work_item, disk_allocated_bytes?}[], total? }`

`text` is a one-line English summary built in core, so MCP and the board say the same thing.

### 5. Migration

`ALTER TABLE hangar_check_ins ADD COLUMN capacity_at timestamptz`, backfilled with `last_seen_at` where `capacity IS NOT NULL`. That's an approximation for rows from before the change, and the next check-in corrects it. It's not on `nodes`, so no view replacement.

## Risks / Trade-offs

- **[Hangar changes its reason wording]** → Only the `disk:` prefix is contract, and it's now documented. Any other text is shown verbatim and never parsed.
- **[A stale capacity]** → Only online hangars count, and `capacity_at` is shown. An online hangar whose capacity is minutes old still checks in every 30 s with a fresh one, since claims never carry capacity but check-ins always do.
- **[The awaiting-review list includes sessions on a hangar whose disk isn't the blocked one]** → Each entry carries `claimed_by`, and with one hangar the case doesn't arise.
- **[Explain cost on a long queue]** → Two statements regardless of queue length. The window runs over queued sessions only, filtered by the existing session predicate.

## Implementation Notes

Adjustments made while implementing, recorded against the decisions above:

1. **DTO casing.** `waiting` uses camelCase like every other MCP and tRPC output: `claimedBy`, `workItem`, `diskAllocatedBytes`. `HangarCapacity` keeps hangar's snake_case wire names (`ram_mb`, `allocated_bytes`), since it is hangar's report read back.
2. **`workItem.project`.** Each awaiting-review session's work item also carries `project` (its `metadata.project`, or null), so the board can link to the item on its project's board, and fall back to the graph without one.
3. **Test seam.** `explainQueuedSessions` takes `among: { hangars, sessions }`, like `claimSession`'s `among`. It restricts the check-ins, the queue window, and the awaiting-review list, so a suite sharing a database with live data explains only its own fixtures.
4. **"Oldest ended first"** orders by `updated_at, id`. There is no ended-at key, and an ended session's last write is normally the one that ended it.

Also:
- The queued sessions are read first, so an empty queue (or an `ids` list naming none) skips the second statement.
- A blank `blocked` reason is dropped like any other bad entry. A flavor at 0 slots then reads "no free slot".
- `usage` keeps the first 200 *valid* entries.
- The summary text uses the singular for one: "1 headless request ahead", "1 ended session still holds a disk".

## Migration Plan

Additive: a new nullable column, new optional fields in responses, and doc changes. Hangar on main already sends the documented shape minus `usage`, so nothing on its side needs to change first. To roll back, revert the code. The column can stay.
