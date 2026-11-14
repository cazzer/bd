// Write attribution (brain-mcp spec, "Batch write and link tools", "Merge
// tool for duplicates the agent notices"): every write made through this
// server is attributed to an ingest run with source_system = "agent" and
// the connected client — as it introduced itself in its initialize
// handshake, prefixed by the client token's name when an HTTP session was
// opened with one ("<client> via <name> <version>") — as actor, so
// agent-authored content is separable from content loaded any other way,
// one client's writes are separable from another's, and a bad session's
// writes are identifiable/revertible as a unit via that run's id. No
// configuration is involved in recording the actor (see ToolContext.actor).

import { closeIngestRun, openIngestRun, type IngestRunHandle } from "@breakdown/core";
import type { Database } from "@breakdown/db";

/** The ingest run source_system every brain_write/brain_link/brain_merge call uses — see the module header. */
export const AGENT_SOURCE_SYSTEM = "agent";

/**
 * Opens an ingest run attributed to the agent (source_system
 * `AGENT_SOURCE_SYSTEM`, actor as given), runs `fn` with the handle, and
 * always closes the run afterward — including when `fn` throws — so a
 * rejected batch (bad input, a database failure) never leaves a run open
 * indefinitely. Returns the run id alongside whatever `fn` returned.
 *
 * `actor` is a required positional parameter rather than a trailing
 * optional so no call site can silently omit it; passing `undefined` is
 * the explicit "the SDK has no client info" case and records no actor.
 */
export async function withAgentIngestRun<T>(db: Database, actor: string | undefined, fn: (run: IngestRunHandle) => Promise<T>): Promise<{ ingestRunId: string; result: T }> {
  const run = await openIngestRun(db, AGENT_SOURCE_SYSTEM, { actor });
  try {
    const result = await fn(run);
    return { ingestRunId: run.id, result };
  } finally {
    await closeIngestRun(db, run);
  }
}
