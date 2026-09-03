## Purpose

Mirrors a local git checkout into the store as a tree of file and directory nodes joined by `child_of` edges, so source code is full-text searchable and a code view has a tree to render.

## ADDED Requirements

### Requirement: A checkout is enumerated as git sees it

The loader SHALL take the path of a local git checkout and enumerate exactly the files git tracks there, so ignored and untracked files are never loaded. Symlinks and submodule entries SHALL be skipped. Each loaded file SHALL become a node of type `file` and each directory on the path from a loaded file up to the repository root SHALL become a node of type `directory`, both under source system `git`. The repository itself SHALL become a node of type `repo` under source system `git`. Every node's external id SHALL be derived from a stable repository key and the entry's repository-relative path, so the same checkout loaded twice yields the same identities. The key SHALL be the checkout's `origin` remote in `owner/name` form when one exists, otherwise the checkout directory's name, and a caller SHALL be able to override it.

#### Scenario: Ignored file is not loaded

- **WHEN** a checkout contains `node_modules/x.js` matched by `.gitignore` and a tracked `src/a.ts`
- **THEN** a `file` node exists for `src/a.ts` and none for `node_modules/x.js`

#### Scenario: Directories on the path are materialized

- **WHEN** the only tracked file is `packages/core/src/a.ts`
- **THEN** `directory` nodes exist for `packages`, `packages/core`, and `packages/core/src`, and a `repo` node exists for the root

#### Scenario: Same checkout loaded twice

- **WHEN** the loader runs twice over an unchanged checkout
- **THEN** the second run reports every node and edge unchanged and creates nothing

### Requirement: The tree is expressed with child_of edges

Every `file` and `directory` node SHALL have exactly one `child_of` edge, under source system `git` with weight 1.0, to the node for its containing directory, or to the `repo` node when it sits at the root. A `repo` node SHALL have no `child_of` edge. `child_of` SHALL keep the meaning the work-items capability gives it: the source is a child of the target.

#### Scenario: Walking up reaches the root

- **WHEN** a file at `packages/core/src/a.ts` has been loaded
- **THEN** following `child_of` from its node visits `packages/core/src`, `packages/core`, `packages`, and ends at the `repo` node

#### Scenario: Root entry points at the repository

- **WHEN** a file at `README.md` has been loaded
- **THEN** its single `child_of` edge targets the `repo` node

### Requirement: File nodes carry source text and indexable metadata

A `file` node's content SHALL be the file's text, its title SHALL be the file's base name, and its metadata SHALL carry `path` (repository-relative, forward-slash), `size_bytes`, `line_count`, `blob_sha` (git's blob id for the tracked content), and `language` (derived from the extension, omitted when unknown), all as top-level scalars. A `directory` node's title SHALL be its base name and its metadata SHALL carry `path`. The `repo` node's title SHALL be the repository key and its metadata SHALL carry the key and the absolute path that was loaded.

#### Scenario: File is searchable by its contents

- **WHEN** `src/route.ts` containing the identifier `graphRouteFromSearch` has been loaded
- **THEN** a full-text search for `graphRouteFromSearch` returns that file's node

#### Scenario: Files are selectable by metadata

- **WHEN** TypeScript and Markdown files have been loaded
- **THEN** a structured listing with the predicate `language` equals `typescript` returns only the TypeScript files

#### Scenario: Edited file is reported updated

- **WHEN** one tracked file's text changes between two runs
- **THEN** the second run reports that file's node updated, its `blob_sha`, `size_bytes`, and `line_count` reflect the new text, and every other node is unchanged

### Requirement: Unloadable files are skipped and counted

The loader SHALL skip a file whose first 8 KiB contains a NUL byte, a file larger than 256 KiB, and a file whose name matches a fixed list of generated artifacts (package-manager lockfiles, minified bundles, source maps). A skipped file SHALL produce no node and no edge, and SHALL be counted by reason in the run's summary. A directory containing only skipped files SHALL still be materialized when it lies on the path of a loaded file, and otherwise SHALL not.

#### Scenario: Binary file is skipped

- **WHEN** a tracked PNG and a tracked `src/a.ts` are enumerated
- **THEN** only `src/a.ts` gets a node, and the summary reports one file skipped as binary

#### Scenario: Oversized file is skipped

- **WHEN** a tracked 300 KiB text file is enumerated
- **THEN** it gets no node and the summary reports one file skipped for size

#### Scenario: Lockfile is skipped

- **WHEN** `pnpm-lock.yaml` is tracked
- **THEN** it gets no node and the summary reports one file skipped as generated

### Requirement: A load is one attributed, all-or-nothing batch

A run SHALL write all its nodes and edges under one ingest run whose source system is `git` and whose actor names the command that was run. If any node or edge in the run fails to write, nothing from that run SHALL be persisted, and the failure SHALL be reported with the offending path.

#### Scenario: Run is attributed

- **WHEN** a load completes
- **THEN** every node and edge it wrote names the same ingest run, and that run records the repository key, the path loaded, and the counts of files loaded and skipped by reason

#### Scenario: A file removed since the last run

- **WHEN** a file loaded by a previous run is deleted from the checkout and the loader runs again
- **THEN** its node and `child_of` edge remain, unchanged, and the run's summary does not mention it
