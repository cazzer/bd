## Context

Three loaders exist and share one shape: a pure mapping module (`corpus.ts`, `github.ts`, `beads.ts`) that turns already-fetched strings into `NodeInput`/edge candidates and is tested without a database, plus a script (`seed.ts`, `ingest-github.ts`, `ingest-beads.ts`) that shells out, opens one ingest run, calls `upsertNodes` then `upsertEdges`, and prints a summary. Edges are resolved from external ids to node ids after the node upsert returns (`resolveBeadsEdges`). `upsertNodes` chunks at 1000 rows, caps content at 1,000,000 characters, and reports created/updated/unchanged from `content_hash` and a metadata comparison; `annotateNode` shows how to compose a node write and an edge write inside one transaction through the `unsafe*` kit. `child_of` is defined by the work-items capability and written only by the beads loader today. `nodes.search` is a generated tsvector over title and content; Postgres refuses a tsvector over 1 MB. The markdown seed already owns `docs/` and `openspec/` under source system `repo` with the repo-relative path as external id. See proposal.md for why.

## Goals / Non-Goals

**Goals:**

- A tree the views work can walk upward with one indexed probe per level: every non-root node has exactly one `child_of` edge, always to its containing directory.
- Identities stable across runs, machines, and the presence or absence of a GitHub remote.
- Nothing the store cannot index usefully gets in: no binaries, no tsvector-breaking blobs, no lockfiles.

**Non-Goals:**

- Watching the checkout, incremental runs keyed on git history, or deleting stale nodes.
- Parsing anything inside a file. `language` comes from the extension, nothing else.
- Any coupling to the GitHub loader. The two `repo` nodes that result when both run are for `brain_merge`.

## Decisions

### `git ls-files -s` is the enumerator, and its blob id is the file's `blob_sha`

The script runs `git -C <path> ls-files -s -z` and parses `<mode> <sha> <stage>\t<path>` records. Mode `120000` (symlink) and `160000` (submodule) entries are dropped before anything is read from disk. The sha is git's blob id for the tracked content, recorded as `blob_sha`; it is what a future incremental run compares against. Content is then read from the working tree (not from the object store) so an uncommitted edit is what gets loaded — the loader mirrors the checkout, not the last commit.

The script first runs `git -C <path> rev-parse --show-toplevel`: on a path that is not a checkout this fails with git's own message before anything is read or any run is opened, and on one that is it names the checkout root, which is what gets enumerated and recorded as `root_path` — so `pnpm ingest:repo .` loads the whole repository even though pnpm runs the script from `packages/core` (a relative `<path>` resolves against the directory the command was typed in — not plain `INIT_CWD`: `pnpm run` resets `INIT_CWD` to its own cwd, and the root `ingest:repo` script is a nested `pnpm --filter @breakdown/core ingest:repo`, so the script would only ever see the workspace root; the root script captures its `INIT_CWD` into `INGEST_REPO_CWD` before the nested run, and the script reads that first, then `INIT_CWD` for a run from `packages/core` itself, then `process.cwd()`). `execFile`'s stdout cap is raised from its 1 MiB default to 256 MiB for `ls-files`: a `-s -z` record is ~60 bytes plus the path, so the default holds only a few thousand files.

*Rejected:* walking the filesystem with an ignore-file parser — duplicates git's rules imperfectly and needs a dependency. *Rejected:* `git show <sha>` per file — thousands of subprocesses for a value the working tree already has.

### The repository key comes from `origin`, falls back to the directory name, and can be overridden

`git -C <path> remote get-url origin` parsed to `owner/name` (both `git@github.com:owner/name.git` and `https://github.com/owner/name(.git)` forms) is the key when a remote exists; otherwise the checkout directory's base name. `pnpm ingest:repo <path> [--key <k>]` overrides it. External ids are `<key>` for the root, `<key>:<path>` for every entry. The `:` separator cannot appear in a GitHub slug or a directory name that git would produce on this platform, and it keeps `<key>` and `<key>:README.md` distinct.

This repository has no remote, so it loads under key `bd`. When it gains one, the next run under the derived key creates a second tree; the operator either passes `--key bd` or accepts the duplicate and merges. That edge is documented in the script's usage text rather than hidden by a heuristic.

*Rejected:* reusing the GitHub `repo` node (`source_system = 'github'`) as the root — requires a remote, couples two loaders' identities, and violates the one-source-per-node rule the dedup key encodes. *Rejected:* the absolute path as the key — not stable across machines.

### `child_of` is the tree, and each entry gets exactly one

For each loaded file, every ancestor directory is materialized (deduplicated across files) and each node — file or directory — gets one `child_of` candidate to its parent, with the root's children pointing at the `repo` node. Weight 1.0, source system `git`. A directory with no loaded files beneath it is not created, so an all-binary `assets/` directory does not appear. The work-items capability's meaning of `child_of` is reused verbatim, and its cycle-free property holds by construction here: a path tree cannot cycle. No new trigger is added; the views change that walks `child_of` upward owns its own cycle guard, because `brain_link` can write `child_of` freely.

*Rejected:* a separate `contains` edge kind — a second containment vocabulary is exactly what the views design found missing; one relation, one walk.

### Skips are decided before reading, then by a control-byte scan, and the size cap is 256 KiB

Order: generated-file name list (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `bun.lockb`, `*.min.js`, `*.min.css`, `*.map`) → size from `stat` against 256 KiB → any byte from the store's control set (`CONTROL_CHAR_CODE_POINTS` in nodes.ts: NUL, the other C0 controls except tab, LF, and CR, and DEL) anywhere in the content, reported as `binary`. The scan covers the whole file rather than git's 8 KiB NUL window because `unsafePrepareNodes` rejects that set at any position and one rejected node aborts the whole load — a form feed in a Python file or an ANSI escape in a test snapshot would otherwise fail every file in the run. The set is imported, not restated, so the loader cannot drift from what the store refuses; a UTF-8 byte below 0x80 is its own code point, so the byte scan is exact. Each reason is counted separately and reported. 256 KiB is far below `upsertNodes`'s 1,000,000-character cap on purpose: the generated tsvector over a 1 MB source file can exceed Postgres's 1 MB tsvector limit and fail the whole batch with an error that names no path. 256 KiB of code produces at most a few hundred KB of tsvector. Every source file in this repository is under 60 KiB; the only casualty here is the lockfile, which the name list already drops.

An index entry with no file in the working tree (`stat` reports `ENOENT`) is a fourth reason, `missing`, skipped and counted rather than failed: a sparse checkout lists absent files by design, and a file removed with `rm` rather than `git rm` is simply not in the checkout the loader mirrors. A directory whose entries are all missing is not materialized, like one whose entries are all binary. Every other filesystem failure — a permission error, a directory where a regular file is tracked — is not a state of a checkout and fails naming the path. The stat, classify, and read step lives in `git-repo.ts` (`readWorkingTree`) rather than the script so these decisions are tested against a temp directory.

*Rejected:* failing on `ENOENT` — it would make every sparse checkout unloadable over a condition the summary can simply report. *Rejected:* `.gitattributes` `binary` lookups — most repositories do not declare them. *Rejected:* git's own heuristic, a NUL in the first 8 KiB — it answers "is this a binary" and not "will the store take it"; the loader needs the second answer. *Rejected:* a per-run `--max-size` flag — nobody tunes this per run; change the constant.

### Metadata is flat scalars; `language` is a small extension map

`{ path, size_bytes, line_count, blob_sha, language? }` with `language` from a fixed map (`ts`/`tsx` → `typescript`, `js`/`mjs`/`cjs`/`jsx` → `javascript`, `md` → `markdown`, `json`, `yaml`/`yml` → `yaml`, `sql`, `css`, `html`, `sh` → `shell`, `py` → `python`, `go`, `rs` → `rust`, `toml`) and omitted otherwise, so `brain_list`'s `equals`/`oneOf` predicates work on it unchanged and the GIN index serves them. `line_count` is the number of newline characters plus one when the text is non-empty and does not end in a newline. Directory metadata is `{ path }`; root metadata is `{ key, root_path }`.

*Rejected:* a nested `git: { … }` object — unfilterable by the predicates that exist.

### Titles are base names

A file's title is its base name (`route.ts`), a directory's is its base name (`lib`), the root's is the key. Title matches outrank body matches in search, so `route.ts` as a query hits the file directly. The full path is in `metadata.path` and the external id; the detail panel already shows the external id as origin.

*Rejected:* the full path as title — search for `lib` would then match every path containing it in the title tier.

### Directory content lists its direct children

A `directory` node's content is its direct children's base names, one per line, sorted. Cheap, deterministic, and it makes "which directory holds X" a text search. Adding a file changes its parent's content and reports one directory updated, which is truthful.

*Rejected:* empty content — the node is then findable only by title.

### Nodes and edges are written under one transaction

The script opens one ingest run (`actor: "ingest:repo"`), then runs the node upsert and the edge upsert inside a single `db.transaction`, the way `annotateNode` composes its note and edge through the `unsafe*` kit, so an edge batch failure leaves no half-loaded tree. Chunking stays inside the upsert functions. The run's close stats record the key, the path, and the skip counts by reason.

*Rejected:* the beads loader's two independent calls — acceptable there because a partial beads mirror is still a mirror; a file with no `child_of` edge is invisible to the tree walk and would look like a loader bug.

## Risks / Trade-offs

- [The markdown seed and this loader both hold `docs/**/*.md`] → documented in the proposal as intended duplication across source systems; `brain_merge` is the tool for it, and retiring the seed is a later decision.
- [A large monorepo means tens of thousands of nodes with content] → `upsertNodes` chunks at 1000 and the size cap bounds each row; the first run on a 50k-file repository is minutes, not seconds, and is a one-time cost. Not optimized further until measured.
- [Stale nodes after a file is deleted or renamed] → a rename is a new node plus a stale one. Explicitly out of scope; a sweep that retracts `git` nodes absent from the latest run is the natural follow-up, filed as a bead when this lands.
- [`git ls-files` on a path that is not a checkout] → the script fails before opening a run, with git's own message.
- [`brain_link` can write a `child_of` cycle among these nodes] → not this loader's problem to prevent; the views change's walk is cycle-safe by requirement.

## Migration Plan

No migration. Additive nodes and edges under a new source system; a bad run is auditable and identifiable by its ingest run. Rollback is not running it again.
