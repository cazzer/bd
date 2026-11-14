// The laptop relay as the board sees it (laptop-relay design.md decisions 8
// and 9): `relayStatus` for the header's relay pill, and `relayAction` for a
// queued decision's pending/done/failed state, which the review card and
// the inbox poll while it is open. Both are `human`-only: what the relay was
// asked to do (an action's result, a herdr prompt's outcome) is the
// person's, not a script's. Pure reads of core's queue (relay.ts), so a
// read-only server serves them; dates go out as ISO strings on the
// database's clock, its own `now` included, as `hangarStatus` does.
//
// `missingBinaries` rides on the status because it is what makes the relay
// matter to this server: the pill shows whenever it is non-empty, or
// whenever actions are open, and the inbox words its recipient line by it.
// An action's payload is not served: the person's message is already on the
// card, and the cwd and socket are the Mac's paths.

import { getRelayAction, getRelayStatus, type HostBinary, type RelayActionKind, type RelayActionState } from "@breakdown/core";
import { z } from "zod";
import { mapCoreError } from "../errors.js";
import { humanProcedure, router, TRPCError } from "../trpc.js";

export interface RelayStatusDto {
  status: "online" | "offline" | "never";
  /** The relay that last checked in; null when none has. */
  relay: string | null;
  version: string | null;
  lastSeenAt: string | null;
  intervalS: number;
  now: string;
  queued: number;
  claimed: number;
  /** The host binaries this server lacks, whose work it queues for the relay. */
  missingBinaries: HostBinary[];
}

export interface RelayActionDto {
  id: number;
  kind: RelayActionKind;
  state: RelayActionState;
  result: unknown;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

const relayStatusProcedure = humanProcedure.query(async ({ ctx }): Promise<RelayStatusDto> => {
  try {
    const status = await getRelayStatus(ctx.db);
    return {
      status: status.state,
      relay: status.relay,
      version: status.version,
      lastSeenAt: status.lastSeenAt?.toISOString() ?? null,
      intervalS: status.intervalS,
      now: status.now.toISOString(),
      queued: status.counts.queued,
      claimed: status.counts.claimed,
      missingBinaries: [...(ctx.missingBinaries ?? [])],
    };
  } catch (err) {
    throw mapCoreError("relayStatus", err);
  }
});

export const relayActionInputSchema = z.object({ id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) });

const relayActionProcedure = humanProcedure.input(relayActionInputSchema).query(async ({ ctx, input }): Promise<RelayActionDto> => {
  let action;
  try {
    action = await getRelayAction(ctx.db, input.id);
  } catch (err) {
    throw mapCoreError("relayAction", err);
  }
  if (action === null) throw new TRPCError({ code: "NOT_FOUND", message: `No relay action ${input.id}.` });
  return {
    id: action.id,
    kind: action.kind,
    state: action.state,
    result: action.result,
    error: action.error,
    createdAt: action.createdAt.toISOString(),
    finishedAt: action.finishedAt?.toISOString() ?? null,
  };
});

export const relayRouter = router({ relayStatus: relayStatusProcedure, relayAction: relayActionProcedure });
