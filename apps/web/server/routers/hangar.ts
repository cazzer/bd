// `hangarStatus` (hangar-queue design decision 7): hangar's liveness and the
// open session counts, for the board header's pill. No input; one core read
// (`getHangarStatus`, one statement against the database's clock), so a
// read-only server serves it. `agent` scope, like the other reads a script
// or a worker may want. Dates go out as ISO strings, the database's own
// `now` included, so the pill measures "offline since …" from the server's
// clock, never the browser's.
//
// `hangarSessionOutcome` (hangar-release): the person accepts or tables an
// ended session (hangar.ts `setHangarSessionOutcome`). `human` only: an agent
// token can only ask (brain_hangar_outcome_request), and no procedure takes
// a hangar token. Attributed to the admitted client, or "human" for the
// tokenless local person.

import { getHangarStatus, HANGAR_OUTCOMES, setHangarSessionOutcome, type HangarOutcome, type HangarSessionState } from "@breakdown/core";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { mapCoreError } from "../errors.js";
import { agentProcedure, humanProcedure, router } from "../trpc.js";

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

export interface HangarSessionOutcomeDto {
  id: string;
  state: HangarSessionState;
  outcome: HangarOutcome | null;
  outcomeAt: string | null;
  outcomeBy: string | null;
  released: boolean;
  /** False when the session already had this outcome: nothing was written. */
  changed: boolean;
}

export const hangarSessionOutcomeInputSchema = z.object({ id: z.string().uuid(), outcome: z.enum(HANGAR_OUTCOMES) });

const hangarSessionOutcomeProcedure = humanProcedure.input(hangarSessionOutcomeInputSchema).mutation(async ({ ctx, input }): Promise<HangarSessionOutcomeDto> => {
  if (ctx.readOnly) throw new TRPCError({ code: "FORBIDDEN", message: "The server is read-only (BRAIN_READ_ONLY); setting a session's outcome is refused." });
  try {
    const { session, changed } = await setHangarSessionOutcome(ctx.db, { id: input.id, outcome: input.outcome, actor: ctx.client ?? undefined });
    return { id: session.id, state: session.state, outcome: session.outcome, outcomeAt: session.outcomeAt, outcomeBy: session.outcomeBy, released: session.released, changed };
  } catch (err) {
    throw mapCoreError("hangarSessionOutcome", err);
  }
});

export const hangarRouter = router({ hangarStatus: hangarStatusProcedure, hangarSessionOutcome: hangarSessionOutcomeProcedure });
