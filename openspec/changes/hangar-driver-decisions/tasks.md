## 1. Hangar decisions go to the driver

- [x] 1.1 Database: `hangar_decisions` table and `review_request` relay kind (migration 0012)
- [x] 1.2 Core: `hangar-decisions.ts` (strict card, file with supersede, open decisions, decide with option/note checks and a live session, escalation bookkeeping, review and inbox routing); tests
- [x] 1.3 Core: `hangar-escalation.ts` (escalate to a review via `review_request`, inbox fallback, relay report follow-up); `review_request` payload schema and allowlisted `bd` shapes; never stale; `decideInboxItem` routes an escalation's item; tests
- [x] 1.4 Web: `POST /hangar/v1/decision` (session token); relay report follow-up; review router routes a written decision; relay executor files the review (reuse by key, no dep on an epic, failing step named); tests
- [x] 1.5 MCP: `brain_hangar_outcome`, `brain_hangar_decide`, `brain_hangar_escalate`, `pendingDecision`, retired `brain_hangar_outcome_request`, session-token refusals, read-only gating, driver-facing disk-wait wording; tests
- [x] 1.6 Docs: `docs/hangar-api.md` (endpoint, `session_decision`, who decides, version tolerance), `docs/relay.md`, README, CLAUDE.md; `hangar-release-e2e` re-run with the driver releasing B
- [x] 1.7a Review fixes (PR #12): escalation card for options; claim-path failure, unfiled-escalation decide, and repeated-report follow-up; supersede withdraws and escalation queues atomically; heading-first description; reserved `hangar-decision:` key; driver never overwrites a person's outcome and stores its note; `decisionId` on decide; delivery to a requeued session; tests
- [ ] 1.7 cazzer/hangar: the worker files through `POST /hangar/v1/decision` and reads `session_decision` (hangar side)
- [ ] 1.8 Deploy to the Jetson through skyos (`sky-brx.2`); update the Mac relay so it claims `review_request`
