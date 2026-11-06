## Context

`reviewDecision` (review-writer.ts) already runs `herdr agent prompt <pane>` under the review's recorded socket to tell the requester about a decision. The review's `pane` and `socket` come from `review-request`, which reads `$HERDR_PANE_ID` and `$HERDR_SOCKET_PATH`. A registered beads project has a checkout `path`.

## Goals / Non-Goals

**Goals:** one click from a review to the requester's pane; one click to a fresh, primed, interactive session in the right checkout; no new write path.

**Non-Goals:** a session that decides or comments; non-herdr terminals; remembering which sessions were opened for which review.

## Decisions

### 1. Two modes, one procedure, no writes

`reviewSession({ project, item, mode })` resolves the item exactly as `reviewDecision` does (registered project, board item, a readable review) and then runs herdr commands only. "focus" needs the review's `pane` and `socket` and uses that socket: pane ids are scoped to one herdr server. "open" uses the server's socket, since the new tab belongs to whoever is looking at the board. "open" is refused on a read-only server because it starts a process; "focus" is not.

### 2. herdr failure is data

The pane may have closed since the review was filed; the agent may fail to start. Both return `{ ok: false, reason }` with herdr's error line, never the prompt, and the drawer shows it in one line. Validation failures (no runner, no socket, not a review) are tRPC errors, raised before any command runs.

### 3. Opening a session

The tab goes in a workspace labelled `reviews` (found by label, created the first time) so sessions don't pile up in whatever the person had focused. A fresh tab's shell refuses an agent until its prompt is up ("not an available shell"), so `agent start` is retried for up to 10 s. If the agent can't start or take the prompt, the tab is closed again. The agent name is `review-<bead id, 18 chars>-<4 hex>`, unique among live agents. Claude gets the opening prompt as its startup argument rather than typed into the pane: in a folder Claude has not been told to trust, its trust question would take a typed prompt's Enter as "No, exit". As an argument, the prompt waits behind the question. Other agent kinds get it typed once herdr reports them ready.

### 4. The prompt

The card as text (question; each option as `id: label (recommended) — what Risk: risk`; on-accept steps), the bead description cut at 4,000 characters, the requester's pane to read (not prompt), and two instructions: start with `bd show` / `bd comments` and say what you'd pick and why; don't decide or comment, the person decides in the board. A legacy review reads as a question-only card through `reviewCard`.

## Risks / Trade-offs

- A person can open several sessions on one review; each is a separate tab. Cheap, and nothing is lost.
- The server's socket is resolved once at startup. Restarting herdr under a new socket path needs a server restart, the same as today's notification path.
