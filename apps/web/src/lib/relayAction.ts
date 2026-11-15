// Pure helpers behind a decision queued for the laptop relay (laptop-relay
// design.md decision 8): on a server without `bd` or `herdr`, a review
// decision and an inbox item's pane prompt come back as a relay action id,
// and the card shows the action pending until the relay reports it done or
// failed. These read a `relayAction` answer; useRelayAction.ts polls it.
//
// A review decision's result is whatever the relay reported: the writer's
// own answer (`ok`, `written`, `error?`, `uncertain?`, `notified`), read
// exactly as a direct decision is (reviewDrawer.ts `describeDecision`), or a
// `note` such as "already applied" when the tracker had moved past the
// decision. A failure that carries written steps is read the same way, so a
// partly written decision says what landed; one without them shows the
// relay's error. Structural types only, so nothing from the server reaches
// the bundle.

import { describeDecision, describeNotified, type DecisionOutcome, type ReviewDecisionKind, type ReviewStepName } from "./reviewDrawer.js";

export type RelayActionState = "queued" | "claimed" | "done" | "failed";

/** The slice of the `relayAction` answer these helpers read. */
export interface RelayActionView {
  id: number;
  state: RelayActionState;
  result?: unknown;
  error: string | null;
}

export const RELAY_PENDING_TEXT = "Pending: waiting for the laptop relay";
export const RELAY_CLAIMED_TEXT = "Pending: the laptop relay is writing it";

/** One item's action as `relayActionsFor` answers it (server routers/relay.ts `RelayOriginActionDto`). */
export interface RelayOriginActionView extends RelayActionView {
  kind: "review_decision" | "herdr_prompt" | "beads_reingest" | "review_request";
  originNodeId: string;
  /** A review decision's `accept` or `changes`; null for any other kind. */
  decision: "accept" | "changes" | null;
  option: string | null;
}

/** Whether two answers for the same action say the same thing: the pollers keep the older object then. */
export function sameRelayAction(a: RelayActionView, b: RelayActionView): boolean {
  return a.id === b.id && a.state === b.state && a.error === b.error && JSON.stringify(a.result ?? null) === JSON.stringify(b.result ?? null);
}

/** Still waiting on the relay: queued, or claimed and not yet reported. */
export function isRelayActionOpen(state: RelayActionState): boolean {
  return state === "queued" || state === "claimed";
}

interface WriterResult {
  ok: boolean;
  written: ReviewStepName[];
  error?: string;
  uncertain?: ReviewStepName;
  notified?: { ok: boolean; pane?: string; reason?: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The writer's answer inside a relay result, when the result carries one. */
function writerResult(result: unknown): WriterResult | null {
  if (!isRecord(result) || !Array.isArray(result["written"]) || !result["written"].every((s) => typeof s === "string")) return null;
  const notified = isRecord(result["notified"]) && typeof result["notified"]["ok"] === "boolean" ? (result["notified"] as WriterResult["notified"]) : undefined;
  return {
    ok: result["ok"] === true,
    written: result["written"] as ReviewStepName[],
    ...(typeof result["error"] === "string" ? { error: result["error"] } : {}),
    ...(typeof result["uncertain"] === "string" ? { uncertain: result["uncertain"] as ReviewStepName } : {}),
    ...(notified === undefined ? {} : { notified }),
  };
}

function noteOf(result: unknown): string | null {
  return isRecord(result) && typeof result["note"] === "string" && result["note"].trim() !== "" ? result["note"].trim() : null;
}

/** A queued review decision as the card reads it. */
export interface RelayDecisionReading {
  /** `pending` while the relay has not reported; then the decision's own outcome. */
  outcome: DecisionOutcome;
  /** Whether the requesting agent was told, when the relay says. */
  notified: string | null;
  /** The relay said the agent could not be told. */
  notifyFailed: boolean;
  /** The relay reported: the card stops waiting and the buttons come back. */
  finished: boolean;
  /** Something was or may have been written: re-read the item, and tell the host. */
  reread: boolean;
  /** The decision is known written (the writer's `ok`, or a note that it already was). */
  written: boolean;
}

/** How a queued review decision reads at `action`'s state (module header). */
export function describeRelayDecision(action: RelayActionView, decision: ReviewDecisionKind, acceptedAs?: string): RelayDecisionReading {
  if (isRelayActionOpen(action.state)) {
    return {
      outcome: { tone: "pending", text: action.state === "claimed" ? RELAY_CLAIMED_TEXT : RELAY_PENDING_TEXT, keepMessage: true },
      notified: null,
      notifyFailed: false,
      finished: false,
      reread: false,
      written: false,
    };
  }
  const writer = writerResult(action.result);
  if (writer !== null && (action.state === "done" || writer.written.length > 0 || writer.uncertain !== undefined)) {
    const read = action.state === "failed" ? { ...writer, ok: false, error: writer.error ?? action.error ?? undefined } : writer;
    return {
      outcome: describeDecision({ ...read, decision }, acceptedAs),
      notified: describeNotified(writer.notified),
      notifyFailed: writer.notified?.ok === false,
      finished: true,
      reread: read.written.length > 0 || read.uncertain !== undefined,
      written: read.ok,
    };
  }
  if (action.state === "done") {
    const note = noteOf(action.result);
    return {
      outcome: { tone: "ok", text: note === null ? "Written by the laptop relay." : `The laptop relay reported it ${note}.`, keepMessage: false },
      notified: null,
      notifyFailed: false,
      finished: true,
      reread: true,
      written: true,
    };
  }
  return {
    outcome: { tone: "error", text: `The laptop relay could not write the decision: ${action.error ?? "it gave no reason"}. Check the thread before deciding again.`, keepMessage: true },
    notified: null,
    notifyFailed: false,
    finished: true,
    reread: true,
    written: false,
  };
}

/** An inbox item's pane prompt queued for the relay, as the inbox's notice strip words it. */
export function describeRelayPrompt(action: RelayActionView | null, pane: string | null): { tone: "pending" | "ok" | "error"; text: string } {
  const target = pane === null ? "the session that queued it" : `pane ${pane}`;
  if (action === null || isRelayActionOpen(action.state)) return { tone: "pending", text: `Recorded. The laptop relay will tell ${target} when it runs.` };
  if (action.state === "done") return { tone: "ok", text: `The laptop relay told ${target}.` };
  return { tone: "error", text: `The laptop relay could not tell ${target}: ${action.error ?? "it gave no reason"}. The decision is recorded.` };
}

/**
 * The board's note after Refresh: how many projects were re-read, or, on a
 * server without `bd`, queued for the laptop relay (the board updates when
 * its pushes arrive), and how many failed.
 */
export function describeRefresh(total: number, queued: number, failed: number): string {
  const plural = (n: number) => `${n} project${n === 1 ? "" : "s"}`;
  if (queued > 0) return `Queued a refresh of ${plural(queued)} for the laptop relay; the board updates when it runs.${failed > 0 ? ` ${failed} could not be queued.` : ""}`;
  return failed > 0 ? `Refreshed; ${failed} failed.` : `Refreshed ${plural(total)}.`;
}
