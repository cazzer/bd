## MODIFIED Requirements

### Requirement: A card may carry video attachments

A card attachment of `kind: video` SHALL take `path` (relative to the card), and optionally `poster` (an image relative to the card), `caption`, `pair`, and `option`. `review-request` SHALL stage each video and poster exactly as it stages images, numbering staged files by position in attachment order, and write their stored paths into the review. Against the local server, staging copies them under the review image root. With `BREAKDOWN_API` set, staging uploads them to that server, and the stored paths are relative to its media root. The legacy `images` list SHALL hold image attachments only.

The CLI SHALL refuse, filing nothing and naming the field, a video that is missing, not a regular file, not `.mp4` or `.webm`, or over 200 MB; a poster that is not an image; and a `.mov` with the remux command in the refusal. These checks SHALL run before any upload. The server SHALL refuse an upload over the same 200 MB cap. `normalizeReviewMetadata` SHALL map every review the CLI writes to itself.

#### Scenario: A reel filed for approval

- **WHEN** an agent files a card with `{ kind: video, path: reel.mp4, poster: reel.jpg, caption: "Cut 1" }`
- **THEN** the review holds the video and poster at their stored paths under the review's image directory, and the board shows the reel with its poster and caption

#### Scenario: A video over the cap

- **WHEN** a card attaches a 250 MB `reel.mp4`
- **THEN** `review-request` refuses with `attachments[0].path: video is 250 MB, over the 200 MB limit: reel.mp4` and files nothing

#### Scenario: A QuickTime file

- **WHEN** a card attaches `reel.mov`
- **THEN** `review-request` refuses naming `attachments[0].path`, saying it is not a video (mp4, webm), and prints `ffmpeg -i reel.mov -c copy reel.mp4`

#### Scenario: A reel filed against a remote host

- **WHEN** an agent with `BREAKDOWN_API` set files a card with `{ kind: video, path: cut.mp4, poster: cut.jpg }`
- **THEN** the CLI PUTs `01-cut.mp4` as `video/mp4` and `02-cut.jpg` as `image/jpeg` into one run before `bd create`, and the review stores `<project>/<item-id>/<run>/01-cut.mp4` with that poster

#### Scenario: 201 MB is refused on both sides

- **WHEN** a card attaches a 201 MB `reel.mp4` with `BREAKDOWN_API` set
- **THEN** `review-request` refuses with `video is 201 MB, over the 200 MB limit` before any upload; and a PUT of the same file sent straight to the server is refused with 413 before its body is read
