## ADDED Requirements

### Requirement: Finding nodes serves the search results view

The server SHALL expose a read that takes optional search text, node types, projects, a reviews-only flag, a limit, and a page position, and returns the matching nodes with their facet counts. Each node in the answer SHALL carry what a result row and its activation need: id, node type, source system, external id, title, last update, a highlighted snippet when there is text, and, where present, its project, status, closed time, and whether it is a review. It SHALL NOT return node content or full metadata. Inputs SHALL be bounded by the store's limits and rejected before any query when they exceed them. The answer SHALL fit the server's response budget, dropping from the tail and reporting that more exist rather than failing. The read SHALL be available when the server is read-only.

#### Scenario: Listing reviews for the results view

- **WHEN** the results view asks for reviews in project `collective` with no text
- **THEN** the response lists those reviews newest first with project, status, closed time and the review flag, plus counts per type, per project, and of reviews

#### Scenario: Response over budget

- **WHEN** the matching rows would exceed the response budget
- **THEN** the response carries the rows that fit, says more exist, and a following page continues after the last row returned

#### Scenario: Invalid input

- **WHEN** the request names an empty node type or a limit above the maximum
- **THEN** the server rejects it with a message naming the field, and no query runs
