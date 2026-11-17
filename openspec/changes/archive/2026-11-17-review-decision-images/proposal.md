## Why

A person deciding a review on the board can only answer in text, but the most useful answer is often a screenshot: "this is what I see", "the smoke looks like this", "make it look like that". Today they have to describe it in words or put the image somewhere else and paste a link. The board already accepts review media uploads (`remote-review-media`), so letting a decision carry its own screenshots is a small step from what exists.

## What Changes

- The decision message box on a review card (accept or request changes) accepts images: pasted from the clipboard (several at once) or dropped onto the box. Each shows as a thumbnail that can be removed before sending. PNG, JPEG, GIF and WebP only, at most 6 images of at most 10 MB each.
- On send, the board uploads the images through the existing `/review-uploads/` route into a new run under the review's project and item. Only when every upload succeeds is the decision sent; if one fails, the run is deleted and the decision is not sent, and the person sees why.
- `reviewDecision` takes an optional `images` list of relative media paths. The server checks each one names a file in a run under the same project and item.
- The review writer records the images in the bead comment (a trailing `Images:` list of their relative paths) and names them in the agent's notification as absolute paths it can open.
- On a Breakdown without `bd` (the Jetson), the queued `review_decision` relay action carries the image paths. The laptop relay downloads each one through a new relay-scoped endpoint, `GET /relay/v1/actions/:id/media/<n>`, which serves only the media named by an action that relay holds. It saves them under its own state directory on the Mac, and the notification names those local paths.
- Out of scope: a microphone or transcription button (OS dictation already works in the box); video on decisions; any change to how agents file reviews (`review-request`).

Rejected alternative: granting `agent` or `relay` tokens read access to `/review-images/`. It would let any agent token read every review's media, not just its own decision's. The scoped relay endpoint keeps `/review-images/` human-only.

## Capabilities

### New Capabilities
- `review-decision-images`: attaching screenshots to a review decision on the board, recording them with the decision, and delivering them to the requesting agent, both where the server runs `bd` and through the laptop relay.

### Modified Capabilities
- None. (The requirements touched — review decisions, review media uploads, and the relay — live in unarchived changes, not in `openspec/specs/`, so this change adds its requirements under its own capability rather than as deltas.)

## Impact

- Client: `apps/web/src/components/DecisionCard.tsx` (paste and drop, thumbnails, limits), `ReviewItemPanel.tsx` (upload before the mutate, delete the run on failure).
- Server: `apps/web/server/routers/review.ts` (input schema, path checks), `review-writer.ts` (comment and notification text), `packages/core/src/reviews.ts` (limits, path pattern), `packages/core/src/relay.ts` (payload schema gains `images`).
- Relay: new `GET /relay/v1/actions/:id/media/:n` handler; `apps/web/server/relay/execute.ts` downloads before running the writer; `docs/relay.md` documents the endpoint.
- No new dependencies, environment variables, or migrations. No model call.
