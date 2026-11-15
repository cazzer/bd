# Relay API, v1

A Breakdown that runs without `bd`, `herdr`, or the beads checkouts (the Jetson) still takes review decisions, sends herdr replies, and keeps the beads board live. It does this by queuing the work those binaries do as **relay actions**, which a **laptop relay** on the Mac, which has them, claims, runs, and reports. The relay also runs the beads watcher against the Mac's checkouts and pushes each project's ingest here.

This document is the HTTP contract between the relay and Breakdown. A test (`apps/web/server/relay-contract.test.ts`) fails whenever an endpoint is added to or removed from the server without the same change here.

## Who calls what

There is one caller, the relay, and it holds a `relay`-scoped token. It checks in, claims queued actions by long-poll, reports each one `done` or `failed`, lists the beads projects to watch, and pushes each project's ingest. Every request goes from the relay to Breakdown. Breakdown never connects to the relay, so the relay can sit behind NAT and be asleep for hours. Actions queue here until it comes back.

## Base URL, transport, and authentication

The API is served by Breakdown's **web** server (the one that serves the board and tRPC) under the path prefix `/relay/v1/`, exactly like the hangar API (`docs/hangar-api.md`):

```
http://<breakdown-host>:<port>/relay/v1/...      # the web server directly (default port 4310)
https://<breakdown-host>/relay/v1/...            # behind a TLS proxy such as `tailscale serve`
```

- **Authentication.** Every request carries `Authorization: Bearer <token>`. A missing, unknown, or revoked token gets `401` with `WWW-Authenticate: Bearer`. A live token of another scope gets `403`. Tokens never go in a query string, which is ignored.
- **Scope.** Every endpoint takes exactly scope `relay`. `human`, `agent`, and `hangar` tokens are refused on every endpoint here, and the `relay` token is refused everywhere else in Breakdown (tRPC, the hangar API, review images, the connect flow, and MCP) except `GET /healthz`.
- **Requests must arrive off loopback.** Breakdown trusts a request from its own machine (loopback peer, loopback `Host`) without reading any token and treats it as the local person, so every endpoint here refuses it with `403`. The relay is meant for another host. A proxy on Breakdown's machine must set `X-Forwarded-For` (`tailscale serve` does); see the hangar API's warning about forwarders that do not.
- **Host.** The `Host` header must be a name allowed with `--allow-host`, at the server's port or bare.
- **Content.** Every response body is JSON (`Content-Type: application/json; charset=utf-8`, `Cache-Control: no-store`). `POST` requests send `Content-Type: application/json` and a UTF-8 JSON body of at most **64 KiB** (65,536 bytes), except `POST /relay/v1/beads-ingest`, which may be up to **8 MiB** (8,388,608 bytes). Unknown request fields are ignored.
- **Read-only servers.** A Breakdown started with `BRAIN_READ_ONLY` answers `GET`s and refuses every `POST` with `403 read_only`, check-in and claim included.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/relay/v1/check-in` | Report liveness and version |
| `POST` | `/relay/v1/claim` | Take the oldest queued action of a kind you run (long-poll) |
| `POST` | `/relay/v1/actions/:id/result` | Report a claimed action `done` or `failed` |
| `POST` | `/relay/v1/beads-ingest` | Push one registered project's beads export |
| `GET` | `/relay/v1/projects` | The registered beads projects to watch, and whether to push |

`:id` is an action id, a positive decimal integer of at most 18 digits. Any other segment gets `404 not_found`. A known path with the wrong method gets `405 method_not_allowed` with an `Allow` header. Any other path under `/relay/v1/` gets `404 not_found`, including one with a trailing slash.

### `POST /relay/v1/check-in` — scope `relay`

Tells Breakdown the relay is alive and which version it runs. Call it on the interval the response gives. Every claim attempt also counts as a check-in, without a version.

Request:

```json
{ "version": "0.1.0" }
```

- `version` (string, 1–200 characters after trimming, required).

Response `200`:

```json
{ "interval_s": 30, "now": "2026-11-14T09:00:00.000Z" }
```

- `interval_s`: seconds until the next check-in. Breakdown reports the relay online while its last check-in is under three intervals old, offline since then afterwards, and never seen without one.
- `now`: the database's clock at this check-in, for logging skew.

Status codes: `200`, `400 invalid_json` / `invalid_request`, `401`, `403 forbidden` / `read_only`, `413`, `415`.

### `POST /relay/v1/claim` — scope `relay`

Takes the oldest open action of a kind you name and returns it, waiting up to `wait_s` seconds for one to arrive (see [Long-poll](#long-poll)). Under racing claims each action goes to exactly one claimer.

Request:

```json
{ "kinds": ["review_decision", "herdr_prompt", "beads_reingest"], "wait_s": 25 }
```

- `kinds` (array, optional): one or more of `review_decision`, `herdr_prompt`, `beads_reingest`, each at most once. Omitted: every kind.
- `wait_s` (integer 0–30, default 0).

Response `200` with an action:

```json
{
  "action": {
    "id": 42,
    "kind": "review_decision",
    "payload": {
      "project_key": "bd",
      "cwd": "/Users/me/dev/bd",
      "issue_id": "bd-d38.11",
      "decision": "accept",
      "message": "Ship it",
      "option": "b",
      "seen": { "question": "Which layout?", "label": "Two columns" }
    },
    "created_at": "2026-11-14T08:59:40.000Z",
    "attempts": 1
  }
}
```

or, when nothing arrived in time, `{ "action": null }`.

- `id`: the action id; report it with [`POST /relay/v1/actions/:id/result`](#post-relayv1actionsidresult--scope-relay).
- `payload`: validated data, never a command string. Parse it again against `packages/core/src/relay.ts`'s schema for its `kind` before running anything, and check every command against the allowlist (below).
  - `review_decision`: `{ project_key, cwd, issue_id, decision: "accept" | "changes", message, option?, seen? }`. Run it with the review writer, which re-reads the issue with `bd show` first, so an issue already past the decision is reported `done` with `{ "note": "already applied" }`, not run twice.
  - `herdr_prompt`: `{ pane, socket, text }`: `herdr agent prompt <pane> <text>` on that socket.
  - `beads_reingest`: `{ project_key }`: re-ingest that project now and [push](#post-relayv1beads-ingest--scope-relay) it.
- `attempts`: how many times it has been claimed without a report, this claim included.

Status codes: `200`, `400`, `401`, `403`, `413`, `415`, `429 too_many_waiters`.

### `POST /relay/v1/actions/:id/result` — scope `relay`

Finishes an action you hold.

Request:

```json
{ "state": "done", "result": { "note": "already applied" } }
```

```json
{ "state": "failed", "error": "bd close bd-d38.11 failed: database is locked" }
```

- `state` (`done` or `failed`, required).
- `result` (object or `null`, optional): what ran, at most 10,000 characters serialized.
- `error` (string, required when `failed`, refused when `done`): cut to 2,000 characters.

Response `200`:

```json
{ "action": { "id": 42, "state": "done" }, "already_finished": false }
```

**Reporting is idempotent.** Reporting an action that is already `done` or `failed` changes nothing and answers `200` with its stored state and `already_finished: true`, so retry a report whose response was lost.

Status codes: `200`, `400` (a bad field), `401`, `403`, `404 not_found` (no such action), `409 not_claimer` (another relay holds it, or it is queued), `413`, `415`.

### `POST /relay/v1/beads-ingest` — scope `relay`

Pushes one project's beads export, as the relay's watcher computed it from its checkout: `bd list --status=all --limit=0 --json` and the comment thread (`bd comments <id> --json`) of every review issue with comments. Breakdown applies it with the same idempotent beads upsert a local load uses, attributed to your client, and open boards refresh.

Request (up to 8 MiB):

```json
{
  "project_key": "bd",
  "path": "/Users/me/dev/bd",
  "issues": [
    { "id": "bd-d38.11", "title": "Laptop relay", "status": "in_progress", "priority": 1, "issue_type": "feature", "labels": ["review"], "comment_count": 1 }
  ],
  "comments": {
    "bd-d38.11": [{ "id": 7, "author": "caleb", "text": "Looks right", "created_at": "2026-11-14T08:00:00Z" }]
  }
}
```

- `project_key` (string, required): a project registered here, matching `[a-z0-9._-]{1,64}`.
- `path` (string, required): the absolute path of the checkout you computed it from. It must equal the path the project is registered at.
- `issues` (array of 1–20,000 objects, required): `bd list --json`'s rows as `bd` printed them. Each needs a string `id` (a beads id, at most 200 characters), `title`, and `status`; every other field is passed through.
- `comments` (object, required): review threads keyed by issue id, each an array of at most 1,000 comments as `bd comments --json` printed them. An issue missing here has no thread. Send `{}` when there are none.

Response `200`:

```json
{
  "project": "bd",
  "nodes": { "created": 0, "updated": 1, "unchanged": 212 },
  "edges": { "created": 0, "updated": 148 },
  "edges_deleted": 0,
  "changed": true,
  "changed_node_ids": ["8b1e4c1d-2f3a-4b5c-8d9e-0a1b2c3d4e5f"]
}
```

`changed` is the flag to read: a node changed or an edge was created or removed. `edges.updated` counts every re-asserted edge and is never a change.

Push semantics:

- **Raw data only.** Breakdown builds every node itself and takes the registry node's path from its own registration, so a push cannot register a project or re-point one. A project must first be registered by a local beads ingest (`pnpm ingest:beads --project`).
- **Idempotent.** Pushing the same export twice reports everything `unchanged` the second time.
- **Serialized per project.** Concurrent pushes of one project apply one at a time, in arrival order.
- **Same events.** A push that changes something sends open boards the same `changed` event a local load does; a push that fails to apply sends the same `error` event.
- **When to push.** Push only when [`GET /relay/v1/projects`](#get-relayv1projects--scope-relay) says `push: true`. A Breakdown with `bd` runs its own watcher.

Status codes: `200`, `400 invalid_request` (the body breaks the schema, or a row breaks the work-item contract), `401`, `403`, `404 not_registered` (no such project here), `409 path_mismatch` (registered at another path), `409 project_conflict` (an issue belongs to another project), `413` (over 8 MiB), `415`.

### `GET /relay/v1/projects` — scope `relay`

The beads projects registered here by a beads ingest: the checkouts to watch.

Response `200`:

```json
{ "projects": [{ "key": "bd", "path": "/Users/me/dev/bd" }], "push": true }
```

- `push`: whether this Breakdown lacks `bd` and so needs the relay's pushes. When `false`, it watches its own checkouts.

Status codes: `200`, `401`, `403`.

## Long-poll

`POST /claim` long-polls:

- **Bound.** `wait_s` is an integer from 0 to 30. Use `25`, and set your HTTP client's timeout above it (`wait_s + 10` seconds).
- **Early answer.** Breakdown checks once a second and answers as soon as a claim succeeds, typically within a second or two of the action being queued. Otherwise it answers `{ "action": null }` when `wait_s` passes.
- **Re-poll.** After a long-poll answers, send the next one straight away. After a `wait_s: 0` answer that was empty, sleep at least a second.
- **At most 2 at once.** One client may hold at most 2 claims with `wait_s` above 0 open at a time. A third gets `429 too_many_waiters` with `Retry-After: 1`.
- **No claim after disconnect.** If you close the connection, Breakdown stops before its next attempt. If a claim commits just as the connection closes, Breakdown requeues the action at once with the reason `claimer disconnected before receiving the claim`.
- **Shutdown.** When Breakdown shuts down, an open long-poll answers empty early. Retry with backoff.

## Reclaim and attempts

- A claimed action not reported within **5 minutes** counts as queued again, and the next claim takes it. A relay that dies mid-action loses nothing.
- Each claim without a report counts an **attempt**. An action claimed **3 times** without a report is marked `failed` (`abandoned after 3 claims without a report`) at its next claim instead of being handed out again.
- So report every action you claim, `done` or `failed`. A report after the reclaim from the relay that now holds it wins; yours is `409 not_claimer`.
- Double execution is possible only if the relay dies between running an action and reporting it. A review decision guards itself with `bd show`; a `herdr_prompt` may be delivered twice.

## The allowlist

The relay runs nothing outside this list, checked before every spawn, with an argument vector (`execFile`), never a shell. Breakdown refuses at enqueue any action whose arguments fall outside it, so a forged action is refused twice (`packages/core/src/relay-allowlist.ts`).

- `bd show <id> --json`
- `bd comments add <id> <text>`
- `bd update <id> --add-label review:changes` and `--remove-label review:changes`
- `bd close <id> --reason <text>`
- `bd list --status=all --limit=0 --json` and `bd comments <id> --json` (the ingest's reads)
- `herdr agent prompt <pane> <text>`

`<id>` matches `^[a-z][a-z0-9-]*-[a-z0-9.]+$` (at most 200 characters). `bd` text is 1–4,000 characters and herdr text 1–8,000, with no NUL, never starting with `-`. A `cwd` must be a checkout in the relay's own registry, and a herdr socket an absolute path on disk.

## Minting the relay token

On the machine that runs Breakdown, from its checkout:

```bash
pnpm -s client-token create relay-laptop --scope relay   # prints bdt_… once
pnpm -s client-token revoke relay-laptop                 # stops the relay at once
```

The client name is the relay's identity: it is `claimed_by` on its actions, its name in check-ins, and the actor of its pushed ingest runs. A leaked relay token can delay or drop queued decisions and push beads exports for registered projects; it cannot run anything on the Mac by itself, because the allowlist runs there. Revoke it with the command above.

## Running the relay

The relay is `bin/relay.mjs`, run from a checkout of this repo on the Mac that has `bd`, `herdr`, and the beads checkouts. Its code is `apps/web/server/relay/`: it runs the same review writer and beads watcher the web server runs locally, with allowlisted runners.

### Install

1. On the machine that runs Breakdown, mint its token (see [Minting the relay token](#minting-the-relay-token)).
2. On the Mac, put the token in its file, readable by you alone:

   ```bash
   mkdir -p ~/.config/breakdown
   (umask 077 && pbpaste > ~/.config/breakdown/relay-token)   # or printf '%s\n' "$TOKEN" > …
   chmod 600 ~/.config/breakdown/relay-token
   ```

3. From the checkout, install the LaunchAgent (`dev.breakdown.relay`):

   ```bash
   pnpm relay:service install --url https://<breakdown-host> --name relay-laptop [--project bd]... [--token-file <path>]
   ```

   `--name` is the client name the token was minted for; it labels the log. `--project` (repeatable) limits the relay to those registered projects; without it, every project Breakdown lists whose path is a beads checkout on this Mac. `--token-file` defaults to `~/.config/breakdown/relay-token`. Install waits up to 20 s for the relay's first check-in and prints what it installed.

To remove it: `pnpm relay:service uninstall` (the logs and the token file stay). To run it in a terminal instead: `pnpm relay --url … --token-file … --name …` (which is `node --import tsx ../../bin/relay.mjs` from `apps/web`).

### The token file

The token is the relay's own file, never an environment variable. The relay and the installer refuse a token file that:

- is a symlink, or not a regular file;
- is not owned by you;
- has any group or other permission bit (the refusal names the mode in octal and says `chmod 600 <path>`);
- holds anything but one token: one line of 1–512 characters with no whitespace inside.

The relay reads the file at start and again after any `401`, so a rotated token is picked up by writing the new one into the file; no restart is needed. Nothing logs or prints the token.

### PATH under launchd

launchd starts jobs with the system's PATH, which has neither Homebrew nor `~/.local/bin`. Install resolves `bd` and `herdr` on the PATH of the shell it runs in and writes `PATH=<dir of bd>:<dir of herdr>:/usr/bin:/bin:/usr/sbin:/sbin` into the plist. So:

- Install refuses without `bd` on PATH; the relay itself exits 1 at start without it.
- Without `herdr`, install warns and the relay starts; every herdr prompt (review and inbox replies to agents) then fails with the reason.
- After moving or reinstalling `bd` or `herdr` somewhere else, run install again.

The plist names node by the absolute path that ran install, runs it with no wrapper so launchd's SIGTERM reaches the relay, and sets `KeepAlive` (restarted 10 s after an exit) and `ExitTimeOut` 60.

### Status and logs

`pnpm relay:service status` prints whether launchd has the job loaded and running, the URL, name, token file, and projects in the plist, the `bd` and `herdr` that resolve on the plist's PATH, and the relay's latest `[relay] checked in` line since it last started. It exits 0 only when the job runs, `bd` resolves, the token file passes, and a check-in followed the latest start.

The logs are `~/Library/Logs/breakdown/relay.out.log` (start, check-in, each action) and `relay.err.log` (failures and retries). Every line starts with `[relay]` and names only Breakdown's origin, the client name, an action's id, kind, and state, an HTTP status, and Breakdown's error code and message. A person's review message and a herdr prompt never appear there; an action's error is on the board.

### What it does

- **Check-in** every `interval_s` (30 s), on its own loop, so a long action never makes it look offline.
- **Claim, run, report**, one action at a time: a 30 s long-poll, then the action, then its report, retried with backoff until Breakdown takes it. A report Breakdown refuses (`409 not_claimer`, `404`) is given up and logged.
  - Before running anything, the payload is parsed with the same schema Breakdown used at enqueue. A forged one, a `cwd` other than the project's checkout in the relay's registry, or a herdr socket that is not a socket on this Mac is reported `failed` with `refused: …` and nothing runs.
  - `review_decision` runs the review writer, which re-reads the issue with `bd show` first. An issue already closed is reported `done` with `{ "note": "already applied" }`. The result is the writer's own: what was written, and whether the agent's pane was told.
  - `herdr_prompt` is reported `done` with `{ "pane" }`, `beads_reingest` with `{ "project", "changed" }`.
- **Registry.** `GET /projects` at start, before each `beads_reingest`, when a decision names a project it does not hold, and every 5 minutes. A project is kept only when its path is its own realpath (no symlink on the way), a directory, and holds `.beads/`; anything else is logged once and skipped. A project registered after the relay started is picked up within 5 minutes.
- **Push watcher**, only while `GET /projects` says `push: true`: the server's beads watcher, run here with the push as its sink, so a bead edit on the Mac reaches open boards within a second or two. Each push carries the whole export; review threads unchanged since the last accepted push are not fetched again. An export over 8 MiB is refused before it is sent, with its size.
- **Stopping.** The first SIGTERM or SIGINT ends the long-poll, lets the action in hand finish and report, stops the watcher, and exits 0. A second exits 130 at once.

### When the Mac is asleep or offline

Nothing is lost. Breakdown keeps each decision `queued`, the review or inbox card shows it pending, and the board's relay pill reads "relay offline since …" once the last check-in is three intervals old. The relay retries every request with exponential backoff, at most 60 s apart, and on waking claims the queued actions oldest first. A decision that waited is still guarded by `bd show`: one that no longer applies (the review was closed meanwhile, or its card changed) is reported as such, not run.

**Caveat: a re-run `changes` decision comments twice.** If the relay dies after running a decision but before its report lands, Breakdown hands the action out again after 5 minutes. An accept is safe (the issue is closed, so the re-run is "already applied"), but request changes leaves the review open, so its re-run posts its comment a second time and re-adds the label. A `herdr_prompt` may likewise be delivered twice. It takes a relay death mid-action; a worst-case decision takes about 160 s against the 300 s reclaim.

### End-to-end check

`pnpm relay:e2e` runs the whole loop on this Mac against the database in `.env`: a web server started with a PATH holding neither `bd` nor `herdr` (so it queues), a proxy that makes the relay's requests arrive as from another machine, and the real relay with a throwaway `relay` token, against a scratch beads checkout at `~/Library/Caches/breakdown/relay-e2e` (project `e2e-relay`, emptied on each run) and a stub `herdr` on a real unix socket. It checks accept with an option, request changes, an inbox reply, and a bead edit reaching the board's event stream, then the same three decisions on a server with both binaries, which run directly and queue nothing. It refuses to start while any relay action is queued or claimed, never runs the real `herdr`, and revokes its token at the end. It is not part of `pnpm check`.

## Errors

Every error response has this body:

```json
{ "error": { "code": "not_claimer", "message": "relay action 42 is claimed by \"relay-other\", not \"relay-laptop\"" } }
```

Branch on `code`, which is stable within v1. `message` is for people.

| Status | `code` | When |
| --- | --- | --- |
| 400 | `invalid_json` | The body is not valid UTF-8 JSON. |
| 400 | `invalid_request` | The body breaks the endpoint's schema, or a pushed row breaks the work-item contract. The message names each problem. |
| 401 | `unauthorized` | No token, or an unknown or revoked one. Sent with `WWW-Authenticate: Bearer`. |
| 403 | `forbidden` | The token is not `relay`-scoped, the request arrived over loopback, or the `Host` / `Origin` is not allowed. |
| 403 | `read_only` | The server is read-only and this is a `POST`. |
| 404 | `not_found` | No such endpoint, or no action with that id. |
| 404 | `not_registered` | A push names a project not registered here. |
| 405 | `method_not_allowed` | A known path with the wrong method. The `Allow` header lists the right ones. |
| 409 | `not_claimer` | The action is held by another relay, or is queued. |
| 409 | `path_mismatch` | A push names a path other than the one the project is registered at. |
| 409 | `project_conflict` | A pushed issue already belongs to another project. |
| 413 | `too_large` | The body is over its cap (64 KiB; 8 MiB for a push). The connection is closed. |
| 415 | `unsupported_media_type` | A `POST` without `Content-Type: application/json`. |
| 429 | `too_many_waiters` | This client already holds 2 claims open (see [Long-poll](#long-poll)). Sent with `Retry-After: 1`. |
| 500 | `internal` | A server fault, logged on Breakdown's side. Retry with backoff. |

## Versioning

Everything here is under `/relay/v1/`. A breaking change gets a new prefix. Within v1, Breakdown ignores request fields it does not know, and responses may gain fields; clients ignore those.
