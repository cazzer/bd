## ADDED Requirements

### Requirement: Hangar reports capacity and per-session usage

A check-in's capacity SHALL follow a published shape:
- how many more sessions of each flavor fit now;
- why each other flavor doesn't fit;
- free RAM, CPU, VRAM, and disk;
- how many sessions are running or kept;
- total disk allocated and apparent;
- optionally, per-session disk usage (session id, allocated bytes, apparent bytes).

A reason that starts with `disk:` SHALL mean the disk budget is full. Breakdown SHALL store the latest capacity per hangar as sent, up to 10,000 characters serialized, along with the database time it arrived. A claim SHALL update liveness only, never the stored capacity or its time. A check-in with no capacity SHALL clear both. A field Breakdown can't read SHALL be treated as absent, and the check-in SHALL still be accepted and still count for liveness. The published contract SHALL document the shape, the `disk:` prefix, and that unknown fields are ignored.

#### Scenario: Latest capacity stored

- **WHEN** hangar checks in at 09:00 with `slots: {headless: 2}` and per-session usage for session S, then claims at 09:01
- **THEN** the stored capacity is that report, reported at 09:00, and hangar's last check-in is 09:01

#### Scenario: Capacity cleared

- **WHEN** hangar checks in with `capacity: null`
- **THEN** no capacity is stored for that hangar, and no reported time either

#### Scenario: A malformed field doesn't break check-in

- **WHEN** hangar checks in with `free: "lots"` and `slots: {headless: 1}`
- **THEN** the check-in succeeds, hangar is online, and reads see one headless slot and no free figures

### Requirement: A queued request says why it waits

Every queued session SHALL be readable with the reason it waits. The reason SHALL be computed from the latest check-ins and the session registry when read, and SHALL NOT be stored. Only hangars that are online SHALL count. The reasons, in order of precedence:

1. **offline:** no hangar is online. It SHALL name the time of the last check-in, or say that hangar has never checked in.
2. **unknown:** no online hangar has a fresh capacity: none reported one, or its last report is older than three check-in intervals. A stale report SHALL be named by its time.
3. **next:** some online hangar has room for the session's flavor. It SHALL say how many queued sessions of that flavor were requested before it.
4. **not_offered:** no online hangar's capacity names the flavor.
5. **disk_awaiting_review:** every online hangar that names the flavor blocks it on disk, and at least one ended session still holds a disk with no outcome. It SHALL quote hangar's reason. It SHALL list each such session with its work item (id, external id, title), and with the disk bytes hangar reported for it, when reported.
6. **capacity:** otherwise. It SHALL quote each blocking hangar's reason.

The reason SHALL be shown wherever a queued session is listed for a person or an agent: on the board and through MCP.

#### Scenario: Offline

- **WHEN** hangar last checked in at 09:00, it is now 11:00, and session Q is queued
- **THEN** Q waits because hangar is offline since 09:00

#### Scenario: Never seen

- **WHEN** no hangar has ever checked in, and session Q is queued
- **THEN** Q waits because hangar has never checked in

#### Scenario: No capacity reported

- **WHEN** hangar is online and its last check-in sent `capacity: null`
- **THEN** Q waits for an unknown reason, and the reason says hangar reported no capacity

#### Scenario: Stale capacity

- **WHEN** hangar is online by its claims, and its last capacity was reported ten minutes ago
- **THEN** Q waits for an unknown reason, and the reason says when the last capacity report was

#### Scenario: Next in line

- **WHEN** hangar is online with `slots: {headless: 1}`, and headless sessions P and Q are queued, P requested first
- **THEN** P waits with nothing ahead, and Q waits with one ahead

#### Scenario: Flavor not offered

- **WHEN** hangar is online with capacity naming only `headless`, and `display-godot` session Q is queued
- **THEN** Q waits because no online hangar runs `display-godot`

#### Scenario: Disk full of sessions awaiting review

- **WHEN** hangar is online and blocks `headless` with `disk: need 8192 MB, free 1200 MB`, and stopped sessions A and B still hold disks with no outcome, and A's usage is reported
- **THEN** a queued headless session waits on disk, the reason quotes hangar's text, and it lists A and B with their work items, with A's disk bytes and none for B

#### Scenario: Disk full, nothing awaiting review

- **WHEN** hangar blocks `headless` on disk and no ended session holds a disk without an outcome
- **THEN** a queued headless session waits on capacity with hangar's disk reason

#### Scenario: Other budget full

- **WHEN** hangar blocks `headless` with `ram: need 4096 MB, free 1200`
- **THEN** a queued headless session waits on capacity with that reason

#### Scenario: Another hangar has room

- **WHEN** one online hangar blocks `headless` on RAM and another online hangar has a headless slot
- **THEN** a queued headless session is next in line, not blocked
