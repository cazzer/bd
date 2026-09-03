# work-items Specification

## Purpose
Defines work items as first-class nodes in the store: the lifecycle contract their metadata obeys, how their fields are changed, what blocking and parent relationships mean, and what it means for an item to be ready to work on.
## Requirements
### Requirement: Work items carry a validated lifecycle contract

A work item SHALL be a node of type `work_item` whose metadata carries `status` (one of `open`, `in_progress`, `blocked`, `closed`, `deferred`), `priority` (an integer from 0, most urgent, to 4), and optionally `assignee`, `closed_at`, `closed_reason`, and `spec_id`. Other metadata keys SHALL pass through untouched. When a work item is created through a tool that knows the contract, a missing `status` SHALL default to `open` and a missing `priority` to 2. A work item entering `closed` SHALL have `closed_at` set to the time of closing if not supplied; a work item leaving `closed` SHALL have `closed_at` and `closed_reason` removed. A value outside the contract SHALL be rejected naming the field and the offending value, and nothing SHALL be persisted.

#### Scenario: Created with defaults

- **WHEN** a work item is written with a title and no status or priority
- **THEN** it is stored with status `open` and priority 2

#### Scenario: Invalid status

- **WHEN** a work item is written with status `done`
- **THEN** the write is rejected naming `status` and the value `done`, and no node is persisted

#### Scenario: Closing stamps the time

- **WHEN** an open work item's status is changed to `closed` without a `closed_at`
- **THEN** `closed_at` is set to the time of the change

#### Scenario: Reopening clears closing fields

- **WHEN** a closed work item with a `closed_reason` is changed to `open`
- **THEN** `closed_at` and `closed_reason` are absent afterwards

### Requirement: Work item fields are patched, not rewritten

A caller SHALL be able to change specific work-item fields without supplying the rest of the node. A patch SHALL be applied in one transaction attributed to an ingest run, SHALL leave title and content untouched, SHALL validate the resulting metadata against the contract, and SHALL be recorded as a revision. Two patches to the same item at the same time SHALL serialize so the second sees the first's result. A patch that changes nothing SHALL report as unchanged. A patch aimed at a node that is not a work item SHALL be rejected naming the node's actual type. A patch aimed at a merged-away node SHALL apply to its survivor.

#### Scenario: Status patch

- **WHEN** a work item's status is patched from `open` to `in_progress`
- **THEN** only `status` changes, the node's title and content hash are unchanged, and the node's history shows one new revision attributed to the patching run

#### Scenario: Not a work item

- **WHEN** a patch targets a node of type `file`
- **THEN** it is rejected naming the node and the type `file`

#### Scenario: Concurrent patches

- **WHEN** two callers patch different fields of the same item at the same time
- **THEN** both changes are present afterwards and the item has two new revisions

### Requirement: Blocking and parent relationships

An edge of type `blocks` SHALL mean the source must be closed before the target can be worked. An edge of type `child_of` SHALL mean the source is a child of the target. Endpoints that have been merged SHALL be treated as the surviving node. A `blocks` edge that would make any node transitively block itself SHALL be rejected, naming the two endpoints of the refused edge, and nothing from that write SHALL be persisted. Deciding this SHALL cost time polynomial in the graph's size, never proportional to its number of paths.

#### Scenario: Direct cycle rejected

- **WHEN** A blocks B and a caller asserts that B blocks A
- **THEN** the assertion is rejected naming B and A as the refused edge's endpoints

#### Scenario: Self-block rejected

- **WHEN** a caller asserts that A blocks A
- **THEN** the assertion is rejected

#### Scenario: Indirect cycle rejected

- **WHEN** A blocks B and B blocks C and a caller asserts that C blocks A
- **THEN** the assertion is rejected and the existing two edges are unchanged

#### Scenario: Cycle through a merge

- **WHEN** A blocks B, B blocks C, and C is merged into A
- **THEN** the merge succeeds, and readiness reports A and B as cycle members rather than ready

### Requirement: Readiness

A work item SHALL be ready when its status is `open`, no `blocks` edge into it comes from a source that is not a closed work item, and it does not reach itself through `blocks` edges from non-closed sources. The readiness report SHALL list ready items, blocked items with the ids of their open blockers, and cycle members, each bounded by a limit. A blocker that is not a work item SHALL count as open. Ready items SHALL be ordered by priority, then most recently updated.

#### Scenario: All blockers closed

- **WHEN** B is blocked only by A and A is closed
- **THEN** B is ready

#### Scenario: One open blocker

- **WHEN** B is blocked by A and A is in progress
- **THEN** B is not ready and is listed as blocked by A

#### Scenario: Blocker attached to a merged-away duplicate

- **WHEN** A blocks a node that was later merged into B, and A is open
- **THEN** B is listed as blocked by A

#### Scenario: Deferred and closed items

- **WHEN** an item is deferred or closed and has no blockers
- **THEN** it is neither ready nor blocked
