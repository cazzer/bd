## ADDED Requirements

### Requirement: The view is addressable

The explorer SHALL be served under a named view path, `/graph`, and SHALL reflect its submitted search and current selection in the page URL so that the same state can be reloaded, bookmarked, shared, and revisited with the browser's back and forward controls. The URL SHALL carry the query as last submitted, the node-type filters it was submitted with, and the selected node's id. The URL SHALL NOT carry exploration state (expansions, pan, zoom), transient reading aids (type focus, detail panel size), or pending edits (typed text or filter changes not yet submitted).

#### Scenario: Landing a search updates the address

- **WHEN** a person submits a query with zero or more type filters and a result is drawn
- **THEN** the URL is `/graph` with that query and each of those filters as parameters, and a new history entry was added

#### Scenario: A query that matches nothing leaves the address alone

- **WHEN** a person submits a query that matches nothing and the canvas stays as it was
- **THEN** the URL still names the search whose result is drawn, not the query that matched nothing

#### Scenario: Selecting a node updates the address without a history stop

- **WHEN** a person selects a node, or closes the detail panel
- **THEN** the URL gains or loses that node's id as a parameter, and no new history entry was added

#### Scenario: A deep link reproduces its search and selection

- **WHEN** a person opens `/graph` with a query, filters, and a node id in the URL
- **THEN** the search box shows the query, the filters are shown as chips, that search is run with those filters, the named node is selected with its detail open, and its neighbours are expanded exactly as a click on it would have done

#### Scenario: A deep-linked node outside the result is still shown

- **WHEN** the node id in the URL is not among the nodes the search returned
- **THEN** that node is fetched and drawn on its own, alongside the search result, and selected

#### Scenario: A deep-linked node that does not exist is dropped

- **WHEN** the node id in the URL names no node in the store
- **THEN** the search result is shown with nothing selected, and the URL is rewritten without the node parameter, with no history entry added

#### Scenario: Filters alone, with no query, restore chips without searching

- **WHEN** a person opens `/graph` with type filters but no query
- **THEN** the filters are shown as chips, no search is run, and the canvas is empty

#### Scenario: Back and forward re-apply the address

- **WHEN** a person uses the browser's back or forward control and the URL's search differs from the one drawn
- **THEN** that search is re-run with the URL's filters and its selection applied, replacing the drawn graph

#### Scenario: Back and forward with only the selection changed

- **WHEN** a person uses the browser's back or forward control and only the node parameter differs from the current state
- **THEN** the drawn graph is kept as it is and the selection is changed to match the URL

#### Scenario: The root path redirects to the named view

- **WHEN** a person opens `/`, or a path that is not a known view, with or without parameters
- **THEN** the address is replaced with `/graph` carrying the same parameters, and no history entry was added

#### Scenario: Malformed parameters degrade to defaults

- **WHEN** the URL carries an empty query, empty or duplicate filters, or an empty node parameter
- **THEN** the explorer opens with those parameters treated as absent (duplicates collapsed), without an error
