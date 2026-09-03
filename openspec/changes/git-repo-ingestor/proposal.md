## Why

The brain holds this project's prose, its GitHub issues, and its beads, but not one line of its code — so an agent asked about `route.ts` has to leave the brain and read the checkout, and the planned code-editor view has nothing to render. This change is bead `bd-aow` cut down to the slice the view needs: the files themselves, arranged as a tree the store can walk. It ships first because both the view and the settings-inheritance design (`child_of` as the one containment relation) are waiting on it.

## What Changes

- Add a **git repository loader**, `pnpm ingest:repo <path>`, that enumerates a local checkout with `git ls-files` (so `.gitignore` is honoured for free) and writes one node per file and per directory under a new source system, `git`. File content is the source text, so every file is full-text searchable the moment it lands.
- Express the tree as **`child_of` edges**: file → its directory, directory → its parent, top-level entries → a root node for the repository. `child_of` already means "source is a child of target" (work-items spec); this change makes it the containment relation for a second kind of node, which is what the views design needs it to be.
- Give every file **flat, indexable metadata** — `path`, `language`, `size_bytes`, `blob_sha`, `line_count` — so `brain_list` can select "TypeScript files under 200 lines" with the predicates that already exist.
- Skip what cannot usefully be a node: binaries (NUL byte in the first 8 KiB), files over a size cap, symlinks, submodules, and known generated files (lockfiles, minified bundles, source maps). Skips are counted and reported, never silent.
- Re-running over an unchanged checkout reports every node unchanged; editing one file reports one updated. Nothing else about the write path changes — the loader is a client of `upsertNodes`/`upsertEdges` exactly as the beads and GitHub loaders are.

## Non-Goals

- **No commits, no symbols, no `imports`/`defines`/`mentions` edges.** Those are the rest of `bd-aow` and each is its own change; the tree is the slice the code view and the views design need.
- **No deletion.** A file removed from the checkout keeps its node and its `child_of` edge after the next run; it is simply never updated again. The store has no delete primitive and this change does not add one — a stale-file sweep is a follow-up, named in design.
- **No de-duplication against the markdown seed.** `pnpm db:seed` already writes `docs/` and `openspec/` markdown as `doc`/`openspec-*` nodes under source system `repo`. After this change those files exist twice, once per source system, which is exactly the "entity mentioned in two systems" case `brain_merge` exists for. Reusing source system `repo` was rejected: the upsert would rewrite each doc's `node_type` to `file` and strip the corpus-derived typing. Retiring the seed in favour of this loader plus a typing pass is a later decision.
- **No web or MCP surface.** Nothing new is exposed; `brain_search`, `brain_list`, and `brain_neighbors` already reach the new nodes.

## Capabilities

### New Capabilities

- `git-repo-ingest`: what the loader enumerates, what it skips, the node and edge shapes it writes, and how a re-run behaves.

### Modified Capabilities

- None. `child_of` keeps its existing meaning; the work-items spec's definition is referenced, not changed. The knowledge-store requirements (idempotent batch writes, attribution to an ingest run) are satisfied, not altered.

## Impact

- `packages/core`: new `git-repo.ts` (pure mapping from `git ls-files` rows and file bytes to `NodeInput`/edge candidates — the corpus.ts/github.ts split) and `ingest-git-repo.ts` (the script: runs `git`, reads files, opens one ingest run, batch upserts, prints a summary); exports; tests. Root `package.json` gains `ingest:repo`.
- `packages/db`: untouched. No migration, no column, no view replacement.
- `apps/mcp`, `apps/web`: untouched. Nodes from source system `git` are read-only in the web app by the existing editability rule, which is the correct behaviour for a mirror of a checkout.
- No new dependency. The loader shells out to `git`, as the GitHub loader shells out to `gh` and the beads loader to `bd`.
- Store size: this repository is ~230 files; a large monorepo is tens of thousands of nodes and one `child_of` edge each, well inside what the chunked upsert already handles.
