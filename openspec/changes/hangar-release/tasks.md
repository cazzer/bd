## 1. Hangar session release (bd-d38.4)

- [ ] 1.1 Core: outcome fields in the session contract, `setHangarSessionOutcome` (state, released, idempotence, revision, updated_at), failure reason on PATCH failed, null clears container/disk_path on final sessions, `releasable` filter; tests (throwaway DB)
- [ ] 1.2 REST: PATCH accepts `reason` and nulls, ignores `outcome`; session JSON gains outcome/outcome_at/outcome_by/released; docs/hangar-api.md (release section matching cazzer/hangar release-contract.md); contract test passes; tests
- [ ] 1.3 People paths: tRPC `hangarSessionOutcome` (human); inbox `hangar_outcome` items set the outcome on accept with option, not on dismiss; MCP `brain_hangar_outcome_request` (refused to session tokens and read-only) and `releasable` on `brain_hangar_sessions`; tests
- [ ] 1.4 Board: sessions on the work item drawer with state/outcome/released and Accept/Table on ended sessions; jsdom tests
- [ ] 1.5 End-to-end with a fake hangar against a throwaway DB: request → claim → stop → person tables → hangar lists it first with outcome → ack PATCH nulls → released; README; `pnpm check` green
