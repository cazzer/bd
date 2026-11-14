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

import { on } from "node:events";
import { BEADS_WATCHER_EVENT, type BeadsWatcher, type BeadsWatcherEvent } from "../beads-watcher.js";
import { refuseMissingBinary } from "../errors.js";
import { humanProcedure, router, TRPCError } from "../trpc.js";

function requireWatcher(watcher: BeadsWatcher | undefined): BeadsWatcher {
  if (!watcher) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The beads watcher is not running on this server." });
  return watcher;
}

export type RefreshOutcome =
  | { project: string; ok: true; nodes: { created: number; updated: number; unchanged: number }; edges: { created: number; updated: number } }
  | { project: string; ok: false; error: string };

export const boardLiveRouter = router({
  boardEvents: humanProcedure.subscription(async function* (opts): AsyncGenerator<BeadsWatcherEvent> {
    refuseMissingBinary(opts.ctx.missingBinaries, "bd");
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
    refuseMissingBinary(ctx.missingBinaries, "bd");
    const watcher = requireWatcher(ctx.watcher);
    const outcomes = await watcher.reload();
    return outcomes.map((o) =>
      o.ok ? { project: o.project, ok: true, nodes: o.nodes, edges: o.edges } : { project: o.project, ok: false, error: o.error },
    );
  }),
});
