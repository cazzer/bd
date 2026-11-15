## 1. Hangar session release (bd-d38.4)

- [x] 1.1 Core: outcome fields in the session contract, `setHangarSessionOutcome` (state, released, idempotence, revision, updated_at), failure reason on PATCH failed, null clears container/disk_path on final sessions, `releasable` filter; tests (throwaway DB)
- [x] 1.2 REST: PATCH accepts `reason` and nulls, ignores `outcome`; session JSON gains outcome/outcome_at/outcome_by/released; docs/hangar-api.md (release section matching cazzer/hangar release-contract.md); contract test passes; tests
- [x] 1.3 People paths: tRPC `hangarSessionOutcome` (human); inbox `hangar_outcome` items set the outcome on accept with option, not on dismiss; MCP `brain_hangar_outcome_request` (refused to session tokens and read-only) and `releasable` on `brain_hangar_sessions`; tests
- [x] 1.4 Board: sessions on the work item drawer with state/outcome/released and Accept/Table on ended sessions; jsdom tests
- [x] 1.5 End-to-end with a fake hangar against a throwaway DB: request → claim → stop → person tables → hangar lists it first with outcome → ack PATCH nulls → released; README; `pnpm check` green
- [x] 1.6 Review fixes: server-owned outcome cards (reserved `hangar-outcome:` keys, canonical card, note quoted below the facts, card pinned by a binding, canonical options checked at accept), a server-built banner on the card, ended-session PATCH rules (`409 session_ended`: values refused, released stays released, ack needs an outcome; repeated failed keeps its reason), confirmations with focus for both outcomes, person-worded refusals; tests; e2e re-run
