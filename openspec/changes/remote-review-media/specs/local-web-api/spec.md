## ADDED Requirements

### Requirement: Review media can be uploaded

The web server SHALL accept `PUT /review-uploads/<project>/<item-id>/<run>/<name>` with the file as the raw body and write it to `<media root>/<project>/<item-id>/<run>/<name>`. It SHALL accept `DELETE /review-uploads/<project>/<item-id>/<run>` and remove that run. Any other method or segment count SHALL be 405 with `Allow: PUT, DELETE`.

The server SHALL check the raw path, never decoded: every segment SHALL start with a letter or digit, hold only letters, digits, `.`, `_`, and `-`, and be at most 255 characters, else 400. A PUT's name SHALL end in png, jpg, jpeg, gif, webp, mp4, or webm, and its Content-Type, parameters ignored, SHALL be that extension's type, else 415. A PUT SHALL be refused with:
- 413 when its Content-Length, or the bytes it streams, exceed 200 MiB;
- 503 with `Retry-After: 1` when two uploads are already in flight;
- 507 when the volume would be left with less than 1 GiB free, or fewer than max(1000, 1% of its) free inodes.

The run directory SHALL be refused with 403 when a symlink lies anywhere on its path inside the root, and with 409 when a file sits where a directory belongs. The request that creates a run SHALL record its client as the run's owner; a tokenless loopback request counts as human. A PUT into an existing run, or a DELETE of one, SHALL be admitted only for its owner or a `human` token, and refused with 403 otherwise. With `BRAIN_READ_ONLY`, every PUT and DELETE SHALL be refused with 403 `read_only`.

A PUT SHALL write to a temporary file in the run directory, fsync it, link it to the target without replacing an existing file (an existing name is 409), fsync the directory, and answer 204. A failed PUT SHALL leave no temporary file and none of the empty directories it created. A DELETE of a missing run SHALL answer 204. A DELETE of anything but a real directory SHALL answer 409 and remove nothing. The route SHALL log no header and no body.

#### Scenario: A climbing path is refused

- **WHEN** a client PUTs `/review-uploads/../i/r/01-a.png` or `/review-uploads/p/%2e%2e/r/01-a.png`
- **THEN** the server answers 400 and writes nothing

#### Scenario: A symlinked parent is refused

- **WHEN** `<media root>/p` is a symlink to a directory outside the root and a client PUTs `/review-uploads/p/i/r/01-a.png`
- **THEN** the server answers 403 and creates nothing outside the root

#### Scenario: Over the cap

- **WHEN** a client PUTs a body with `Content-Length` over 200 MiB, or streams a chunked body past it
- **THEN** the server answers 413, and neither the file nor a temporary file remains

#### Scenario: A file is never replaced

- **WHEN** a client PUTs `01-a.png` into a run twice with different bodies
- **THEN** the first answers 204 and the second 409, and `01-a.png` keeps the first body, mode 0644

#### Scenario: Another worker's run

- **WHEN** worker-1's `agent` token created a run and worker-2's `agent` token PUTs into it or DELETEs it
- **THEN** both are refused with 403, and a `human` token's DELETE of the run answers 204
