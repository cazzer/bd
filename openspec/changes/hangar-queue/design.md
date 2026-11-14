## Context

See proposal.md for the motivation and specs/ for the requirements. This change builds on `tailnet-hosting` group 1 (PR #2), which provides:
- `client_tokens`, with `human` and `agent` scopes;
- one admission function (`packages/core/src/admission.ts`) whose policy names the scopes a server accepts;
- the web dispatcher's `routeFor`/`isPublicPath`;
- a `WeakMap` that hands the admitted client to the tRPC context;
- the MCP session bound to its token client.

The web API refuses `agent` tokens outright today (bd-d38.8).

Inbox items record a herdr `pane` and `socket` for their originating session, and decisions on them are typed into that pane (`apps/web/server/routers/inbox.ts`, `review-writer.ts`). A remote worker files its review request as an inbox item over HTTP (hangar `plan.md`: "worker review requests use those until bd-98d lands"). So only inbox decisions need routing to a remote session. Beads-backed board reviews stay local.

## Goals / Non-Goals

**Goals:**
- A queue hangar can drain without anything connecting in to it.
- Each session has its own identity and message stream.
- A contract hangar can be built against before this merges.

**Non-Goals:**
- Admission by capacity. Hangar decides which flavors it can admit; bd-d38.5 stores and explains capacity.
- Accept and table outcomes (bd-d38.4).
- Push delivery, websockets, or LISTEN/NOTIFY.
- More than one hangar. The schema allows it (rows keyed by hangar name), but status reports the most recent check-in.

## Decisions

### 1. A REST surface at `/hangar/v1` on the web server

Hangar is a separate program in another repo (cazzer/hangar, Node/TypeScript but not this monorepo). A small JSON REST API is easier to document, version, and call from a shell than tRPC's batching wire format. It lives on the web server, which already has admission, the token store, and the database.

`routeFor` gains a `hangar` route for the `/hangar/v1/` prefix. Admission scopes become per route:
- `trpc` → `human` | `agent`, narrowed by each procedure (decision 5);
- `hangar` → `hangar` | `agent`, narrowed by each endpoint;
- `health` → any scope;
- static and connect → as today.

The handler checks each endpoint's own scope. That way a worker's `agent` token reaches only `GET /hangar/v1/messages`, and the hangar token reaches only the service endpoints.

- *Alternative: tRPC procedures.* Rejected because of the wire format and the coupling to this repo's router types.
- *Alternative: on the MCP server.* Rejected: that server speaks JSON-RPC MCP, and a parallel REST surface there would duplicate admission wiring for no gain.

### 2. One `hangar_session` node per request, with its contract in `packages/core/src/hangar.ts`

`node_type` is `hangar_session`, `source_system` is `hangar`, and `external_id` is a uuid generated at request time. `normalizeHangarSessionMetadata` enforces the metadata at every writer:
- `state`, `flavor`, `repo`;
- `requested_by` (actor);
- `claimed_by` (hangar name) and `claimed_at`;
- `container`, `host`, `disk_path`;
- `requeue_reason`;
- `occurred_at` (request time).

A `run_by` edge runs from the session to its work item. `brain_write` refuses `hangar_session` nodes, because the type is reserved: only the hangar paths write sessions, so an agent can't forge a state. Every change goes through the ordinary upsert path inside an ingest run (source `hangar`; actor is the hangar client or the requester), so the revision trigger records it.

Claiming runs in one transaction:

```sql
SELECT … FROM nodes
WHERE node_type = 'hangar_session'
  AND merged_into IS NULL
  AND metadata->>'state' = 'queued'
  AND metadata->>'flavor' = ANY($flavors)
ORDER BY metadata->>'occurred_at', id
LIMIT 1
FOR UPDATE SKIP LOCKED
```

Then, in the same transaction: the state update and the session token insert. `SKIP LOCKED` makes racing claims take different rows, or none.

Long-poll is a loop that re-runs the claim (or the message read) every second until the bound expires or the request's socket closes. The scale is one hangar and a few workers, so a cheap indexed query per second is fine. LISTEN/NOTIFY would hold a pool connection per waiter.

- *Alternative: a `hangar_requests` table.* Rejected. Sessions belong in the graph (linked to work items, visible in views and history), and two records for one lifecycle drift apart.

### 3. Check-ins and messages are tables, not nodes

- `hangar_check_ins(hangar text primary key, last_seen_at timestamptz, version text, capacity jsonb, interval_s int)` is upserted by every check-in and every claim. One row per hangar means no growth.
- Status is computed on read: `online` if `now() - last_seen_at < 3 × interval_s`, else `offline` since `last_seen_at`; `never` when there are no rows. Responses tell hangar the interval to use (default 30 s), so the offline threshold is 90 s.
- `hangar_messages(id bigserial primary key, session_id uuid not null, kind text, body jsonb, created_at timestamptz default now())`, indexed on `(session_id, id)`. The cursor is `id`: a fetch returns messages with `id > after`, oldest first, up to 50.
- Messages are kept. Deleting them with the session is bd-d38.4's job.

### 4. Session tokens

- `client_tokens` gains `session_id uuid null` (indexed, no foreign key: a session node may later be merged or tombstoned, and the token's lifetime is driven by session state, not row existence).
- The claim inserts `client = 'session-' || session_uuid` (the full uuid, so live session clients are unique by construction) with scope `agent`, in the claim's transaction, and returns the token once.
- Moving the session to `stopped` or `failed`, or requeueing it, sets `revoked_at` in the same transaction.
- `verifyClientToken` returns `{ client, scope, sessionId }`, and admission passes `sessionId` through to both servers' contexts.
- The host CLI keeps refusing a second live token per client. Session clients are unique by construction.
- CLAUDE.md's minting sentence becomes: the host CLI, or a hangar claim for that session; never MCP or tRPC.

### 5. Per-procedure scopes (bd-d38.8)

tRPC procedures carry `.meta({ scopes })`, and one middleware refuses with 403 any admitted scope outside the list. Loopback tokenless requests count as `human`, since they come from the local person.

`humanProcedure` and `agentProcedure` (human + agent) replace `publicProcedure` in every router. A test enumerates `appRouter._def.procedures` and fails on any procedure without declared scopes, so a new one must choose.

`agent` gets `inbox.request`, `inbox.complete`, and the reads that `bin/inbox`, `bin/inbox-watch`, and `bin/review-request` call. Everything else is `human`.

### 6. Routing decisions to a remote session

`inbox.request` stamps `session` (the session node id) from `ctx.sessionId` when the admitted token is session-bound. It ignores any `session`, `pane`, or `socket` in the body for such a caller.

When a person decides, releases, or hands off an item:
- if the item has `session`, the server appends a `hangar_messages` row (`kind: "inbox_decision"`, body: item id, title, outcome, option, message) instead of running herdr;
- otherwise herdr delivery runs exactly as today.

### 7. MCP tools and the web pill

- `brain_hangar_request` (write): repo, work_item, flavor → session id and status.
- `brain_hangar_status` (read): status plus queued and running counts.
- `brain_hangar_sessions` (read): filter by state or work item; bounded like every response.
- tRPC `hangarStatus` (agent) feeds a small pill in the board header that reads "hangar online" or "hangar offline since …".

### 8. The contract document

`docs/hangar-api.md` describes:
- each endpoint, its scope, request and response JSON with examples, and status codes;
- error bodies `{ "error": { "code", "message" } }`;
- long-poll and cursor semantics;
- the state machine;
- the check-in interval and the offline rule.

The handler exports its endpoint table (`HANGAR_ENDPOINTS`: method, path, scope). A test parses the document's endpoint headings and compares the two sets.

Endpoints:

| Method | Path | Scope |
| --- | --- | --- |
| `POST` | `/hangar/v1/check-in` | hangar |
| `POST` | `/hangar/v1/claim` | hangar |
| `PATCH` | `/hangar/v1/sessions/:id` | hangar |
| `POST` | `/hangar/v1/sessions/:id/requeue` | hangar |
| `GET` | `/hangar/v1/sessions` | hangar |
| `GET` | `/hangar/v1/messages` | agent, session-bound |

`GET /sessions` lists the caller hangar's claimed, running, and stopped sessions, so it can reconcile after a restart.

### 9. Amendments after planning

- **Routes on this branch.** The web routes are `connect`, `reviewImages`, `hangar`, and `trpc`. `/healthz` and static serving arrive with tailnet-hosting group 2 (PR #3); when it lands, `health` admits any scope.
- **Procedure names are flat.** The agent set is exactly `inbox`, `inboxRequest`, `inboxComplete`, `beadsProjects`, and `hangarStatus`.
- **`inboxComplete` from a session-bound token** applies only to items that carry that token's own session.
- **Delivery points.** Decide and release both go through `writeInboxFeedback`, which appends the message in its transaction. On a session item, hand-off (`inboxOpenSession`) first tells the session it was taken over locally, then clears `session` so later decisions go to the local pane. `bin/inbox-watch` skips session items.
- **Loopback ignores a presented token** (admission step 3). Tests and the end-to-end script therefore reach the hangar endpoints through a tailnet `Host` or a non-loopback `X-Forwarded-For`, as hangar does in production.
- **Claim probes before opening an ingest run,** so a long-poll doesn't write an empty run every second. Message appends take a per-session advisory lock, so a cursor can't skip a message committed out of id order.
- **`bin/inbox` and `bin/inbox-watch` send `Authorization: Bearer $BREAKDOWN_TOKEN` when it is set.** That variable belongs to the scripts, not the servers.
- **A refused MCP request closes its session only when a credential caused the refusal:** unknown or revoked token, or wrong scope.
- **Security review.** These close what a remote, possibly prompt-injected worker holding a session token could otherwise do:
  - `mergeNodes` refuses any hangar session (node_type `hangar_session` or source `hangar`) as loser, survivor, resolved survivor, or chain member, so a session is always canonical. Its single `UPDATE` is the only statement that sets `merged_into`, so no token-revoking backstop is needed.
  - A session-bound `inboxRequest` re-sends only its own session's items. It is refused, writing nothing, when the key names another session's item, a pane's, or an ingest's.
  - No agent write moves an item into `accepted`, `changes`, `dismissed`, or `session`, or writes `feedback`. That covers `inboxRequest` and `brain_write`, both through `carryForwardInboxDecisions`. A new item is always `pending`.
  - Only the `run_by` edge under source `hangar` names a session's work item, and `brain_link` refuses source `hangar` and any edge out of a session.
  - A session token's MCP session neither lists nor runs `brain_merge` and `brain_hangar_request`.
  - `createClientToken` refuses `session-` names. A claim marks an unclaimable queued row `failed` and moves on.

## Risks / Trade-offs

- [Polling every second while long-polling] → At most one hangar and a handful of workers, each running an indexed query once a second. Revisit with NOTIFY if the board ever hosts more.
- [A session token is a broad credential] → It is a full `agent` MCP credential minus `brain_merge` and `brain_hangar_request`. It reads the whole store and every inbox item, and writes nodes and edges anywhere but the reserved hangar ones. It is held by a remote worker that may be prompt-injected. What it cannot do is enforced, not trusted: it cannot merge (no merge touches a session in any case), queue more sessions, take another session's or a local inbox item by re-sending its key, approve anything (no agent write sets `accepted`, `changes`, or `dismissed`, or writes `feedback`), or repoint a session's `run_by` (only the queue's own edge counts).
- [A leaked hangar token can mint session tokens by claiming] → Each claim mints a session token with the reach above. Those tokens die with the session, and every claim is a visible state change. Revoke the hangar token to stop it.
- [A header-less forwarder on Breakdown's machine] → socat, `ssh -R`, or a bare nginx `proxy_pass` makes every remote peer look like loopback, which is the tokenless local person on tRPC and MCP. That is unsafe and must not be used. Only a proxy that sets `X-Forwarded-For` (such as `tailscale serve`) may front the servers.
- [A queued session that cannot be claimed] → A row that breaks the session contract, or whose `session-<id>` name a live token already holds, is marked `failed` with `failure_reason` and passed over (a few per attempt), so it cannot stall the queue. Host-minted names starting with `session-` are refused, which closes the second cause.
- [Worker messages pile up] → Bounded by sessions times decisions. Cleanup arrives with bd-d38.4.
- [Clock skew between Jetson and desktop] → All times (check-ins, offline threshold) use Breakdown's `now()`, never hangar's clock.
- [Archive order] → This change modifies `client-access`, which `tailnet-hosting` introduces, so archive `tailnet-hosting` first.

## Migration Plan

Migration 0008 is additive: the column, the scope check, and two tables. Merging changes nothing for existing local use. Hangar starts using the API once cazzer/hangar #5 lands. To roll back, drop the two tables and the column.
