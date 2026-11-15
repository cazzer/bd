// Escalating a hangar decision to the person (hangar-driver-decisions
// change). The driver answers its sessions' decisions itself
// (hangar-decisions.ts); a call that changes the architecture or sets a
// fundamental direction is the person's, and goes to them as a review: a
// beads issue labelled `review` under the session's work item, carrying the
// driver's decision card, the same review `bin/review-request` files. It
// shows in the board's review queue and in Needs me.
//
// Breakdown never runs `bd` for this: it queues a `review_request` relay
// action (relay.ts), and the laptop relay files the review in the project's
// registered checkout and reports its bead id, which is recorded on the
// decision. A Breakdown host that has `bd` itself runs a relay against
// itself. The person decides the review on the board as any other
// (`reviewDecision`); once that decision is written to the tracker — at
// once with `bd` on the server, or when the relay reports its
// `review_decision` done — `routeReviewDecision` matches it on the review's
// project and bead id and appends it to the session's messages.
//
// Fallback: a work item with no registered beads project (a work item from
// another source, such as hangar's own) gets an inbox item with the card
// instead, bound to the session the way a worker's own item is (key
// `hangar-decision:<decision id>`). The person's decision on it reaches the
// session as an `inbox_decision` (today's path) and, matched on the item's
// id, as a `session_decision` on the decision (inbox.ts `decideInboxItem`).
//
// `onRelayActionReported` is the relay report's follow-up, called by the web
// server's relay API after a report lands: a review request's bead id (or
// its failure, which puts the decision back to pending so the driver can
// retry), and a review decision's routing.

import type { Database } from "@breakdown/db";
import { getRegisteredBeadsProject } from "./board.js";
import { HangarDecisionRefusedError } from "./errors.js";
import { getSessionsByIds } from "./hangar.js";
import {
  failHangarEscalation,
  getEscalatableHangarDecision,
  markHangarDecisionEscalated,
  normalizeHangarDecisionCard,
  recordHangarEscalationReview,
  routeReviewDecision,
  type HangarDecision,
  type HangarDecisionCard,
} from "./hangar-decisions.js";
import { requestInboxItem } from "./inbox.js";
import { getNodes } from "./lookup.js";
import { isRelayIssueId, MAX_RELAY_REVIEW_DESCRIPTION_LENGTH, MAX_RELAY_REVIEW_TITLE_LENGTH } from "./relay-allowlist.js";
import { enqueueRelayAction, type RelayAction, type ReviewDecisionPayload } from "./relay.js";
import { fitText } from "./fit-text.js";
import { PROJECT_KEY_PATTERN } from "./work-items.js";

/** The inbox key an escalation that falls back to the inbox files under. */
export const HANGAR_ESCALATION_INBOX_KEY_PREFIX = "hangar-decision:";
export const MAX_HANGAR_ESCALATION_NOTE_LENGTH = 2000;

/** The review key an escalation's review carries: `hangar-` and the decision id's 32 hex digits (39 characters, within REVIEW_KEY_PATTERN). */
export function hangarEscalationReviewKey(decisionId: string): string {
  return `hangar-${decisionId.replace(/-/g, "").toLowerCase()}`;
}

/** `Review: <question>` within the relay's title cap, as bin/review-request titles a card review. */
function reviewTitle(question: string): string {
  return fitText(`Review: ${question}`, MAX_RELAY_REVIEW_TITLE_LENGTH) as string;
}

/** The evidence the person reads: the driver's body, its note, and where the decision came from. */
export function hangarEscalationEvidence(decision: HangarDecision, card: HangarDecisionCard, context: { note?: string; driver: string; repo: string; workItem: string | null }): string {
  const parts: string[] = [];
  if (card.body !== undefined && card.body !== "") parts.push(card.body);
  else if (decision.summary !== "") parts.push(decision.summary);
  else parts.push(card.question);
  if (context.note !== undefined && context.note !== "") parts.push(`**Why it comes to you** (${context.driver}): ${context.note}`);
  const facts = [
    `Escalated by the driver \`${context.driver}\` from hangar session \`${decision.sessionId}\` on \`${context.repo}\`${context.workItem === null ? "" : `, for work item \`${context.workItem}\``}.`,
    `The session asked: ${decision.kind === "pr" ? "review PR" : "question"} "${decision.title}"${decision.prUrl === null ? "" : ` (${decision.prUrl})`}.`,
    "Your decision goes to the session: accepting carries it out, sending it back with a note has it rework.",
  ];
  parts.push(`---\n${facts.join(" ")}`);
  const text = parts.join("\n\n");
  return fitText(text, MAX_RELAY_REVIEW_DESCRIPTION_LENGTH) as string;
}

export interface EscalateHangarDecisionInput {
  sessionId: string;
  /** The driver's card for the person (normalizeHangarDecisionCard). */
  card: unknown;
  note?: string;
  /** The driver's client name: who asked, recorded on the action or item. */
  actor: string;
}

export type EscalateHangarDecisionResult =
  | { via: "review"; decisionId: string; projectKey: string; workItem: string; reviewKey: string; relayActionId: number }
  | { via: "inbox"; decisionId: string; inboxItemId: string; reason: string };

/**
 * Hands the session's pending decision to the person (module header):
 * refused (`HangarDecisionRefusedError`) when it has none, it is already
 * escalated, or the session has ended. A review under the work item when it
 * has a registered beads project, an inbox item bound to the session
 * otherwise. Nothing is written when the card is refused.
 */
export async function escalateHangarDecision(db: Database, input: EscalateHangarDecisionInput): Promise<EscalateHangarDecisionResult> {
  const card = normalizeHangarDecisionCard(input.card);
  const note = input.note?.trim() === "" ? undefined : input.note?.trim().slice(0, MAX_HANGAR_ESCALATION_NOTE_LENGTH);
  const decision = await getEscalatableHangarDecision(db, input.sessionId);
  const [session] = await getSessionsByIds(db, [decision.sessionId]);
  const workItem = session?.workItemId == null ? null : ((await getNodes(db, [session.workItemId])).nodes[0] ?? null);
  const project = typeof workItem?.metadata["project"] === "string" ? workItem.metadata["project"] : null;
  const registered =
    workItem !== null && workItem.sourceSystem === "beads" && project !== null && PROJECT_KEY_PATTERN.test(project) && isRelayIssueId(workItem.externalId)
      ? await getRegisteredBeadsProject(db, project)
      : null;
  const evidence = hangarEscalationEvidence(decision, card, { ...(note === undefined ? {} : { note }), driver: input.actor, repo: session?.repo ?? "", workItem: workItem?.externalId ?? null });
  const lost = () => new HangarDecisionRefusedError(decision.sessionId, "none", `decision ${decision.id} was answered or superseded while it was being escalated`);

  if (registered !== null && workItem !== null) {
    const reviewKey = hangarEscalationReviewKey(decision.id);
    const review = {
      images: [],
      summary: card.question,
      key: reviewKey,
      question: card.question,
      ...(card.options === undefined ? {} : { options: card.options }),
      ...(card.recommend === undefined ? {} : { recommend: card.recommend }),
      ...(card.on_accept === undefined ? {} : { on_accept: card.on_accept }),
    };
    const { action } = await enqueueRelayAction(db, {
      kind: "review_request",
      payload: { project_key: registered.key, cwd: registered.path, issue_id: workItem.externalId, title: reviewTitle(card.question), description: evidence, review },
      requestedBy: input.actor,
      originNodeId: workItem.id,
    });
    const marked = await markHangarDecisionEscalated(db, {
      id: decision.id,
      escalation: { via: "review", project_key: registered.key, issue_id: workItem.externalId, review_key: reviewKey, relay_action_id: action.id },
    });
    if (!marked) throw lost();
    return { via: "review", decisionId: decision.id, projectKey: registered.key, workItem: workItem.externalId, reviewKey, relayActionId: action.id };
  }

  const reason =
    workItem === null
      ? "the session has no work item"
      : workItem.sourceSystem !== "beads"
        ? `its work item comes from ${workItem.sourceSystem}, not beads`
        : project === null
          ? "its work item names no beads project"
          : `beads project "${project}" has no registered checkout`;
  const filed = await requestInboxItem(db, {
    externalId: `${HANGAR_ESCALATION_INBOX_KEY_PREFIX}${decision.id}`,
    title: fitText(`Decide: ${card.question}`, 200) as string,
    content: evidence,
    metadata: {
      source: "hangar",
      action: decision.kind === "question" ? "reply" : "decide",
      from: `hangar driver ${input.actor}`.slice(0, 200),
      question: card.question,
      ...(card.options === undefined ? {} : { options: card.options }),
      ...(card.recommend === undefined ? {} : { recommend: card.recommend }),
      ...(card.on_accept === undefined ? {} : { on_accept: card.on_accept }),
      ...(decision.prUrl === null ? {} : { links: [{ label: "PR", url: decision.prUrl }] }),
      priority: 1,
    },
    actor: input.actor,
    session: decision.sessionId,
  });
  const marked = await markHangarDecisionEscalated(db, { id: decision.id, escalation: { via: "inbox", item_id: filed.id } });
  if (!marked) throw lost();
  return { via: "inbox", decisionId: decision.id, inboxItemId: filed.id, reason };
}

/**
 * The follow-up to a relay report that landed (module header): a review
 * request done records its bead id, failed puts the decision back to
 * pending; a review decision done is routed to its session. Anything else,
 * and a report already finished before, does nothing. Never throws: the
 * report is recorded either way, and a routing failure is logged by the
 * caller.
 */
export async function onRelayActionReported(db: Database, action: RelayAction): Promise<void> {
  if (action.kind === "review_request") {
    const reviewId = (action.result as Record<string, unknown> | null)?.["review_id"];
    if (action.state === "done" && typeof reviewId === "string" && isRelayIssueId(reviewId)) await recordHangarEscalationReview(db, { relayActionId: action.id, reviewId });
    else if (action.state === "failed" || action.state === "done") await failHangarEscalation(db, { relayActionId: action.id, error: action.error ?? "the relay reported no review id" });
    return;
  }
  if (action.kind === "review_decision" && action.state === "done") {
    const payload = action.payload as ReviewDecisionPayload;
    await routeReviewDecision(db, {
      projectKey: payload.project_key,
      reviewId: payload.issue_id,
      decision: payload.decision,
      ...(payload.option === undefined ? {} : { option: payload.option }),
      message: payload.message,
      by: action.requestedBy ?? "human",
    });
  }
}
