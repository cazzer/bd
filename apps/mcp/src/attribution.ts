// Write attribution (brain-mcp spec, "Batch write and link tools"): every
// write made through this server is attributed to an ingest run with
// source_system = "agent", so agent-authored content is separable from
// content loaded any other way, and a bad session's writes are
// identifiable/revertible as a unit via that run's id.

import { closeIngestRun, openIngestRun, type IngestRunHandle } from "@breakdown/core";
import type { Database } from "@breakdown/db";

/** The ingest run source_system every brain_write/brain_link call uses — see the module header. */
export const AGENT_SOURCE_SYSTEM = "agent";

/**
 * Opens an ingest run attributed to the agent, runs `fn` with the handle,
 * and always closes the run afterward — including when `fn` throws — so a
 * rejected batch (bad input, a database failure) never leaves a run open
 * indefinitely. Returns the run id alongside whatever `fn` returned.
 */
export async function withAgentIngestRun<T>(db: Database, fn: (run: IngestRunHandle) => Promise<T>): Promise<{ ingestRunId: string; result: T }> {
  const run = await openIngestRun(db, AGENT_SOURCE_SYSTEM);
  try {
    const result = await fn(run);
    return { ingestRunId: run.id, result };
  } finally {
    await closeIngestRun(db, run);
  }
}
