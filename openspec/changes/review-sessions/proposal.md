## Why

Some reviews are too deep to decide from the drawer: a migration with three plausible options, an RFP answer, a design that needs poking at. Today the person either decides on the card alone, or leaves the board, finds the requesting agent's herdr pane by hand, and talks it through there, which derails the agent mid-task. The drawer already knows the requester's pane and socket and the project's checkout; it can take the person to either conversation in one click.

## What Changes

- **Go to agent**: on an open review whose requester recorded a herdr pane and session, a link brings that pane's tab to the front (`herdr pane get` → `herdr tab focus`, through the review's own socket).
- **Talk it through**: a link opens a new tab in a `reviews` herdr workspace (created the first time), in the project's registered checkout, starts Claude there, and types an opening prompt holding the card (question, options with the recommendation, on-accept steps), the evidence (cut at 4,000 characters), and the bead id to read with `bd show`. The prompt tells the agent not to decide or comment: the decision stays in the board, so the requesting agent is still notified by the one write path.
- A new `reviewSession({ project, item, mode: "focus" | "open" })` procedure. It writes nothing, to the tracker or the store; it only drives herdr. herdr's own failure (pane gone, agent would not start) comes back as data, like a failed review notification.
- A generic `apps/web/server/herdr-session.ts`: a JSON-returning herdr runner, socket resolution (the server's `HERDR_SOCKET_PATH`, else herdr's default socket), `openAgentSession` (waits for the new tab's shell, closes the tab again if the agent can't start), and `focusPane`.

Rejected: prompting the requesting agent to "discuss" (it is mid-task, and a side conversation in its context costs it the thread); a session that decides the review itself (a second write path around `reviewDecision`'s checks); opening sessions without herdr (no portable way to start an interactive terminal agent from a browser request).

## Capabilities

### New Capabilities
- `review-sessions`: going to the requesting agent and opening a primed interactive session from an open review, in the drawer and the Review all run.

### Modified Capabilities
None in `openspec/specs/`; the drawer requirements this extends still live in unarchived changes (board-visual-reviews, review-queue, decision-card-reviews).

## Impact

- New: `apps/web/server/herdr-session.ts`, `apps/web/server/routers/review-session.ts`, `apps/web/src/components/ReviewSessionLinks.tsx`, and tests.
- `apps/web/server/context.ts`, `index.ts`, `router.ts`: the herdr runner and socket in the context, the router merged.
- `ReviewItemPanel.tsx`: the links under the decision buttons when the review is open.
- No migration, dependency, or model call. The server already ran `herdr` for notifications; this adds commands, not a capability. No new environment variable: `HERDR_SOCKET_PATH` is herdr's own, inherited when `pnpm dev` runs inside herdr.
