## ADDED Requirements

### Requirement: Hangar tools report capacity and why requests wait

The hangar status tool SHALL return the latest hangar's capacity as Breakdown read it and when it was reported, or say that none was reported. The session listing tool SHALL return, on each queued session, the reason it waits, with the same reasons the board shows; when the disk is full, the response SHALL list the sessions awaiting review and their work items once, not on each queued session.

#### Scenario: Status with capacity

- **WHEN** an agent calls the status tool after hangar checked in with `slots: {headless: 2}`
- **THEN** it receives online, the counts, two headless slots, and when that capacity was reported

#### Scenario: Waiting on review

- **WHEN** an agent lists queued sessions while hangar blocks their flavor on disk and stopped session A holds a disk with no outcome
- **THEN** each queued session carries a disk-awaiting-review reason, and the response lists A and its work item once
