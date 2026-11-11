## 1. herdr session helper

- [x] 1.1 `apps/web/server/herdr-session.ts`: JSON runner (no shell, timeout, herdr's error line as the reason), `resolveHerdrSocket`, `openAgentSession` (workspace by label, shell-ready retry, tab closed on failure, focus), `focusPane`, `tabLabel`
- [x] 1.2 Tests with a fake runner: first-time workspace, existing workspace, shell retry, cleanup on failure, focus, socket resolution

## 2. reviewSession procedure

- [x] 2.1 `routers/review-session.ts`: input schema, refusals in the header's order, focus through the review's socket, open in the registered checkout through the server's socket; context gains `herdrJson` and `herdrSocket`; router merged; index wires the defaults
- [x] 2.2 `reviewSessionPrompt` from `reviewCard` plus the description (cut at 4,000)
- [x] 2.3 Tests against the database with a fake runner: focus ok, pane gone as data, no pane refused before any command, open primed in the checkout, read-only / no socket / not a review / unregistered / no runner refused, agent failure as data, legacy prompt

## 3. Drawer and run

- [x] 3.1 `ReviewSessionLinks`: "Go to agent" when a pane and session are recorded, "Talk it through ↗", busy and one-line result
- [x] 3.2 Rendered under the decision buttons in `ReviewItemPanel` while the review is open (drawer and Review all run)
- [x] 3.3 Live check: a review filed from a herdr pane, both links, a screenshot of the footer

## 4. Close

- [x] 4.1 `pnpm check` passes
