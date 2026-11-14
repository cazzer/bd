## Purpose

Lets a person find any node, and in particular an old review, from wherever they are in the explorer. A search from any view opens one address-held list that narrows by node type, project, and reviews only.

## ADDED Requirements

### Requirement: Every view offers search

Every view (graph, board, feed, code, timeline, inbox, and the results view itself) SHALL show a search box in its header. Submitting it SHALL navigate to the results view, carrying the submitted text. On the results view, the box SHALL also carry the filters currently chosen. Submitting whitespace-only text SHALL open the results view with no text rather than doing nothing.

#### Scenario: Searching from the board

- **WHEN** a person on the board types `island cuts` into the header search box and submits
- **THEN** the address becomes the results view for `island cuts` and the matching nodes are listed

#### Scenario: Searching from the graph

- **WHEN** a person submits text in the graph view's search bar with node-type chips chosen
- **THEN** the results view opens for that text with those node types already chosen as filters

### Requirement: Results are held in the address

The results view's text, chosen node types, chosen projects, and the reviews-only filter SHALL be held in the address, so a reload, a shared link, or back/forward shows the same results. Changing a filter SHALL replace the address entry rather than push a new one. Submitting new text SHALL push one.

#### Scenario: Reload keeps the filters

- **WHEN** a person reloads the results view with text `cuts`, project `collective`, and reviews only chosen
- **THEN** the same text and filters are applied and the same results are listed

#### Scenario: Back returns to the previous query

- **WHEN** a person submits `cuts`, then submits `reel`, then goes back
- **THEN** the results for `cuts` are shown with the filters they had

### Requirement: Results narrow by type, project, and review

The results view SHALL offer three filters: node type, project, and reviews only. Each option SHALL show how many results it would give, counted against the text and the other two filters. Several types or several projects MAY be chosen at once, and a node matching any chosen value of a filter passes that filter. With no text, the view SHALL list every node that passes the filters, most recently updated first. With text, results SHALL be ordered by relevance, then most recently updated. Nodes without a project SHALL pass the project filter only while no project is chosen.

#### Scenario: All reviews in one project

- **WHEN** a person opens the results view with no text, project `collective`, and reviews only
- **THEN** every review labelled in `collective` is listed newest first, including ones closed long enough ago that the board no longer shows them

#### Scenario: Facet counts follow the other filters

- **WHEN** text `cuts` is submitted and project `collective` is chosen
- **THEN** each node-type option's count is the number of `cuts` matches in `collective` of that type, and each project option's count ignores the chosen project

#### Scenario: Nothing matches

- **WHEN** the text and filters match no node
- **THEN** the view says nothing matched and keeps the filters visible, so a filter can be removed

### Requirement: A result opens where it is best read

Activating a review result SHALL open that item's board drawer in its own project, which shows its question, options, attachments (screenshots and videos), comments and closed reason, whether or not the board's columns still show the card. Activating any other result SHALL open the graph with that node selected. The view SHALL offer "Open in graph" for the current text, which opens the graph drawing that text's matches.

#### Scenario: Opening an old review

- **WHEN** a person activates a closed review result from project `collective`
- **THEN** the board for `collective` opens with that review's drawer showing its attachments and decision

#### Scenario: Opening a pull request

- **WHEN** a person activates a `gh-pr` result
- **THEN** the graph opens with that node selected

### Requirement: Results are bounded and pageable

The results view SHALL show a bounded first page and SHALL offer to load more while more results exist. A loaded page SHALL NOT repeat a result already shown for the same text and filters.

#### Scenario: Loading more

- **WHEN** more reviews match than one page holds and the person asks for more
- **THEN** the next results are appended, none repeated, until none remain
