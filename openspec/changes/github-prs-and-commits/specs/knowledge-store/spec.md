## ADDED Requirements

### Requirement: Nodes can be resolved by source identity

Given a batch of `(source system, external id)` pairs, the store SHALL answer, for each pair that names a node, the canonical node's id and type — a pair naming a merged-away node answers with its survivor — and SHALL list the pairs that name nothing, in one round trip. The batch SHALL be bounded by a documented limit, and a pair with an empty source system or external id SHALL be rejected before anything is queried. Nothing about the answer SHALL depend on the order of the pairs.

#### Scenario: Resolving a loader's cross-references

- **WHEN** a loader asks for `github`/`owner/name#12` and `github`/`owner/name#9999`, and only the first exists
- **THEN** the answer carries the first pair's canonical id and node type and names the second pair as not found

#### Scenario: A merged-away pair

- **WHEN** the node a pair names has been merged into another
- **THEN** the answer carries the survivor's id

#### Scenario: Malformed pair

- **WHEN** a pair's external id is empty
- **THEN** the request is rejected naming the pair, and nothing is queried
