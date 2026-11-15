// The laptop relay as the board sees it (laptop-relay design.md decisions 8
// and 9): `relayStatus` for the header's relay pill, `relayAction` for a
// queued decision's pending/done/failed state, which the review card and
// the inbox poll while it is open, and `relayActionsFor` for the actions of
// the items on screen (core `listRelayActionsForOrigins`: per item, the open
// action, else the one that finished in the last 24 h), so a card reopened
// or reloaded shows its pending decision, or a failure it missed, at once. Both are `human`-only: what the relay was
// asked to do (an action's result, a herdr prompt's outcome) is the
// person's, not a script's. Pure reads of core's queue (relay.ts), so a
// read-only server serves them; dates go out as ISO strings on the
// database's clock, its own `now` included, as `hangarStatus` does.
//
// `missingBinaries` rides on the status because it is what makes the relay
// matter to this server: the pill shows whenever it is non-empty, or
// whenever actions are open, and the inbox words its recipient line by it.
// An action's payload is not served: the person's message is already on the
// card, and the cwd and socket are the Mac's paths. The one exception is a
// review decision's `decision` and `option` in `relayActionsFor`: a card
// reopened on a pending decision reads its answer as the decision it was.

import { getRelayAction, getRelayStatus, listRelayActionsForOrigins, MAX_RELAY_ORIGIN_IDS, type HostBinary, type RelayAction, type RelayActionKind, type RelayActionState } from "@breakdown/core";
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

/** One item's action in `relayActionsFor`: the action, its origin, and for a review decision what was decided. */
export interface RelayOriginActionDto extends RelayActionDto {
  originNodeId: string;
  /** A review decision's `accept` or `changes`; null for any other kind. */
  decision: "accept" | "changes" | null;
  /** The card option an accept named; null when none did. */
  option: string | null;
}

function toActionDto(action: RelayAction): RelayActionDto {
  return {
    id: action.id,
    kind: action.kind,
    state: action.state,
    result: action.result,
    error: action.error,
    createdAt: action.createdAt.toISOString(),
    finishedAt: action.finishedAt?.toISOString() ?? null,
  };
}

function decisionOf(action: RelayAction): Pick<RelayOriginActionDto, "decision" | "option"> {
  const p = action.kind === "review_decision" && action.payload !== null && typeof action.payload === "object" ? (action.payload as Record<string, unknown>) : null;
  const decision = p?.["decision"] === "accept" || p?.["decision"] === "changes" ? p["decision"] : null;
  return { decision, option: decision === "accept" && typeof p?.["option"] === "string" ? p["option"] : null };
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
  return toActionDto(action);
});

export const relayActionsForInputSchema = z.object({ originNodeIds: z.array(z.string().uuid()).max(MAX_RELAY_ORIGIN_IDS) });

const relayActionsForProcedure = humanProcedure.input(relayActionsForInputSchema).query(async ({ ctx, input }): Promise<{ actions: RelayOriginActionDto[] }> => {
  let actions;
  try {
    actions = await listRelayActionsForOrigins(ctx.db, { originNodeIds: input.originNodeIds });
  } catch (err) {
    throw mapCoreError("relayActionsFor", err);
  }
  return { actions: actions.map((a) => ({ ...toActionDto(a), originNodeId: a.originNodeId as string, ...decisionOf(a) })) };
});

export const relayRouter = router({ relayStatus: relayStatusProcedure, relayAction: relayActionProcedure, relayActionsFor: relayActionsForProcedure });
