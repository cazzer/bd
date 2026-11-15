// `hangarStatus` (hangar-queue design decision 7): hangar's liveness, its
// latest capacity and when it was reported (hangar-capacity), and the open
// session counts, for the board header's pill. No input; one core read
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
//
// `hangarSessions` (hangar-release): one work item's sessions, newest-changed
// first, for the board drawer's "Hangar sessions" section. `human` only, a
// read, so a read-only server serves it. The disk path itself stays off the
// wire: the drawer needs only whether one is still held. Each queued session
// carries `waiting`, why it waits (hangar-capacity: `explainQueuedSessions`,
// one batch for the listed queued sessions, computed on read, never stored);
// every other state carries null.

import {
  explainQueuedSessions,
  getHangarStatus,
  HANGAR_OUTCOMES,
  listSessions,
  setHangarSessionOutcome,
  type HangarCapacity,
  type HangarFlavor,
  type HangarOutcome,
  type HangarSessionState,
  type HangarWaiting,
} from "@breakdown/core";
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
  /** That hangar's latest capacity, parsed leniently; null when it sent none. */
  capacity: HangarCapacity | null;
  /** When that capacity arrived, by the server's clock; null with no capacity. */
  capacityAt: string | null;
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
      capacity: status.capacity,
      capacityAt: status.capacityAt?.toISOString() ?? null,
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

export interface HangarSessionDto {
  id: string;
  state: HangarSessionState;
  flavor: HangarFlavor;
  repo: string;
  outcome: HangarOutcome | null;
  outcomeAt: string | null;
  outcomeBy: string | null;
  released: boolean;
  /** Hangar still reports a disk path for it. */
  diskHeld: boolean;
  container: string | null;
  host: string | null;
  failureReason: string | null;
  requeueReason: string | null;
  /** When it was requested. */
  requestedAt: string | null;
  /** Why a queued session waits; null for every other state. */
  waiting: HangarWaiting | null;
  updatedAt: string;
}

export interface HangarSessionsDto {
  sessions: HangarSessionDto[];
  /** More sessions than were listed. */
  truncated: boolean;
}

export const hangarSessionsInputSchema = z.object({ workItemId: z.string().uuid() });

const hangarSessionsProcedure = humanProcedure.input(hangarSessionsInputSchema).query(async ({ ctx, input }): Promise<HangarSessionsDto> => {
  try {
    const listed = await listSessions(ctx.db, { workItemId: input.workItemId });
    const queued = listed.sessions.filter((s) => s.state === "queued").map((s) => s.id);
    const waiting = queued.length === 0 ? new Map<string, HangarWaiting>() : await explainQueuedSessions(ctx.db, { ids: queued });
    return {
      sessions: listed.sessions.map((s) => ({
        id: s.id,
        state: s.state,
        flavor: s.flavor,
        repo: s.repo,
        outcome: s.outcome,
        outcomeAt: s.outcomeAt,
        outcomeBy: s.outcomeBy,
        released: s.released,
        diskHeld: s.diskPath !== null,
        container: s.container,
        host: s.host,
        failureReason: s.failureReason,
        requeueReason: s.requeueReason,
        requestedAt: s.occurredAt,
        waiting: waiting.get(s.id) ?? null,
        updatedAt: s.updatedAt.toISOString(),
      })),
      truncated: listed.truncated,
    };
  } catch (err) {
    throw mapCoreError("hangarSessions", err);
  }
});

export const hangarRouter = router({ hangarStatus: hangarStatusProcedure, hangarSessionOutcome: hangarSessionOutcomeProcedure, hangarSessions: hangarSessionsProcedure });
