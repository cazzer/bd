## Context

See proposal.md for the motivation and specs/ for the requirements. This change builds on hangar-queue (PR #4):
- the `/hangar/v1` REST pattern (endpoint table, per-endpoint scope, JSON errors, long-poll loop, contract test);
- tables for check-ins and queue rows;
- per-route admission scopes in the dispatcher.

tailnet-hosting group 2 (PR #3) also applies:
- `missingBinaries` is computed once at web startup;
- `HostBinaryUnavailableError` and `refuseMissingBinary` give 412s;
- the beads watcher goes inert when `bd` is missing.

Where the host binaries are used today:
- **Review decision** (`apps/web/server/review-writer.ts`): runs `bd show <id> --json`, then the steps chosen from it (`comments add`, `update --remove-label/--add-label review:changes`, `close --reason`), then `herdr agent prompt <pane> <text>` on the socket recorded for the review.
- **Inbox decision** (`routers/inbox.ts`): a pane notification via `herdr agent prompt`.
- **Beads watcher** (`beads-watcher.ts`): runs `ingestBeadsCheckout` per registered project, and that function shells out to `bd` (`packages/core/src/beads-ingest.ts`).
- **Session opening** (`herdr-session.ts`): herdr JSON calls. Out of scope.

## Goals / Non-Goals

**Goals:**
- After cutover, accept, request changes, and an inbox reply behave the same from the board on the Jetson as from the Mac.
- The board stays live from the Mac's checkouts.
- A worker token can't touch the relay.

**Non-Goals:**
- Opening herdr sessions remotely.
- More than one relay. The schema allows it, keyed by client, but status reports the latest check-in.
- Replacing beads (bd-98d).

## Decisions

### 1. Relay actions are rows in `relay_actions`, not nodes

```sql
relay_actions(
  id          bigserial primary key,
  kind        text not null,      -- review_decision | herdr_prompt | beads_reingest
  payload     jsonb not null,
  state       text not null,      -- queued | claimed | done | failed
  claimed_by  text,
  claimed_at  timestamptz,
  finished_at timestamptz,
  result      jsonb,
  error       text,
  requested_by text,
  created_at  timestamptz default now(),
  origin_node_id uuid             -- the review or inbox item, for the UI
)
```

There is a partial index on `(created_at, id) WHERE state = 'queued'`. Claims use `FOR UPDATE SKIP LOCKED`, as `claimSession` does. A claimed row whose `claimed_at` is older than 5 minutes counts as queued again; it's reclaimed in the same predicate (`state = 'queued' OR (state = 'claimed' AND claimed_at < now() - interval '5 minutes')`), so no sweeper job is needed.

Actions are bookkeeping, not knowledge, and nodes would add a revision per state change for no reader's benefit. A review's or inbox item's own state changes when the relay applies the decision: the beads re-ingest pushes it back, and the inbox decision itself is already a node write.

- *Alternative: nodes of type `relay_action`.* Rejected for the revision cost and because agents could write them through `brain_write`.

### 2. Action kinds carry intent, and the relay runs the existing code

- **`review_decision`:** `{ project_key, cwd, issue_id, decision, option?, message, notify: { pane, socket } | null }`. The relay calls `createReviewWriter({ runBd: allowlistedRunBd, runHerdr: allowlistedRunHerdr }).write(...)`, the same function the web server calls locally. This keeps the `bd show` check-then-act logic in one place. An already-closed issue is reported `done` with `note: "already applied"`.
- **`herdr_prompt`:** `{ pane, socket, text }`. Only `agent prompt`.
- **`beads_reingest`:** `{ project_key }`. This is what the board's refresh queues when `bd` is missing. The relay re-ingests that project now and pushes the result (decision 4).

The server builds each payload from validated values, and the relay validates it again against the same zod schemas from `packages/core/src/relay.ts`.

### 3. The allowlist lives in core and is enforced twice

`packages/core/src/relay-allowlist.ts` exports `isAllowedBdArgs(args)` and `isAllowedHerdrArgs(args)`.

- **`bd`** accepts exactly these shapes:
  - `["show", ID, "--json"]`;
  - `["comments", "add", ID, TEXT]`;
  - `["update", ID, "--add-label"|"--remove-label", "review:changes"]`;
  - `["close", ID, "--reason", TEXT]`;
  - the read-only commands `ingestBeadsCheckout` issues (enumerate them from beads-ingest.ts).
  
  `ID` must match `^[a-z][a-z0-9-]*-[a-z0-9.]+$` (beads ids). `TEXT` may be at most 4000 characters with no NUL.
- **`herdr`** accepts `["agent", "prompt", PANE, TEXT]`, where `PANE` matches the existing `REVIEW_PANE_PATTERN`.

The relay's `runBd` and `runHerdr` wrappers refuse anything else before spawning, and spawn with an argument vector (`execFile`), never a shell. A `cwd` must be a checkout in the relay's own beads registry (read from Breakdown's `beads_project` nodes at startup and refreshed with each ingest), resolved with realpath. A herdr socket must pass the existing `isReviewSocketPath`. Enqueue validates the same rules, so a forged action is refused twice.

### 4. Beads ingest splits into compute and apply

`ingestBeadsCheckout` becomes `computeBeadsIngest(runBd, cwd, projectKey)`, which returns `{ nodes, edges, removedDependencies, … }` as plain data, followed by the existing apply step on a `db`. Local ingest composes the two exactly as before.

The relay runs compute and pushes `POST /relay/v1/beads-ingest { project_key, batch }`. Breakdown runs the same apply step inside an ingest run (source `beads`, actor = the relay's client name). The batch is validated with zod: node and edge shapes and counts, a body cap of 8 MiB, and a project already registered. Breakdown then emits the same `boardEvents` as a local load.

On the relay, the beads watcher runs against its local checkouts with a "push" sink in place of the database: one `chokidar`/poll loop with the existing timing. `beads-watcher.ts` gains an injected sink so both modes share the scheduling code.

### 5. A REST surface at `/relay/v1`, mirroring hangar

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/relay/v1/check-in` | `{ version }` → `{ interval_s, now }` |
| `POST` | `/relay/v1/claim` | `{ kinds?, wait_s }` → `{ action }` or `{ action: null }` |
| `POST` | `/relay/v1/actions/:id/result` | `{ state: done\|failed, result?, error? }` |
| `POST` | `/relay/v1/beads-ingest` | push one project's batch |
| `GET` | `/relay/v1/projects` | the registered beads projects (key, path) the relay should watch |

All of these need scope `relay`. They reuse hangar's request plumbing: body parsing, JSON errors, the long-poll loop, and the cap on concurrent waiters. `RELAY_ENDPOINTS` is checked against `docs/relay.md` by the same kind of contract test.

- *Alternative: generalize `/hangar/v1` into one queue for both.* Rejected. Hangar's contract is published to another repo, and the two queues have different payloads, scopes, and lifecycles.

### 6. Where actions get queued

- **`reviewDecision` (`routers/review.ts`):** when `missingBinaries` includes `bd`, enqueue `review_decision` instead of `refuseMissingBinary`. It answers `{ queued: true, actionId }`, and the review card shows "pending: waiting for the laptop relay".
- **Inbox decision notify:** when `herdr` is missing and the item has a pane, enqueue `herdr_prompt`; `notified` becomes `{ ok: true, relay: actionId }`.
- **`refreshBoard`:** when `bd` is missing, enqueue `beads_reingest` per project. `boardEvents` no longer refuses; the board receives pushed updates.
- **Session opening and focus** still answer 412.

### 7. The relay service

`bin/relay.mjs` is a thin runner. It imports `packages/core` and runs under tsx from the checkout, like the dev servers. It takes these flags:
- `--url https://<jetson>:4310` (the web server);
- `--token-file ~/.config/breakdown/relay-token` (mode 0600, refused otherwise);
- `--name <client>`.

It loops on check-in, long-poll claim, run, report. Next to that loop, it runs the push watcher.

`bin/relay-service.mjs` installs, removes, and reports the status of a launchd LaunchAgent, modelled on `bin/mcp-service.mjs`. It keeps the logs and never prints the token. The token is never an environment variable the servers read; it's the relay's own file.

### 8. UI

The review card and the inbox card show a pending state while their action is `queued` or `claimed`. They show done (and refresh) or failed with the error message once it finishes. tRPC `relayAction(id)` serves this to `human`, polled every 2 s while pending.

A relay status pill sits next to the hangar pill. It shows only when `missingBinaries` isn't empty or there are queued actions, and reads "relay online", "relay offline since …", or "relay never checked in".

### 9. Amendments after planning

- **Where the relay's code lives.** Its TypeScript goes in `apps/web/server/relay/` and runs as `node --import tsx` with working directory `apps/web`. That lets it reuse `createReviewWriter` and `createBeadsWatcher`, which live in `apps/web/server`, not core.
- **The `review_decision` payload** is `{ project_key, cwd, issue_id, decision, message, option?, seen? }`. It has no `notify` field: the writer takes the recipient only from `bd show`, as it does locally. `seen` is required whenever an option is chosen.
- **In queue mode, the review router** skips the writer/`bd` presence check and the `stat` of the checkout, because that is a Mac path. The store checks still run.
- **Ingest split.**
  - Compute takes an injected `priorThreads` lookup: the database locally, an in-memory cache on the relay.
  - The wire carries raw `issues` and `comments`, never prepared nodes. The server builds every node with `mapBeadsIssueToNode` and the registry node from the path it already has registered, so a leaked relay token can't re-point the registry.
  - The push cap is 8 MiB, and pushes are serialized per project.
- **Allowlist.** It also covers the two read-only ingest commands, `bd list --status=all --limit=0 --json` and `bd comments <id> --json`. No free-text argument may start with `-`. `bd` text is capped at 4000 characters and herdr text at 8000, since an inbox note plus its title can exceed 4000. The socket must be on disk.
- **Indexes and attempts.**
  - The partial index is `(created_at, id) WHERE state IN ('queued','claimed')`, so it serves the reclaim predicate too.
  - An `attempts` column fails an action after 3 claims without a report.
  - A unique open-target index on `(kind, project_key, issue_id)`, excluding `herdr_prompt`, makes a second pending decision on the same review a CONFLICT.
- **Board.** `boardEvents` stops refusing when `bd` is missing. The watcher gains `record()`, so a pushed load emits the same events. `refreshBoard` queues one `beads_reingest` per project.
- **Request plumbing.** Hangar's request plumbing moves to `apps/web/server/json-api.ts`, with the body cap as a parameter. The hangar API's behavior and its contract test stay byte-identical. Relay ids are bigserial: `^\d{1,18}$`.
- **A relay on the server's own host is never admitted with its token,** because loopback is trusted as the local person. The relay is meant for another host, so the end-to-end test goes through a forwarding proxy.
- **On the Mac,** the launchd plist sets `PATH` to the directories holding `bd` and `herdr`, resolved when the service is installed. The token file must be 0600, a regular file, and owned by the user.
- **`relayStatus` and `relayAction`** are `human`-only.
- **Registering a new beads project after cutover** is out of scope; it needs `bd` on the Jetson, and a follow-up bead covers it.

## Risks / Trade-offs

- [A decision waits hours while the laptop is asleep] → It shows as pending, the pill says offline, and the action runs when the laptop wakes. A stale decision is guarded by `bd show`.
- [Double execution after the 5-minute reclaim, if the relay died between `bd` steps and its report] → An accept re-checks via `bd show` and reports "already applied". A `changes` decision leaves the review open, so a re-run posts its comment twice. That needs a relay death mid-decision; a worst-case decision takes about 160 s, against the 300 s reclaim. A `herdr_prompt` could be delivered twice. Reporting an already-finished action is a no-op.
- [A leaked relay token] → It can claim the person's queued decisions (delay or drop them), read herdr reply text, and push beads batches for registered projects. It can't run anything on the Mac by itself, because the allowlist runs there. Revoke it with the CLI.
- [A forged beads batch from a leaked relay token] → It can only upsert under source `beads` for registered projects, and the next real ingest overwrites it.
- [The checkout path differs between Mac and Jetson] → Paths come from the relay's registry, which mirrors the Mac's own registration; Breakdown never needs to resolve them.

## Migration Plan

Migration 0009 is additive. On the Mac with binaries present, nothing changes. At cutover (bd-d38.10):
1. Mint a relay token: `pnpm -s client-token create relay-laptop --scope relay`.
2. Write it to the token file.
3. Run `pnpm relay:service install --url … --name relay-laptop`.

To roll back, uninstall the service; the Jetson's actions then wait, and the pill says offline.
