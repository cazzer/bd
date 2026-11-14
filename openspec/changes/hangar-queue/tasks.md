## 1. Per-procedure token scopes on the web API (bd-d38.8)

- [ ] 1.1 Admission scopes per route in the web dispatcher (trpc: human|agent; health: any; static/connect as today); verifyClientToken returns scope through to the tRPC context
- [ ] 1.2 `.meta({ scopes })` + scope middleware; `humanProcedure`/`agentProcedure` replace `publicProcedure` in every router; agent gets inbox.request, inbox.complete and the reads bin/inbox, bin/inbox-watch, bin/review-request use
- [ ] 1.3 Test enumerating every procedure's declared scopes (none undeclared); router tests: agent token files and completes, 403 on decide/release/handOff/review/write; MCP closes a session on refusal only when a credential was presented
- [ ] 1.4 README token section updated (what an agent token can do on the web API)

## 2. Hangar queue, sessions, check-ins, messages (bd-d38.3)

- [ ] 2.1 Migration 0008: `client_tokens.session_id`, `hangar` in the scope check, `hangar_check_ins`, `hangar_messages`; schema tests
- [ ] 2.2 `packages/core/src/hangar.ts`: session metadata contract + normalizer, requestSession (node + run_by edge), claimSession (SKIP LOCKED, session token, check-in), updateSession (transition rules, token revoke), requeueSession, listSessions, recordCheckIn, getHangarStatus, appendMessage, readMessages; tests incl. racing claims
- [ ] 2.3 `brain_write` refuses `hangar_session` nodes; session tokens in client-tokens (verify returns sessionId; CLI list shows scope + session; `create --scope hangar`)
- [ ] 2.4 `/hangar/v1` REST handler (route + per-endpoint scope, JSON errors, long-poll loop with socket-close abort, body caps) exporting `HANGAR_ENDPOINTS`; tests per endpoint and scope
- [ ] 2.5 Inbox routing: `session` stamped from the session token on request; decide/release/handOff append a hangar message for session items, herdr unchanged for local ones; tests
- [ ] 2.6 MCP tools `brain_hangar_request`, `brain_hangar_status`, `brain_hangar_sessions` (read-only mode refuses the write tool); tests
- [ ] 2.7 tRPC `hangarStatus` and the board header pill (online / offline since … / never); tests
- [ ] 2.8 `docs/hangar-api.md` contract + the endpoint-table test; README section; CLAUDE.md minting sentence and a hangar convention bullet
- [ ] 2.9 End-to-end check against a running web server: hangar token checks in, a request enqueued over MCP is claimed by long-poll, session token writes over MCP, worker files an inbox request, a human decision arrives in the worker's long-poll, stopping the session revokes the token; `pnpm check` green
