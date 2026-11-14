## MODIFIED Requirements

### Requirement: Search is the entry point

The explorer SHALL open with no graph drawn. The graph SHALL draw from a query held in its address: the matching seed nodes together with their immediate neighbourhood. Submitting text in the graph view's search bar SHALL open the search results view for that text and the chosen node types, from which "Open in graph" returns to the graph drawing that query. The explorer SHALL NOT offer a view that renders the entire store at once.

#### Scenario: First query draws a bounded neighbourhood

- **WHEN** the graph is opened with a query in its address that matches nodes in the store
- **THEN** the seed nodes and their immediate neighbours are drawn, and nodes outside that neighbourhood are absent

#### Scenario: Submitting from the graph opens the results list

- **WHEN** a person submits text in the graph view's search bar
- **THEN** the search results view opens for that text, and choosing "Open in graph" there draws its neighbourhood in the graph

#### Scenario: Query matches nothing

- **WHEN** the graph's query returns no seeds from either exact or approximate matching
- **THEN** the explorer states that nothing matched and that both modes were tried, and the canvas stays as it was rather than clearing
