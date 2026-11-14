## MODIFIED Requirements

### Requirement: Nodes can be listed by structure without query text

The store SHALL return canonical nodes matching structural filters with no search text: node types, source systems, updated at or after an instant, and predicates on top-level metadata keys where a key equals a scalar value, is one of a small set of scalar values, or is an array that contains a scalar value. Predicates SHALL be validated data, never an expression the caller composes. Results SHALL be ordered most recently updated first with a deterministic tie-break, bounded by a caller-supplied limit, and pageable by a cursor that never repeats or skips a node. Merged-away nodes SHALL NOT be listed. Metadata predicates SHALL be served by an index rather than a scan of every node's metadata.

#### Scenario: Listing by type and a metadata value

- **WHEN** a caller lists nodes of type `work_item` whose metadata `status` equals `open`
- **THEN** exactly the open work items are returned, newest first, and no closed item appears

#### Scenario: Membership predicate

- **WHEN** a caller lists nodes whose metadata `priority` is one of 0 or 1
- **THEN** items with priority 0 or 1 are returned and no other

#### Scenario: Array containment predicate

- **WHEN** a caller lists nodes whose metadata `labels` contains `review`
- **THEN** exactly the nodes whose `labels` array holds the string `review` are returned, and a node whose `labels` is the bare string `review`, or an array without it, is not

#### Scenario: Paging

- **WHEN** more nodes match than the limit
- **THEN** the response says more exist and a second request with the returned cursor continues without repeating or skipping a node

#### Scenario: Malformed predicate

- **WHEN** a predicate names an unknown operation or a non-scalar value
- **THEN** it is rejected naming the predicate, and nothing is queried

## ADDED Requirements

### Requirement: Nodes can be found by text and structure together

The store SHALL return canonical nodes matching optional search text together with node types, a set of projects (the top-level metadata `project`), and a reviews-only flag (metadata `labels` contains `review`). The same answer SHALL carry facet counts: matches per node type, per project, and reviews. Each count is taken under the text and every filter except its own. Text SHALL be matched with the same full-text parsing as retrieval's exact seed search, and results with text SHALL be ordered by text relevance, then most recently updated, then id. Results without text SHALL be ordered most recently updated, then id. Results SHALL be bounded by a caller-supplied limit, capped by the store, and pageable without repeats while the store is unchanged. Results and counts SHALL come from one statement. Merged-away nodes SHALL NOT be returned or counted. Every input SHALL be validated before anything is queried.

#### Scenario: Filters with no text

- **WHEN** a caller asks for reviews in project `collective` with no text
- **THEN** every `collective` node labelled `review` is returned newest first, and the counts report that number for reviews

#### Scenario: Text with a type filter

- **WHEN** a caller asks for text `cuts` with node type `gh-pr`
- **THEN** only pull requests matching `cuts` are returned, and the node-type counts still report the `cuts` matches of every other type

#### Scenario: Oversized request

- **WHEN** a caller asks for more than the store's maximum page size, or names more types or projects than allowed
- **THEN** the request is rejected naming the bound, and nothing is queried
