## 1. Laptop relay (bd-d38.11)

- [x] 1.1 Migration 0009: `relay_actions` (+ queued partial index), `relay_check_ins`, `relay` in the token scope check; schema tests
- [x] 1.2 `packages/core/src/relay.ts` (action payload schemas, enqueue with allowlist validation, claim with SKIP LOCKED + 5-minute reclaim, report, check-in, status) and `relay-allowlist.ts`; tests incl. racing claims, reclaim, forged actions refused
- [x] 1.3 Split `ingestBeadsCheckout` into compute + apply with no behavior change for local ingest; beads-watcher gets an injected sink; tests
- [x] 1.4 `/relay/v1` handler (check-in, claim long-poll, result, beads-ingest push, projects) reusing hangar's request plumbing, `RELAY_ENDPOINTS`, dispatcher route + `relay` scope; tests per endpoint/scope; `docs/relay.md` + contract test
- [x] 1.5 Queue instead of 412: reviewDecision, inbox herdr notify, refreshBoard/boardEvents when binaries are missing; direct path unchanged when present; tests for both modes
- [ ] 1.6 `bin/relay.mjs` (token file, allowlisted runBd/runHerdr via execFile, cwd from its registry, claim loop, push watcher) and `bin/relay-service.mjs` (launchd install/uninstall/status); `node --test` tests for the pure parts
- [x] 1.7 UI: pending/done/failed on review and inbox decisions (`relayAction` query) and the relay status pill; tests
- [ ] 1.8 End-to-end against a web server started with an empty PATH for bd/herdr (so it queues) plus a relay on this Mac using a scratch beads checkout and a stub herdr: accept, request changes, inbox reply, a bead edit reaching the board; and the same three directly with binaries present. README + CLAUDE.md. `pnpm check` green. No Docker image builds.
