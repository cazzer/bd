// `hangarStatus` (hangar-queue design decision 7): hangar's liveness and the
// open session counts, for the board header's pill. No input; one core read
// (`getHangarStatus`, one statement against the database's clock), so a
// read-only server serves it. `agent` scope, like the other reads a script
// or a worker may want. Dates go out as ISO strings, the database's own
// `now` included, so the pill measures "offline since …" from the server's
// clock, never the browser's.

import { getHangarStatus } from "@breakdown/core";
import { mapCoreError } from "../errors.js";
import { agentProcedure, router } from "../trpc.js";

export interface HangarStatusDto {
  status: "online" | "offline" | "never";
  /** The hangar that last checked in; null when none has. */
  hangar: string | null;
  version: string | null;
  lastSeenAt: string | null;
  intervalS: number;
  now: string;
  queued: number;
  claimed: number;
  running: number;
}

const hangarStatusProcedure = agentProcedure.query(async ({ ctx }): Promise<HangarStatusDto> => {
  try {
    const status = await getHangarStatus(ctx.db);
    return {
      status: status.state,
      hangar: status.hangar,
      version: status.version,
      lastSeenAt: status.lastSeenAt?.toISOString() ?? null,
      intervalS: status.intervalS,
      now: status.now.toISOString(),
      queued: status.counts.queued,
      claimed: status.counts.claimed,
      running: status.counts.running,
    };
  } catch (err) {
    throw mapCoreError("hangarStatus", err);
  }
});

export const hangarRouter = router({ hangarStatus: hangarStatusProcedure });
