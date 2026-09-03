## Why

The store remembers only a node's current state. When a node's content, metadata, or merge pointer changes, the previous value is gone and the only trace is `updated_at`. That is fine for a cache of source files and fatal for the self-hosting goal (`bd-98d`): a work item whose status flips from open to closed, or whose priority is changed, has to be able to answer "what was it before, who changed it, and when". Ingest runs already record *which load* touched a node, but not *who was driving* — an agent session and a person editing in the web app are both just a run with a source system.

## What Changes

- Add an append-only **revision history for nodes**: every change to a node's type, title, content, metadata, or merge pointer records a full snapshot of the node as it was after the change, attributed to the ingest run that made it. Unchanged re-loads record nothing. Existing nodes get an initial revision at upgrade time so history never starts mid-stream.
- Add an **actor** to ingest runs: a free-text identity for whoever drove the write — the connected MCP client, the person in the web app, or a loader script — distinct from the source system, which stays the provenance of the *content*.
- Make **merges attributable**: a merge currently sets a node's merge pointer without any ingest run. It becomes a write like any other, attributed to a run, so the revision it produces names who merged what.
- Add a **history tool** to the MCP server: given a node id, return its revisions newest-first, each stating which fields changed versus the previous revision and, for metadata, which keys changed with their before and after values. Read-only, advertised in read-only mode, bounded like every other response.

## Non-Goals

- **No edge history.** Edge assert, retract, and reweight leave no revision trail yet. Edges are deleted on retract today; recording that needs a tombstone design that this change does not attempt.
- **No retention or pruning.** Revisions accumulate. At personal scale that is the right default; a pruning policy is a later decision informed by real growth.
- **No history UI.** The web app is untouched. The MCP tool is the first and only consumer.
- **No diff storage.** Revisions are full snapshots; what changed is computed when history is read, never when it is written.
- **No beads importer, no work-item schema.** This is the substrate those need, not those features.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `knowledge-store`: gains a revision record for every node change, an actor on ingest runs, attribution of merges to an ingest run, and a readable per-node history that states what changed between revisions.
- `brain-mcp`: gains a history tool; writes and merges made through the server are attributed to the connected client as actor.

## Impact

- `packages/db`: new `node_revisions` table, new nullable `ingest_runs.actor` column, one additive migration carrying a hand-written trigger and a one-time backfill. No column is added to `nodes`, so `resolved_nodes` is untouched.
- `packages/core`: `openIngestRun` accepts an actor; `mergeNodes` requires an ingest run handle (**BREAKING** for its one caller, the MCP merge tool, which is updated in the same change); new history query module; loaders and the human write path pass an actor.
- `apps/mcp`: one new tool, actor resolved from the MCP client's handshake, merge tool wrapped in an ingest run. Eight tools, not seven.
- No new dependency, no new environment variable, no model call.
