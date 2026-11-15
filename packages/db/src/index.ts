// Public entry point for `@breakdown/db`. Nothing here connects or reads
// env at module scope — `createPool`/`createDb` are plain constructors,
// and `resolveDatabaseUrl` only reads the environment when a caller
// invokes it.
export { createPool, createDb, DEFAULT_STATEMENT_TIMEOUT_MS, type Database } from "./client.js";
export { resolveDatabaseUrl, DatabaseUrlNotSetError } from "./env.js";
export {
  ingestRuns,
  nodes,
  nodeRevisions,
  edges,
  resolvedNodes,
  clientTokens,
  hangarCheckIns,
  hangarMessages,
  hangarDecisions,
  HANGAR_DECISION_KINDS,
  HANGAR_DECISION_STATES,
  type HangarDecisionKind,
  type HangarDecisionState,
  relayActions,
  relayCheckIns,
  CLIENT_TOKEN_SCOPES,
  type ClientTokenScope,
  RELAY_ACTION_KINDS,
  RELAY_ACTION_STATES,
  type RelayActionKind,
  type RelayActionState,
} from "./schema.js";
