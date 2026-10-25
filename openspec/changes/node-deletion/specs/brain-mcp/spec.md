## ADDED Requirements

### Requirement: Delete and restore tools

The server SHALL expose a tool that deletes nodes and a tool that restores them. Both SHALL report what they actually changed, distinguishing nodes they altered from nodes that were already in the requested state, so an agent can tell a no-op from an effect.

Deletion SHALL accept either an explicit list of node ids or a structured selection of the same shape the listing tool already validates — never free query text, in keeping with this capability's rule that no arbitrary SQL reaches the model. A selection is the ergonomic form and the dangerous one: the case that motivated these tools was "remove all 78 `commit` nodes", which is one selection and 78 nodes. So a selection-based deletion SHALL additionally require the caller to state how many nodes it expects to remove, and SHALL be refused, deleting nothing, if the selection does not match exactly that many. An agent that has not just counted what it is about to remove cannot delete by selection at all.

#### Scenario: Deleting by id

- **WHEN** an agent deletes three nodes by id
- **THEN** the three are deleted and the tool reports three deleted

#### Scenario: Deleting a type in bulk

- **WHEN** an agent selects every node of one type, confirms the count it expects, and the store holds exactly that many
- **THEN** all of them are deleted and the tool reports the count

#### Scenario: The count is wrong

- **WHEN** an agent deletes by selection stating an expected count that does not match what the selection finds
- **THEN** the call is refused naming both numbers, and nothing is deleted

#### Scenario: Deleting something already deleted

- **WHEN** an agent deletes a node that is already deleted
- **THEN** the call succeeds and the node is reported as unchanged rather than deleted

#### Scenario: Restoring

- **WHEN** an agent restores a node it deleted
- **THEN** the node is returned by search again and the tool reports one restored

#### Scenario: No free-form selection

- **WHEN** a selection contains a predicate the listing grammar does not define
- **THEN** the call is refused and nothing is deleted

## MODIFIED Requirements

### Requirement: Read-only mode

The server SHALL support a read-only configuration in which write, link, merge, delete, and restore tools are not advertised and are refused if called.

#### Scenario: Read-only server receives a write

- **WHEN** the server is configured read-only and a write tool is invoked
- **THEN** the call is refused with an error explaining that the server is read-only, and nothing is persisted

#### Scenario: Read-only server receives a delete

- **WHEN** the server is configured read-only and the delete or restore tool is invoked
- **THEN** the call is refused with an error explaining that the server is read-only, and nothing is deleted or restored
