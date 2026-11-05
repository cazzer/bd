## ADDED Requirements

### Requirement: Pending review queue read

The server SHALL expose a read of the pending review queue (see the `review-queue` capability for what is pending) that takes no input and returns the pending reviews oldest request first — each with its project key, bead id, title, summary line (at most 200 characters), image count, and request time — together with the total number pending. It SHALL return at most 100 reviews and report whether the list was cut short. It SHALL be one store read, SHALL NOT run a tracker command, and SHALL be served while the server is read-only.

#### Scenario: Reading the queue

- **WHEN** a browser reads the review queue while two projects hold three pending reviews
- **THEN** it receives the three, oldest first, with a total of three and no truncation

#### Scenario: More than the cap

- **WHEN** 120 reviews are pending
- **THEN** the read returns the 100 oldest, a total of 120, and reports truncation

#### Scenario: Read-only server

- **WHEN** the server runs read-only and a browser reads the review queue
- **THEN** the queue is returned
