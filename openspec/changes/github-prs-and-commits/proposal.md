## Why

`timeline-view` gave the store one place to put the moment an item happened and one view that orders by it, and its dogfood shows a repository's timeline as its open issues — because that is all the loaders write about a repository. The things a person actually asks a repository's history for, "what was merged, what changed, which commit touched this file", are pull requests and commits, and neither is loaded: the GitHub loader fetches repositories and open issues, the git loader mirrors a checkout's tree, and `git log` is called nowhere. This change writes both under the `occurred_at` contract, joined to the repository, the files they touch, and the issues they close or mention, so the timeline's headline example — a repository's issues, PRs, and commits interleaved newest first; a file's commits; a work item's PRs — is real data rather than a scenario.

**Depends on** `timeline-view` (unarchived; this change is stacked on its branch): the `occurred_at` contract every new node fills, the anchored read that folds merged endpoints, and the `relationLabel` helper the new edge types extend.

## What Changes

- **Pull requests in the GitHub loader.** `pnpm ingest:github` fetches every repository's pull requests in every state beside its open issues and writes one `gh-pr` node per PR under the same `owner/name#N` identity scheme issues use (GitHub numbers both from one sequence, so a `#N` reference resolves to whichever exists). Each carries its state, draft flag, merge and close instants, branches, author, labels, and `occurred_at` at its creation. Edges: `belongs-to` the repository, `closes` each issue GitHub records it as closing, `mentions` each issue or PR its text references. Discovery no longer hides a repository that has pull requests but no issues.
- **Commits in the git loader.** `pnpm ingest:repo` walks `git log` newest first, bounded by a `--commits <N>` flag (default 500, `0` disables), and writes one `commit` node per commit under `<key>@<sha>` — subject as title, full message as content, author name, both dates, parents, and `occurred_at` at the committer date. Edges: `belongs-to` the repository root, `touches` each loaded file the commit changed, `mentions` each GitHub issue or PR its message references. Paths without a node and references that resolve to nothing are skipped and counted, never fatal. Commits land in the same all-or-nothing batch as the tree.
- **A lookup by source identity.** One new core read resolves a batch of `(source system, external id)` pairs to canonical node ids, folding merged-away rows to their survivors and naming the pairs it did not find. It is what lets a loader link its nodes to nodes another loader wrote, and it closes `bd-wq4`.
- **Two new edge types**, `closes` and `touches`, and two new node types, `gh-pr` and `commit`. Edge and node types are open text; nothing in the database or the validators enumerates them. The timeline's relation labels learn the two edge types.
- **The two `repo` nodes stay two nodes.** The GitHub loader's `owner/name` and the git loader's `<key>` root are the intended cross-system duplication the store's merge exists for; the dogfood merges them, and every read on this branch already folds aliases, so one timeline shows what both loaders wrote.
- **No schema change, no migration.**

## Non-Goals

- **No PR → file edges.** `gh` reports a PR's changed files, and a file's timeline could show its PRs beside its commits; that is a later slice once file timelines are in daily use. Commits already put the file's history in order.
- **No second moment per node.** A PR opens, merges, closes; it carries one `occurred_at` (creation), and its merge and close instants sit in metadata for a later per-node fan-out, as `timeline-view` deferred.
- **No review comments, check runs, releases, or tags.** Each is its own node type and fetch; none is needed to make the repository timeline read.
- **No commit → symbol or import edges** (`bd-aow`'s original scope), and **no stale-node sweep** (`bd-aow.3`): a commit whose file was deleted simply has no `touches` edge to it.
- **No MCP exposure** of the identity lookup or a timeline tool; the loaders are the consumers this change has.
- **No automatic merge of the two repository nodes.** A loader that merged on a person's behalf would be deciding identity; `brain_merge` from a session is how that decision is made and attributed.

## Capabilities

### New Capabilities

- `github-ingest`: what `pnpm ingest:github` loads and how — repositories and open issues as it does today, stated as requirements for the first time, plus pull requests, their `belongs-to`/`closes`/`mentions` edges, and discovery that covers PR-only repositories.

### Modified Capabilities

- `git-repo-ingest`: an added requirement — recent commits are loaded with the files they touch and the references they make, bounded, with skips counted, in the tree's batch.
- `knowledge-store`: an added requirement — nodes can be resolved by source identity in a batch, folded through merges, with missing pairs reported.
- `timeline-view`: the "timed neighbours newest first" requirement gains scenarios for a repository's interleaved issues, PRs, and commits, a file's commits, and a PR row's `closes` relation.

## Impact

- `packages/core`: `github.ts` gains the PR type, `mapGhPrToNode`, `CLOSES_EDGE_TYPE`, and a known-id set covering both kinds in `deriveMentionEdges`; `ingest-github.ts` gains the PR fetch, the widened discovery predicate, and the `closes` edges; `git-repo.ts` gains `parseGitLog`, commit node building, `TOUCHES_EDGE_TYPE`, commit edge resolution with skip counts, and `loadGitRepoTree` writing commits in the tree's transaction; `ingest-git-repo.ts` gains `--commits` and the `git log` call; `lookup.ts` gains `getNodesByExternalId`; `index.ts` exports. Tests: PR mapping and edges, `parseGitLog` on a literal log, a db-backed commit load under a unique key with a real `git init` fixture (the first in this repo), the identity lookup's folding and not-found reporting.
- `apps/web`: `src/lib/timelineRow.ts`'s `relationLabel` gains `closes` and `touches`.
- `apps/mcp`, `packages/db`: untouched.
- Data: a full `pnpm ingest:github` grows the `github` source by several thousand PR nodes across the account's repositories (the largest holds a few hundred); `pnpm ingest:repo` on this repository adds under a hundred commits.
- Rejected alternatives: loading commits through the GitHub API into the `github` source (couples the two loaders, needs the network for offline data, and a checkout without a GitHub remote would have no anchor); placing a PR at its merge instant (moves it when merged, the objection that ruled out `closed_at` for work items); a loader that merges the two repository nodes itself (identity is a person's call); wrapping the GitHub loader's nodes-then-edges write in a transaction (`upsertNodes` opens its own, and an edge-step failure is repaired by the next idempotent run).
