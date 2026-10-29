// Pure helpers behind the board's item drawer (board-visual-reviews, task
// 4.4): which project an addressed item belongs to, whether it takes a
// decision, when the decision buttons are blocked, how a decision's outcome
// reads, and lightbox stepping. Structural types only — nothing is imported
// from the server or from @breakdown/core at runtime, so the browser bundle
// stays free of Node code.

/** The step names `reviewDecision` reports in `written` (server/review-writer.ts). */
export type ReviewStepName = "comment" | "close" | "remove-changes-label" | "add-changes-label";

export type ReviewDecisionKind = "accept" | "changes";

/**
 * The project whose drawer an address opens: the project of the card whose
 * external id is `item` when the board shows one, else the single chosen
 * project (the CLI's link names exactly one), else null — the drawer waits
 * until a change brings the item onto the board.
 */
export function drawerProject(item: string, cards: ReadonlyArray<{ externalId: string; project: string }>, chosen: readonly string[]): string | null {
  const card = cards.find((c) => c.externalId === item);
  if (card) return card.project;
  return chosen.length === 1 ? chosen[0]! : null;
}

/** An open review takes Accept / Request changes; anything else shows no actions. */
export function canDecide(item: { isReview: boolean; status: string }): boolean {
  return item.isReview && item.status !== "closed";
}

/** True when a decision button must not fire: one is being written, or changes are requested with no message. */
export function decisionBlocked(decision: ReviewDecisionKind, message: string, pending: boolean): boolean {
  if (pending) return true;
  return decision === "changes" && message.trim() === "";
}

const STEP_TEXT: Readonly<Record<ReviewStepName, string>> = {
  comment: "comment added",
  close: "review closed",
  "remove-changes-label": "review:changes label removed",
  "add-changes-label": "review:changes label added",
};

const UNCERTAIN_TEXT: Readonly<Record<ReviewStepName, string>> = {
  comment: "the comment",
  close: "the close",
  "remove-changes-label": "the review:changes label removal",
  "add-changes-label": "the review:changes label",
};

function stepsText(written: readonly ReviewStepName[]): string {
  return written.map((s) => STEP_TEXT[s] ?? s).join(", ");
}

export interface DecisionOutcome {
  tone: "ok" | "partial" | "error";
  text: string;
  /** A failed write keeps the message in the box so it can be retried. */
  keepMessage: boolean;
}

/**
 * How a `reviewDecision` answer reads in the drawer. `uncertain` names a step
 * that timed out or was killed and so may still have been written; the
 * server's error already says to check the tracker, so the text names the
 * step and passes the error through, and never claims the step did not land.
 */
export function describeDecision(result: { ok: boolean; decision: ReviewDecisionKind; written: readonly ReviewStepName[]; error?: string; uncertain?: ReviewStepName }): DecisionOutcome {
  const verb = result.decision === "accept" ? "Accepted" : "Changes requested";
  if (result.ok) {
    return { tone: "ok", text: result.written.length > 0 ? `${verb}: ${stepsText(result.written)}.` : `${verb}.`, keepMessage: false };
  }
  const error = result.error ?? "the tracker reported an error";
  if (result.uncertain !== undefined) {
    const landed = result.written.length > 0 ? `Partly written (${stepsText(result.written)}). ` : "";
    return { tone: "partial", text: `${landed}Unsure whether ${UNCERTAIN_TEXT[result.uncertain] ?? result.uncertain} was written: ${error}`, keepMessage: true };
  }
  if (result.written.length > 0) {
    return { tone: "partial", text: `Partly written (${stepsText(result.written)}), then the tracker failed: ${error}`, keepMessage: true };
  }
  return { tone: "error", text: `Nothing was written; the tracker failed: ${error}`, keepMessage: true };
}

/** Whether the requesting agent was told (bd-ker.5); null while the server does not report it. */
export function describeNotified(notified: { ok: boolean; reason?: string } | null | undefined): string | null {
  if (notified === null || notified === undefined) return null;
  if (notified.ok) return "Agent notified";
  return `Agent not notified: ${notified.reason ?? "no reason given"}`;
}

/** `i` moved by `delta` around a ring of `n` (lightbox previous/next). */
export function stepIndex(i: number, delta: number, n: number): number {
  if (n <= 0) return 0;
  return (((i + delta) % n) + n) % n;
}
