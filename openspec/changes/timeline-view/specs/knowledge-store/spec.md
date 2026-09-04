## ADDED Requirements

### Requirement: Nodes may carry a validated event time

Any node's metadata MAY carry `occurred_at`: the moment a person would place the item at on a timeline, as distinct from when the store first saw it or last rewrote it. Every write path that applies a metadata contract SHALL normalize `occurred_at` before anything is persisted, on nodes of every type: a value that parses as an instant SHALL be rewritten to one canonical form — ISO-8601, UTC, millisecond precision, fixed width — so that lexical order equals chronological order and no reader parses; an absent or null value SHALL leave the node with no event time and no `occurred_at` key; any other value SHALL be rejected naming the item and `occurred_at`, and nothing from that write SHALL be persisted. A loader whose source records when an item was created SHALL write that instant as `occurred_at`; a loader whose source records no event SHALL write none. Keys the contract does not name SHALL pass through unchanged.

#### Scenario: A time in another zone is canonicalized

- **WHEN** a writer creates a node whose `occurred_at` is `2026-03-04T10:00:00+02:00`
- **THEN** the stored node's `occurred_at` is `2026-03-04T08:00:00.000Z`

#### Scenario: Absent means no position

- **WHEN** a writer creates a node with no `occurred_at`, or with `occurred_at` null
- **THEN** the node is stored without an `occurred_at` key and is not listed on any timeline

#### Scenario: Unparseable time

- **WHEN** a writer creates a batch containing a node whose `occurred_at` is `last Tuesday`
- **THEN** the whole write is rejected naming the item and `occurred_at`, and no node from the batch is persisted

#### Scenario: Loaders write the source's time

- **WHEN** the beads loader imports an issue created at a known instant, or the GitHub loader imports an issue or repository with a known creation instant
- **THEN** the resulting node carries that instant as `occurred_at` in canonical form, beside the loader's existing keys

#### Scenario: Re-running a loader backfills

- **WHEN** a loader that now writes `occurred_at` runs again over a source it loaded before this contract existed
- **THEN** every node whose source holds a time is reported updated and carries `occurred_at`, and nothing else about those nodes changes

### Requirement: A node's timed neighbours are readable in time order

Given an anchor node id, the store SHALL return the canonical nodes adjacent to the anchor by any edge in either direction that carry an event time, ordered by event time newest first with a deterministic tie-break, narrowed by node types and source systems validated exactly as structured listing validates them, bounded by a caller-supplied limit, and pageable by a cursor that never repeats or skips a node. Each node SHALL appear once, however many edges join it to the anchor, and SHALL be reported with its event time, its metadata, and the type and direction of the edge that joins it — the heaviest when several do — and never its content. Edge endpoints that have been merged SHALL be treated as the surviving node, so that an edge attached to a merged-away alias of the anchor or of a neighbour still counts; the anchor itself SHALL NOT be listed. The answer SHALL also count the adjacent canonical nodes matching the same narrowing that carry no event time. A malformed anchor id SHALL be rejected before anything is queried; an id that names no canonical node SHALL be reported as not found.

#### Scenario: Newest first, one row per node

- **WHEN** a repository has two issues joined by one edge each and a third joined by two edges, all with event times
- **THEN** three rows come back, newest event first, the doubly-joined issue once with its heavier edge's type and direction

#### Scenario: Narrowing by type

- **WHEN** a caller asks for a repository's timeline narrowed to `gh-issue`
- **THEN** only issues are returned, and the untimed count covers only issues without an event time

#### Scenario: Merged alias of the anchor

- **WHEN** an issue's `belongs-to` edge points at a repository node that has since been merged into another, and the caller asks for the survivor's timeline
- **THEN** the issue is listed

#### Scenario: Paging

- **WHEN** more timed neighbours exist than the limit
- **THEN** the answer says more exist, and a second request with the returned cursor continues without repeating or skipping a node

#### Scenario: Untimed neighbours are counted

- **WHEN** an anchor has four neighbours matching the narrowing, one of which carries no event time
- **THEN** three rows come back and the count of untimed neighbours is one

#### Scenario: Unknown anchor

- **WHEN** the anchor id is well-formed but names no node
- **THEN** the read reports not found and nothing is listed

#### Scenario: Malformed anchor

- **WHEN** the anchor id is not a UUID
- **THEN** the read is rejected and nothing is queried
