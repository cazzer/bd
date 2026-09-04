## Purpose

Loads the user's GitHub repositories, their open issues, and their pull requests into the store under the `github` source system, each at the moment it was created, joined to the repository and to the issues and pull requests they close or mention, so search has real prose to match and a repository's timeline has its history.

## ADDED Requirements

### Requirement: Repositories and open issues are loaded from the account

The loader SHALL discover the authenticated account's repositories through the GitHub CLI, or load exactly the repositories named on its command line, and for each SHALL write one `repo` node keyed by `owner/name` — carrying the repository's URL, visibility, default branch, primary language, owner, creation and update instants, and `occurred_at` at its creation — and one `gh-issue` node per open issue keyed by `owner/name#number`, carrying the issue's state, labels, author, URL, creation and update instants, and `occurred_at` at its creation, with the issue body as content. Each issue SHALL be joined to its repository by a `belongs-to` edge of full weight. A load SHALL be one ingest run attributed to the `github` source system and the loader as actor, and re-running it over unchanged sources SHALL create nothing and report every node unchanged.

#### Scenario: A repository with open issues

- **WHEN** the loader runs over a repository with three open issues
- **THEN** one `repo` node and three `gh-issue` nodes are written, each issue `belongs-to` the repository, and every node carries `occurred_at` equal to its GitHub creation instant in canonical form

#### Scenario: Re-run over unchanged sources

- **WHEN** the loader runs again and nothing on GitHub changed
- **THEN** no node or edge is created and the run reports every node unchanged

### Requirement: Cross-references become `mentions` edges

Every `#N` or `owner/repo#N` reference in a loaded issue's or pull request's title and body SHALL become a `mentions` edge to the referenced issue or pull request when the loader wrote that node in the same run, at a documented confidence below `belongs-to`. References inside fenced or inline code spans and inside bare URLs SHALL be ignored. A reference that resolves to no node the loader wrote, or to the referencing node itself, SHALL be skipped silently, and one referencing node SHALL carry at most one `mentions` edge to any one target however many times it is referenced.

#### Scenario: An issue mentions a pull request

- **WHEN** issue #12's body says "fixed by #40" and #40 is a pull request in the same repository
- **THEN** a `mentions` edge from #12 to #40 is written

#### Scenario: A reference in a code span

- **WHEN** an issue's body contains `` `#7` `` and no other reference
- **THEN** no `mentions` edge is written for it

#### Scenario: A reference to something not loaded

- **WHEN** an issue references `#9999`, which is neither an issue nor a pull request the loader wrote
- **THEN** no edge is written and the load succeeds

### Requirement: Pull requests are loaded in every state

The loader SHALL write one `gh-pr` node per pull request of each loaded repository, open, closed, or merged, keyed by `owner/name#number` in the same identity scheme as issues, carrying the pull request's state, draft flag, merge and close instants when present, creation and update instants, author, head and base branch names, URL, labels, and `occurred_at` at its creation, with the pull request body as content. Each pull request SHALL be joined to its repository by a `belongs-to` edge of full weight and to each issue GitHub records it as closing by a `closes` edge of full weight, when that issue is a node the loader wrote. The per-repository fetch SHALL be bounded by a documented limit.

#### Scenario: A merged pull request that closes an issue

- **WHEN** pull request #40, merged, is recorded by GitHub as closing issue #12
- **THEN** a `gh-pr` node for #40 is written with its merge instant in metadata and `occurred_at` at its creation, a `belongs-to` edge to the repository, and a `closes` edge to #12

#### Scenario: A pull request closing an issue that is not loaded

- **WHEN** a pull request is recorded as closing an issue that is closed on GitHub and therefore not among the loaded open issues
- **THEN** no `closes` edge is written for that issue and the pull request is still loaded

#### Scenario: Numbers do not collide

- **WHEN** a repository has issue #12 and pull request #40
- **THEN** their external ids are `owner/name#12` and `owner/name#40`, and a `#40` reference in any loaded text resolves to the pull request

### Requirement: Discovery covers repositories with pull requests

When discovering the account's repositories, the loader SHALL include every repository that has at least one issue or at least one pull request, and SHALL exclude a repository with neither.

#### Scenario: A repository with pull requests and no issues

- **WHEN** the account has a repository with forty pull requests and no issues
- **THEN** discovery includes it and its pull requests are loaded

#### Scenario: An empty repository

- **WHEN** the account has a repository with no issues and no pull requests
- **THEN** discovery excludes it
