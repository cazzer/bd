// Public entry point for `@breakdown/db`. Nothing here connects or reads
// env at module scope — `createPool`/`createDb` are plain constructors,
// and `resolveDatabaseUrl` only reads the environment when a caller
// invokes it.
export { createPool, createDb, type Database } from "./client.js";
export { resolveDatabaseUrl, DatabaseUrlNotSetError } from "./env.js";
export {
  ingestRuns,
  nodes,
  nodeRevisions,
  edges,
  resolvedNodes,
} from "./schema.js";
