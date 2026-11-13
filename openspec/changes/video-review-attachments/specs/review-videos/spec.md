## Purpose

Lets an agent put a video — a generated reel, or several alternate cuts of one — on a decision card, and lets the person watch, compare, and annotate it on the board.

## ADDED Requirements

### Requirement: A card may carry video attachments

A card attachment of `kind: video` SHALL take `path` (relative to the card), and optionally `poster` (an image relative to the card), `caption`, `pair`, and `option`. `review-request` SHALL stage each video and poster under the review image root exactly as it stages images, numbering staged files by position in attachment order, and write their stored paths into the review. The legacy `images` list SHALL hold image attachments only.

The CLI SHALL refuse, filing nothing and naming the field, a video that is missing, not a regular file, not `.mp4` or `.webm`, or over 200 MB; a poster that is not an image; and a `.mov` with the remux command in the refusal. `normalizeReviewMetadata` SHALL map every review the CLI writes to itself.

#### Scenario: A reel filed for approval

- **WHEN** an agent files a card with `{ kind: video, path: reel.mp4, poster: reel.jpg, caption: "Cut 1" }`
- **THEN** the review holds the video and poster at their stored paths under the review's image directory, and the board shows the reel with its poster and caption

#### Scenario: A video over the cap

- **WHEN** a card attaches a 250 MB `reel.mp4`
- **THEN** `review-request` refuses with `attachments[0].path: video is 250 MB, over the 200 MB limit: reel.mp4` and files nothing

#### Scenario: A QuickTime file

- **WHEN** a card attaches `reel.mov`
- **THEN** `review-request` refuses naming `attachments[0].path`, saying it is not a video (mp4, webm), and prints `ffmpeg -i reel.mov -c copy reel.mp4`

### Requirement: Each option may carry its own cut

A video attachment's `option` SHALL name one of the card's option ids. The CLI SHALL refuse, and the normalizer SHALL mark invalid, an `option` that names no option, an `option` on a card without options, two videos naming the same option, and `option` set together with `pair`. The board SHALL show every option's video side by side in the card's option order, each headed by the option's id and label, the recommended one marked.

#### Scenario: Picking between two cuts

- **WHEN** a card offers options A and B with `recommend: A` and attaches `cut-1.mp4` with `option: A` and `cut-2.mp4` with `option: B`
- **THEN** the board shows cut 1 on the left under A (marked Recommended) and cut 2 on the right under B, and Accept chooses A

#### Scenario: An option that isn't offered

- **WHEN** a card with options A and B attaches a video with `option: C`
- **THEN** `review-request` refuses with `attachments[i].option: "C" names no option (options: A, B)`

### Requirement: The board plays videos as vertical reels

The board SHALL render each video as an inline 9:16 player that is muted, starts on click, shows native controls, loads metadata only until played, and has a Loop toggle that is on by default. An Enlarge control SHALL open the video in the board's lightbox, starting at the inline player's time, and closing the lightbox SHALL return the inline player to the lightbox's time. A video that cannot be loaded SHALL show its path as unavailable, as an image does.

#### Scenario: Enlarging a cut

- **WHEN** the person plays cut 1 to 0:05 and presses Enlarge
- **THEN** the lightbox plays the video from 0:05, and after the person closes it at 0:09 the inline player is at 0:09

### Requirement: Review media are served with byte ranges

`/review-images/` SHALL serve `.mp4` as `video/mp4` and `.webm` as `video/webm` under the same confinement as images, SHALL send `Accept-Ranges: bytes`, and SHALL answer a single satisfiable `Range` with 206, `Content-Range`, and exactly those bytes. An unsatisfiable range SHALL be answered 416 with `Content-Range: bytes */<size>`. A malformed or multi-range header SHALL be ignored and the whole file served. Other extensions, including `.mov`, SHALL be refused with 403.

#### Scenario: Safari probes a video

- **WHEN** Safari requests a stored 30,000-byte `01-reel.mp4` with `Range: bytes=0-1`
- **THEN** the server answers 206 with `Content-Range: bytes 0-1/30000`, `Content-Length: 2`, and the first two bytes

#### Scenario: A range past the end

- **WHEN** a request asks `Range: bytes=40000-` of a 30,000-byte video
- **THEN** the server answers 416 with `Content-Range: bytes */30000`

### Requirement: Notes can name a moment in a video

While a review's decision is open, each player SHALL offer a Note button showing its current time; pressing it SHALL append the time (`0:07 `, or `B 0:07 ` for option B's cut) on a new line of the changes-requested message and focus the message at its end. The message SHALL reach the requesting pane unaltered.

#### Scenario: Requesting changes at a timestamp

- **WHEN** the person pauses cut B at 0:07, presses Note, types `text too small`, and requests changes
- **THEN** the requesting pane receives `Review <id> changes requested: B 0:07 text too small`
