## MODIFIED Requirements

### Requirement: Tokens carry a scope

Every token SHALL be created with a scope (`human`, `agent`, `hangar`, or `relay`), chosen at creation and shown when listing. Each web API procedure SHALL declare the scopes it admits, and a procedure that declares none SHALL be refused to every token, so that a new procedure must choose.

People's decisions SHALL admit `human` only. These are deciding, releasing, or handing off inbox items, review decisions and review sessions, notes and other human writes, and opening or focusing sessions. `inbox.request`, `inbox.complete`, and the reads that the inbox and review-request scripts use SHALL also admit `agent`. Review media uploads under `/review-uploads/` SHALL admit `human` and `agent`, and reading review media under `/review-images/` SHALL admit `human` only. Only the hangar endpoints SHALL admit `hangar`, and only the relay endpoints SHALL admit `relay`. The connect flow SHALL set a cookie only for a `human` token. The MCP server SHALL admit `human` and `agent`.

No agent write, through `inbox.request` or MCP `brain_write`, SHALL move an inbox item into a status only a person sets (`accepted`, `changes`, `dismissed`, or `session`) or write its feedback. A new item an agent writes SHALL be `pending`, whatever status it was sent with, and an existing item SHALL keep its stored status and feedback.

#### Scenario: Worker cannot approve its own request

- **WHEN** a worker holding an `agent` token calls the web API to decide an inbox item
- **THEN** it is refused with 403 and nothing is written

#### Scenario: Worker cannot approve its own item

- **WHEN** a worker writes an inbox item with status `accepted` and a feedback entry, as a new item or a re-send of a `pending` one, through `inbox.request` or `brain_write`
- **THEN** the item is stored `pending` with the person's feedback only, and nothing is approved

#### Scenario: Worker files a request

- **WHEN** a worker holding an `agent` token files an inbox request over the web API
- **THEN** the item is created, attributed to the worker's client

#### Scenario: Worker over MCP

- **WHEN** the same worker calls `/mcp` with its `agent` token
- **THEN** it is served

#### Scenario: Hangar token stays on its endpoints

- **WHEN** the `hangar` token calls a tRPC procedure, `/mcp`, or `/review-uploads/`
- **THEN** it is refused with 403

#### Scenario: Worker uploads media but cannot read it

- **WHEN** a worker holding an `agent` token PUTs `/review-uploads/bd/bd-1/<run>/01-a.png` and then GETs `/review-images/bd/bd-1/<run>/01-a.png`
- **THEN** the upload is admitted, and the read is refused with 403

#### Scenario: Relay token stays on its endpoints

- **WHEN** the `relay` token calls a tRPC procedure, `/mcp`, a hangar endpoint, `/review-images/`, or `/review-uploads/`
- **THEN** it is refused with 403

#### Scenario: Worker cannot claim relay actions

- **WHEN** a worker's `agent` token calls the relay claim endpoint
- **THEN** it is refused with 403 and no action changes
