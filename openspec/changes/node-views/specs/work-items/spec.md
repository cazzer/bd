## MODIFIED Requirements

### Requirement: Blocking and parent relationships

An edge of type `blocks` SHALL mean the source must be closed before the target can be worked. An edge of type `child_of` SHALL mean the source is a child of the target. `child_of` SHALL be the one containment relation along which node settings — beginning with a node's default view — inherit from parent to child; an importer whose source has a hierarchy SHALL express that hierarchy as `child_of` edges and as no other edge type. Endpoints that have been merged SHALL be treated as the surviving node. A `blocks` edge that would make any node transitively block itself SHALL be rejected, naming the two endpoints of the refused edge, and nothing from that write SHALL be persisted. Deciding this SHALL cost time polynomial in the graph's size, never proportional to its number of paths.

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

#### Scenario: Settings inherit along child_of

- **WHEN** an epic declares a default view and a task that is `child_of` that epic declares none
- **THEN** the task's effective default view is the epic's
