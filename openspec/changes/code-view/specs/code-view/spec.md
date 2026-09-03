## Purpose

Gives the web app a code view: a `view` node's roots drawn as a file tree built from `child_of`, with the selected file's source shown read-only and highlighted by language, so a repository loaded into the store can be read the way a code host shows it.

## ADDED Requirements

### Requirement: A subtree can be read in one request

The store SHALL answer, for one root node, the set of nodes reachable from it downward along `child_of` edges — each with its parent, type, title, external id, and its `path` and `language` metadata when present — without any node's content. Edge endpoints that have been merged SHALL be treated as the surviving node. The walk SHALL terminate on a `child_of` cycle, SHALL stop at a documented depth bound, and SHALL return at most a documented number of nodes, reporting whether it was cut short. Nodes SHALL be ordered shallowest first, then by title, so that a truncated answer keeps the structure nearest the root.

#### Scenario: A loaded repository's tree

- **WHEN** a client asks for the subtree of a `repo` node the repository loader wrote
- **THEN** every directory and file under it is returned with its parent id, and the root itself is included as the one node with no parent in the answer

#### Scenario: Cut short

- **WHEN** a root has more descendants than the node bound
- **THEN** the answer holds the bound's worth of shallowest nodes, in order, and states that it was cut short

#### Scenario: A cycle below the root

- **WHEN** two nodes below the root are each other's `child_of` parent
- **THEN** the answer terminates, each node appears once at its shallowest depth, and nothing deeper than the depth bound is returned

#### Scenario: Root names no node

- **WHEN** a client asks for the subtree of an id that is malformed or names no canonical node
- **THEN** the request is rejected, and nothing is walked

### Requirement: The code view is addressable

The code view SHALL be reachable at `/code`, addressed by the id of a `view` node (`view`) and optionally the id of a node within its tree (`node`). Its roots SHALL be the nodes the view's filter selects. An address that names no view, a view that does not exist, or a node that is not under any of the view's roots SHALL be shown as a distinct empty state that keeps the address and offers a way to the graph; the view SHALL NOT redirect. The address SHALL be updated whenever a different node is opened, so that the address always names what is shown.

#### Scenario: Opening a repository view

- **WHEN** a person opens `/code?view=<id>` for a view whose filter selects one `repo` node
- **THEN** the tree pane shows that root expanded to its first level, and the file pane invites the person to choose a file

#### Scenario: Several roots

- **WHEN** the view's filter selects more than one root
- **THEN** each root is a collapsed top-level entry of the tree pane

#### Scenario: Deep link to a file

- **WHEN** a person opens `/code?view=<id>&node=<file id>` for a file under one of the view's roots
- **THEN** the tree is expanded along that file's ancestors, the file is marked selected, and its source is shown

#### Scenario: Node outside the view

- **WHEN** the address names a `node` that is not under any of the view's roots
- **THEN** the tree is shown as for no `node`, the file pane says the node is not in this view, and the address is left as it is

#### Scenario: No view named

- **WHEN** a person opens `/code` with no `view`, or with a `view` that names no view node
- **THEN** the page says so under a "Code" heading with a link to the graph, and the address is left as it is

#### Scenario: Reload reproduces the page

- **WHEN** a person reloads `/code?view=<id>&node=<id>`
- **THEN** the same tree expansion, selection, and file are shown

### Requirement: The tree pane is built from `child_of` and expanded per directory

Each entry of the tree pane SHALL show a node's title, directories before files, each group ordered by title. A directory SHALL be expandable and collapsible, and SHALL show its children only once expanded. Activating an entry SHALL open that node in the file pane and record it in the address as a new history entry, so that the browser's back control returns to the previously opened node. Activating a directory SHALL also expand it. When the tree read was cut short, the pane SHALL say that not every entry is shown.

#### Scenario: Expanding a directory

- **WHEN** a person expands a directory
- **THEN** its direct children appear beneath it, directories first, and nothing else in the tree moves

#### Scenario: Back returns to the previous file

- **WHEN** a person opens one file, then another, then presses the browser's back control
- **THEN** the first file is shown and selected again

#### Scenario: Truncated tree

- **WHEN** the subtree read for a root was cut short
- **THEN** the pane states that not every entry under that root is shown

### Requirement: The file pane shows a node's content by kind

For a `file` node the pane SHALL show its content read-only with line numbers, highlighted according to the node's `language` metadata when a grammar for that language is available and as plain text otherwise. For a `directory` node the pane SHALL show its children as activatable entries. For any other node the pane SHALL show its content as plain text. The pane SHALL show the node's path and SHALL offer to open the node in the graph. Nothing in the pane SHALL write to the store.

#### Scenario: A TypeScript file

- **WHEN** a person opens a `file` whose `language` is `typescript`
- **THEN** its source is shown with line numbers and TypeScript highlighting, and cannot be edited

#### Scenario: Unknown language

- **WHEN** a person opens a `file` with no `language` metadata, or one no grammar is available for
- **THEN** its source is shown with line numbers as plain text

#### Scenario: A directory

- **WHEN** a person opens a `directory`
- **THEN** the pane lists its children, and activating one opens it

#### Scenario: To the graph

- **WHEN** a person chooses to open the shown node in the graph
- **THEN** `/graph` opens with that node selected, and the browser's back control returns to the code view
