// Live board procedures (live-beads-board 3.4; design.md decision 6):
// `boardEvents` streams the watcher's change/error events to a browser over
// SSE, `refreshBoard` re-reads the registry and re-ingests every project on
// demand. Kept apart from routers/board.ts (the board read) because the two
// meet only in router.ts.
//
// The subscription is an async generator over the watcher's in-process
// emitter. It ends when either the request's own signal aborts (the browser
// went away) or the server-wide shutdown signal does — the latter is what
// lets shutdown close subscriptions instead of waiting for a browser to
// disconnect. Payloads are the watcher's JSON-plain events, forwarded
// untouched (no transformer on this router).
//
// On a server without `bd` (the Jetson; laptop-relay design.md decisions 6
// and 9) the watcher is inert, but the stream still works: the laptop
// relay's pushed loads reach it through `watcher.record`, which emits the
// same events. `refreshBoard` there queues one `beads_reingest` relay action
// per registered project (folding into one already open) and reports each
// project `{ ok: true, queued: <action id> }`, or `{ ok: false, error }` when
// its action could not be queued.

import { on } from "node:events";
import { enqueueRelayAction, listBeadsProjects } from "@breakdown/core";
import { BEADS_WATCHER_EVENT, type BeadsWatcher, type BeadsWatcherEvent } from "../beads-watcher.js";
import type { Context } from "../context.js";
import { mapCoreError } from "../errors.js";
import { humanProcedure, router, TRPCError } from "../trpc.js";

function requireWatcher(watcher: BeadsWatcher | undefined): BeadsWatcher {
  if (!watcher) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The beads watcher is not running on this server." });
  return watcher;
}

export type RefreshOutcome =
  | { project: string; ok: true; nodes: { created: number; updated: number; unchanged: number }; edges: { created: number; updated: number } }
  | { project: string; ok: true; queued: number }
  | { project: string; ok: false; error: string };

/** Queue mode: one `beads_reingest` per registered project, each outcome reported on its own. */
async function queueReingests(ctx: Context): Promise<RefreshOutcome[]> {
  let projects;
  try {
    projects = await listBeadsProjects(ctx.db, { registeredByBeads: true });
  } catch (err) {
    throw mapCoreError("refreshBoard", err);
  }
  const outcomes: RefreshOutcome[] = [];
  for (const project of projects) {
    try {
      const { action } = await enqueueRelayAction(ctx.db, { kind: "beads_reingest", payload: { project_key: project.key }, requestedBy: ctx.client ?? "human" });
      outcomes.push({ project: project.key, ok: true, queued: action.id });
    } catch (err) {
      console.error(`[breakdown-web] could not queue a re-ingest of ${project.key} for the laptop relay:`, err);
      outcomes.push({ project: project.key, ok: false, error: "could not queue a re-ingest for the laptop relay" });
    }
  }
  return outcomes;
}

export const boardLiveRouter = router({
  boardEvents: humanProcedure.subscription(async function* (opts): AsyncGenerator<BeadsWatcherEvent> {
    const watcher = requireWatcher(opts.ctx.watcher);
    const signals = [opts.signal, opts.ctx.shutdownSignal].filter((s): s is AbortSignal => s !== undefined);
    const signal = AbortSignal.any(signals);
    if (signal.aborted) return;
    try {
      for await (const [event] of on(watcher.events, BEADS_WATCHER_EVENT, { signal })) {
        yield event as BeadsWatcherEvent;
      }
    } catch (err) {
      if (!(err instanceof Error && err.name === "AbortError")) throw err;
    }
  }),

  refreshBoard: humanProcedure.mutation(async ({ ctx }): Promise<RefreshOutcome[]> => {
    if (ctx.missingBinaries?.includes("bd")) return queueReingests(ctx);
    const watcher = requireWatcher(ctx.watcher);
    const outcomes = await watcher.reload();
    return outcomes.map((o) =>
      o.ok ? { project: o.project, ok: true, nodes: o.nodes, edges: o.edges } : { project: o.project, ok: false, error: o.error },
    );
  }),
});
