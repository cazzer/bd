## ADDED Requirements

### Requirement: Recent commits are loaded with what they touch

A load SHALL also write the checkout's most recent commits, newest first, up to a bound the caller sets (a documented default; zero disables commits entirely): one `commit` node per commit keyed by `<key>@<sha>`, with the subject line as title, the full message as content, and metadata carrying the sha, the parent shas, the author's name, the author and committer instants, and the number of files the commit changed; `occurred_at` SHALL be the committer instant. Each commit SHALL be joined to the repository root by a `belongs-to` edge of full weight and to each file it changed that this load wrote by a `touches` edge at a documented confidence below `belongs-to`. Each `#N` or `owner/repo#N` reference in the commit message, outside code spans and URLs, SHALL become a `mentions` edge to the GitHub issue or pull request with that identity when one exists in the store and the repository key is an `owner/name` slug. A changed path with no node in this load and a reference that resolves to nothing SHALL be skipped and counted, never fatal. Commits and their edges SHALL be written in the same all-or-nothing batch as the tree, and re-running over an unchanged checkout SHALL report every commit unchanged.

#### Scenario: A commit touching two loaded files

- **WHEN** the newest commit changed `src/a.ts` and `src/b.ts`, both loaded as `file` nodes
- **THEN** a `commit` node is written with its subject as title, `occurred_at` at its committer instant, a `belongs-to` edge to the root, and a `touches` edge to each of the two files

#### Scenario: A commit touching a file that no longer exists

- **WHEN** a commit within the bound changed a file that was later deleted from the checkout
- **THEN** the commit is loaded, no `touches` edge is written for the missing path, and the run's summary counts the skipped path

#### Scenario: A commit message referencing a loaded issue

- **WHEN** the repository key is `owner/name`, a commit message says "closes #12", and the store holds the GitHub issue `owner/name#12`
- **THEN** a `mentions` edge from the commit to that issue is written

#### Scenario: A key that is not a slug

- **WHEN** the repository key was overridden to `bd` and a commit message references `#12`
- **THEN** no `mentions` edge is written, the reference is counted as unresolved, and the load succeeds

#### Scenario: The bound

- **WHEN** the checkout has 300 commits and the caller asks for 50
- **THEN** exactly the 50 newest are written; a later run asking for 60 adds the next 10 and reports the first 50 unchanged

#### Scenario: Commits disabled

- **WHEN** the caller sets the bound to zero
- **THEN** the tree is loaded exactly as before and no `commit` node or edge is written
