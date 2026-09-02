## ADDED Requirements

### Requirement: Nodes can be listed by structure without query text

The store SHALL return canonical nodes matching structural filters with no search text: node types, source systems, updated at or after an instant, and predicates on top-level metadata keys where a key equals a scalar value or is one of a small set of scalar values. Predicates SHALL be validated data, never an expression the caller composes. Results SHALL be ordered most recently updated first with a deterministic tie-break, bounded by a caller-supplied limit, and pageable by a cursor that never repeats or skips a node. Merged-away nodes SHALL NOT be listed. Metadata predicates SHALL be served by an index rather than a scan of every node's metadata.

#### Scenario: Listing by type and a metadata value

- **WHEN** a caller lists nodes of type `work_item` whose metadata `status` equals `open`
- **THEN** exactly the open work items are returned, newest first, and no closed item appears

#### Scenario: Membership predicate

- **WHEN** a caller lists nodes whose metadata `priority` is one of 0 or 1
- **THEN** items with priority 0 or 1 are returned and no other

#### Scenario: Paging

- **WHEN** more nodes match than the limit
- **THEN** the response says more exist and a second request with the returned cursor continues without repeating or skipping a node

#### Scenario: Malformed predicate

- **WHEN** a predicate names an unknown operation or a non-scalar value
- **THEN** it is rejected naming the predicate, and nothing is queried
