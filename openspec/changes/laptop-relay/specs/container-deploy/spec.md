## MODIFIED Requirements

### Requirement: Host-only features degrade cleanly

A feature that depends on a binary absent from the image (`bd`, `herdr`) SHALL NOT crash the server or block startup. Review decisions, herdr reply delivery, and beads re-ingest SHALL be queued for the laptop relay, as the laptop-relay capability defines, and shown as pending. Every other such feature SHALL report itself unavailable when used, with a message naming the missing binary. Those are session-opening actions: opening or focusing a herdr session.

#### Scenario: Review decision without bd

- **WHEN** a review decision that would run `bd` is submitted to the web server in the container
- **THEN** the decision is queued for the relay and reported pending, and the server keeps serving

#### Scenario: Opening a session without herdr

- **WHEN** a person asks the container's web server to open a herdr session
- **THEN** the caller gets an error naming `herdr` as unavailable, and the server keeps serving
