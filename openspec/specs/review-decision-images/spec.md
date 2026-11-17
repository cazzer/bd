# review-decision-images Specification

## Purpose
A person deciding a review on the board can attach screenshots to the decision, and the agent that asked for the review receives them as files it can open, whether the server runs `bd` itself or a laptop relay applies the decision.
## Requirements
### Requirement: The decision box takes pasted and dropped images

The message box of a review decision (accept or request changes) SHALL accept images pasted from the clipboard and image files dropped onto it, several at a time. It SHALL accept PNG, JPEG, GIF, and WebP only, at most 6 images per decision, each at most 10 MB. Each accepted image SHALL show as a thumbnail with a control that removes it before sending. A file it refuses (wrong type, too large, over the count) SHALL be named in a message beside the box, and the images already accepted SHALL stay. Pasting text SHALL still insert the text. Paste and drop SHALL work when the board is served over plain HTTP.

#### Scenario: Two screenshots pasted at once

- **WHEN** the person pastes a clipboard holding two PNG images into the decision box
- **THEN** two thumbnails appear under the box, and the message text is unchanged

#### Scenario: A refused file

- **WHEN** the person drops a PDF and a JPEG onto the box
- **THEN** the JPEG becomes a thumbnail, and a message names the PDF as not an image the decision can carry

#### Scenario: Over the count

- **WHEN** six images are attached and the person pastes a seventh
- **THEN** the seventh is refused with a message saying a decision carries at most 6 images, and the six stay

### Requirement: Images upload before the decision is sent

When a decision with images is sent, the board SHALL first upload every image through the review media upload route, into one new run under the review's project and item, named in attachment order (`01-<name>`, `02-<name>`, ...). Only when every upload succeeds SHALL the decision be sent, carrying the uploaded images' relative paths. If any upload fails, the board SHALL delete that run, SHALL NOT send the decision, and SHALL show which image failed and why, keeping the message and the thumbnails so the person can retry. A decision without images SHALL be sent exactly as before.

#### Scenario: An upload fails

- **WHEN** the person requests changes with three images and the second upload is refused with 507
- **THEN** no decision is recorded, the run is deleted, and the card says the second image could not be uploaded because the server is out of space

### Requirement: The decision validates its images

The review decision request SHALL accept an optional list of at most 6 image paths. Each path SHALL be relative, of the form `<project>/<item-id>/<run>/<name>` with the decision's own project and item, a name ending in png, jpg, jpeg, gif, or webp, and SHALL name a regular file inside the review media root (no symlink on its path). A request that breaks any of these SHALL be refused naming the path, before anything is written. A decision request SHALL remain `human`-only.

#### Scenario: Another review's image

- **WHEN** a decision on item `bd-1` carries the path `bd/bd-2/r1/01-a.png`
- **THEN** the request is refused naming that path, and nothing is written to the tracker

#### Scenario: A missing file

- **WHEN** a decision carries a well-formed path for its own item whose file does not exist
- **THEN** the request is refused naming that path

### Requirement: The decision records and delivers its images

When a decision carries images, the comment written to the tracker SHALL end with a line `Images:` followed by each image's relative path, one per line, and the whole comment SHALL stay within the existing review comment limit; a message too long to fit beside its images SHALL be refused, saying how many characters to cut, before anything is written. The notification to the requesting agent SHALL name each image as an absolute path to a file it can open on the agent's machine. Where the server applies the decision itself, those paths SHALL be inside the server's review media root. A decision without images SHALL produce exactly the comment and notification it produced before.

#### Scenario: Changes requested with two images on the Mac

- **WHEN** the server runs `bd` and the person requests changes on `bd-1` with message "Smoke is too dark" and two images
- **THEN** the comment reads `Changes requested: Smoke is too dark` then `Images:` and the two relative paths, and the agent is prompted `Review bd-1 changes requested: Smoke is too dark` followed by the two absolute paths under the media root

### Requirement: The relay delivers a queued decision's images

When the server queues a review decision for the laptop relay, the action's payload SHALL carry the image paths. The server SHALL serve `GET /relay/v1/actions/:id/media/:n` (`n` from 0) to a `relay` token only, and only while that token's client holds the claimed `review_decision` action `id`; it SHALL answer with the bytes of the action's `n`-th image and that image's content type, and 404 for any other action, index, or state, without saying which. No `relay` or `agent` token SHALL gain read access to `/review-images/`. The relay SHALL download every image of a claimed decision into its own state directory before writing the decision, and the notification SHALL name the downloaded files' absolute paths. If a download fails, the relay SHALL write nothing, report the action failed naming the image, and leave no partial download behind.

#### Scenario: A decision through the relay

- **WHEN** the board on a server without `bd` sends a request for changes with one image and the relay claims it
- **THEN** the relay fetches `/relay/v1/actions/<id>/media/0`, saves the file on the Mac, writes the comment with the image's relative path, and the agent's prompt names the saved file's absolute path

#### Scenario: Media of an action the relay does not hold

- **WHEN** a relay token requests `/relay/v1/actions/<id>/media/0` for an action that is queued, finished, or claimed by another relay
- **THEN** the server answers 404 and serves no bytes

#### Scenario: An agent token asks for decision media

- **WHEN** an `agent` token requests `/relay/v1/actions/<id>/media/0` or `/review-images/<path>`
- **THEN** the server refuses it with 403
