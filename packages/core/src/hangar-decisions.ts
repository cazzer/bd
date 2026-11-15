// Hangar decisions (hangar-driver-decisions change). What a remote session
// needs decided — a PR to review, a question to answer — goes to the agent
// driving the work, not to the person's inbox. Only a big call (architecture,
// a fundamental direction) is escalated to the person, as a review.
//
// The worker files its result with its session token (`POST
// /hangar/v1/decision`, `fileHangarDecision`): kind, title, summary, PR URL,
// and an optional decision card under the review card's rules (reviews.ts
// `normalizeDecisionCard`, held strictly here: a card that would be fitted is
// refused). It is stored as the session's open decision in
// `hangar_decisions`, a table, not a node, and never an inbox item. Filing
// again supersedes the session's open decision, so a session has at most one.
//
// The driver reads it on `brain_hangar_sessions` (`pendingDecision`) and
// answers it (`decideHangarDecision`): accept (optionally naming one of the
// card's options), changes (with a note), or dismiss. The answer is appended
// to the session's messages as kind `session_decision`, with the body an
// `inbox_decision` carries (`item_id` is the decision's id), so the worker's
// loop barely changes. Deciding needs a live session: an ended one reads
// nothing more.
//
// Escalating (hangar-escalation.ts) marks the open decision `escalated` and
// records where it went. From then on only the person answers it: the driver's
// decide is refused (`HangarDecisionRefusedError` "escalated"), so no agent
// decides a review. The person's decision is routed back to the session only
// through a match on that record — the review's project and bead id
// (`routeReviewDecision`), or the fallback inbox item's id
// (`unsafeRouteInboxDecisionInTx`) — never on anything a writer of the
// review or the item could set, so the binding is the server's.
//
// The escalation stores the card the person is shown (`escalation.card`), so
// an option they choose is checked against that card, not the worker's.
// Until its review is filed (no `review_id` yet: the relay is offline, does
// not know the kind, or failed it), the driver can still answer an escalated
// decision, which withdraws the queued relay action; superseding one
// withdraws it too, so no stale review is filed later and a later
// escalation of the same work item is not blocked by it. An answer is
// delivered while the session can still read it — queued (after a requeue:
// the next worker reads the stream from the start), claimed, or running.
//
// The app makes no model call: all of this is pure Postgres.

import { sql } from "drizzle-orm";
import { HANGAR_DECISION_KINDS, type Database, type HangarDecisionKind, type HangarDecisionState } from "@breakdown/db";
import { HangarDecisionRefusedError, InvalidHangarDecisionError } from "./errors.js";
import { appendHangarMessage, HANGAR_SESSION_NODE_TYPE, HANGAR_SOURCE_SYSTEM } from "./hangar.js";
import { CONTROL_CHAR_CODE_POINTS } from "./nodes.js";
import { normalizeDecisionCard, REVIEW_OPTION_ID_PATTERN, type ReviewOption } from "./reviews.js";
import { sqlArray, type Tx } from "./sql-helpers.js";

export { HANGAR_DECISION_KINDS, HANGAR_DECISION_STATES, type HangarDecisionKind, type HangarDecisionState } from "@breakdown/db";

/** The message kind a session's decision arrives under. Its body is an `inbox_decision`'s (module header). */
export const HANGAR_DECISION_MESSAGE_KIND = "session_decision";
export const HANGAR_DECIDE_DECISIONS = ["accept", "changes", "dismiss"] as const;
export type HangarDecideDecision = (typeof HANGAR_DECIDE_DECISIONS)[number];

export const MAX_HANGAR_DECISION_TITLE_LENGTH = 200;
export const MAX_HANGAR_DECISION_SUMMARY_LENGTH = 20_000;
/** A card's evidence body, in characters (the worker's 300-word rule is the card CLI's). */
export const MAX_HANGAR_DECISION_BODY_LENGTH = 20_000;
export const MAX_HANGAR_DECISION_URL_LENGTH = 2000;
export const MAX_HANGAR_DECISION_NOTE_LENGTH = 4000;
const MAX_ACTOR_LENGTH = 200;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CARD_KEYS = ["question", "options", "recommend", "on_accept"] as const;

/** A decision card as a hangar decision holds it: the review card's keys, with `question` required, and the evidence. */
export interface HangarDecisionCard {
  question: string;
  options?: ReviewOption[];
  recommend?: string;
  on_accept?: string[];
  /** Markdown evidence: what changed and why, how it was verified. */
  body?: string;
}

/** Where an escalated decision went (module header). */
/** The card the person is shown on an escalation, without its evidence. */
export type HangarEscalationCard = Pick<HangarDecisionCard, "question" | "options" | "recommend">;

export type HangarEscalation =
  | { via: "review"; project_key: string; issue_id: string; review_key: string; relay_action_id: number; card?: HangarEscalationCard; review_id?: string; error?: string }
  /** `item_id` is null only while the item is being filed. */
  | { via: "inbox"; item_id: string | null; card?: HangarEscalationCard };

export interface HangarDecisionAnswer {
  decision: HangarDecideDecision;
  outcome: "accepted" | "changes" | "dismissed";
  option?: string;
  message: string;
  /** Who decided: the driver's client, or the person. */
  by: string;
  /** `driver`, or how the person decided an escalation: `review` or `inbox`. */
  via: "driver" | "review" | "inbox";
}

export interface HangarDecision {
  id: string;
  sessionId: string;
  kind: HangarDecisionKind;
  title: string;
  summary: string;
  prUrl: string | null;
  card: HangarDecisionCard | null;
  state: HangarDecisionState;
  escalation: HangarEscalation | null;
  decision: HangarDecisionAnswer | null;
  filedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface DecisionRow extends Record<string, unknown> {
  id: string;
  session_id: string;
  kind: HangarDecisionKind;
  title: string;
  summary: string;
  pr_url: string | null;
  card: HangarDecisionCard | null;
  state: HangarDecisionState;
  escalation: HangarEscalation | null;
  decision: HangarDecisionAnswer | null;
  filed_by: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

const COLUMNS = sql.raw("id, session_id, kind, title, summary, pr_url, card, state, escalation, decision, filed_by, created_at, updated_at");

function toDecision(row: DecisionRow): HangarDecision {
  return {
    id: row.id,
    sessionId: row.session_id,
    kind: row.kind,
    title: row.title,
    summary: row.summary,
    prUrl: row.pr_url,
    card: row.card,
    state: row.state,
    escalation: row.escalation,
    decision: row.decision,
    filedBy: row.filed_by,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

// --- The contract (pure) ---------------------------------------------------------------

function hasControlChar(value: string, allowNewlines: boolean): boolean {
  for (const char of value) {
    if (allowNewlines && (char === "\n" || char === "\t" || char === "\r")) continue;
    if (CONTROL_CHAR_CODE_POINTS.has(char.codePointAt(0) as number)) return true;
  }
  return false;
}

function text(field: string, value: unknown, max: number, options: { required?: boolean; multiline?: boolean } = {}): string | undefined {
  if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) {
    if (options.required) throw new InvalidHangarDecisionError(field, "is required");
    return undefined;
  }
  if (typeof value !== "string") throw new InvalidHangarDecisionError(field, "must be a string");
  const trimmed = value.trim();
  if (trimmed.length > max) throw new InvalidHangarDecisionError(field, `must be at most ${max} characters`);
  if (hasControlChar(trimmed, options.multiline ?? false)) throw new InvalidHangarDecisionError(field, "must not contain control characters");
  return trimmed;
}

/** JSON with object keys sorted, for comparing a card with its normalized self. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    return `{${entries.sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * A decision card under the review card's rules, held strictly: the keys
 * `question` (required), `options`, `recommend`, `on_accept`, and `body`
 * only, and a card the normalizer would change (text over a limit, which it
 * fits) is refused rather than fitted, so what the decider reads is what was
 * filed. Pure. Throws `InvalidHangarDecisionError` naming the field.
 */
export function normalizeHangarDecisionCard(raw: unknown, field = "card"): HangarDecisionCard {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new InvalidHangarDecisionError(field, "must be an object");
  const record = raw as Record<string, unknown>;
  const unknown = Object.keys(record).filter((k) => !(CARD_KEYS as readonly string[]).includes(k) && k !== "body");
  if (unknown.length > 0) throw new InvalidHangarDecisionError(field, `has keys the card contract does not allow: ${unknown.join(", ")} (attachments are not taken here; put a diff or diagram in body as a fenced block)`);
  const given: Record<string, unknown> = {};
  for (const key of CARD_KEYS) {
    const value = record[key];
    if (value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0)) continue;
    given[key] = value;
  }
  if (typeof given["question"] !== "string" || given["question"].trim() === "") throw new InvalidHangarDecisionError(`${field}.question`, "is required");
  const card = normalizeDecisionCard(given);
  if (card === null || card.question === undefined) {
    throw new InvalidHangarDecisionError(field, "breaks the decision card contract (cazzer/bd fixtures/review-cards/README.md): check options (2 to 6, unique ids, each with a label), recommend (one option's id, only with options), and on_accept (at most 8 strings)");
  }
  if (canonical(card) !== canonical(given)) {
    throw new InvalidHangarDecisionError(field, "is over a limit of the decision card contract (question at most 140 characters, option labels 80, what and risk 300, on_accept steps 200): shorten it; nothing is trimmed");
  }
  const body = text(`${field}.body`, record["body"], MAX_HANGAR_DECISION_BODY_LENGTH, { multiline: true });
  return {
    question: card.question,
    ...(card.options === undefined ? {} : { options: card.options }),
    ...(card.recommend === undefined ? {} : { recommend: card.recommend }),
    ...(card.on_accept === undefined ? {} : { on_accept: card.on_accept }),
    ...(body === undefined ? {} : { body }),
  };
}

function httpUrl(field: string, value: unknown): string | null {
  const given = text(field, value, MAX_HANGAR_DECISION_URL_LENGTH);
  if (given === undefined) return null;
  let parsed: URL;
  try {
    parsed = new URL(given);
  } catch {
    throw new InvalidHangarDecisionError(field, "must be an http(s) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new InvalidHangarDecisionError(field, "must be an http(s) URL");
  return given;
}

function sessionIdOf(value: unknown): string {
  if (typeof value !== "string" || !UUID_RE.test(value.trim())) throw new InvalidHangarDecisionError("sessionId", "must be a hangar session id (a uuid)");
  return value.trim().toLowerCase();
}

function actorOf(value: unknown): string {
  return text("actor", value, MAX_ACTOR_LENGTH) ?? "unknown";
}

/** The ready-made line the worker hands its Claude session (the `text` of an `inbox_decision`). */
export function hangarDecisionText(decision: { title: string }, answer: Pick<HangarDecisionAnswer, "decision" | "option" | "message" | "by" | "via">): string {
  const note = answer.message.trim() === "" ? "" : ` Note: ${answer.message.trim()}`;
  const who = answer.via === "driver" ? `Decided by your driver (${answer.by}).` : "Decided by the person, on the escalated review.";
  switch (answer.decision) {
    case "accept":
      return `[decision] Accepted${answer.option === undefined ? "" : ` option ${answer.option}`}: "${decision.title}".${note} ${who} Carry it out now.`;
    case "changes":
      return `[decision] Sent back: "${decision.title}".${note} ${who} Rework it accordingly, then file your result again.`;
    default:
      return `[decision] Dismissed: "${decision.title}".${note} ${who} Drop it; nothing to send.`;
  }
}

const OUTCOME_OF: Record<HangarDecideDecision, HangarDecisionAnswer["outcome"]> = { accept: "accepted", changes: "changes", dismiss: "dismissed" };

/** The answer checked against the decision's card: a note for changes, an option only on accept and only one the card offers. Pure. */
export function checkHangarDecisionAnswer(
  decision: Pick<HangarDecision, "card">,
  input: { decision: unknown; option?: unknown; note?: unknown; by: string; via: HangarDecisionAnswer["via"] },
): HangarDecisionAnswer {
  const kind = input.decision;
  if (typeof kind !== "string" || !(HANGAR_DECIDE_DECISIONS as readonly string[]).includes(kind)) {
    throw new InvalidHangarDecisionError("decision", `must be one of ${HANGAR_DECIDE_DECISIONS.join(", ")}`);
  }
  const message = text("note", input.note, MAX_HANGAR_DECISION_NOTE_LENGTH, { multiline: true }) ?? "";
  if (kind === "changes" && message === "") throw new InvalidHangarDecisionError("note", "is required when sending it back: say what needs to change");
  let option: string | undefined;
  if (input.option !== undefined && input.option !== null && input.option !== "") {
    if (kind !== "accept") throw new InvalidHangarDecisionError("option", "is chosen only by accepting");
    if (typeof input.option !== "string" || !REVIEW_OPTION_ID_PATTERN.test(input.option)) throw new InvalidHangarDecisionError("option", `must be an option id matching ${REVIEW_OPTION_ID_PATTERN}`);
    const offered = decision.card?.options ?? [];
    if (!offered.some((o) => o.id === input.option)) {
      throw new InvalidHangarDecisionError("option", offered.length === 0 ? "the decision's card offers no options" : `must be one the card offers: ${offered.map((o) => o.id).join(", ")}`);
    }
    option = input.option;
  }
  return { decision: kind as HangarDecideDecision, outcome: OUTCOME_OF[kind as HangarDecideDecision], ...(option === undefined ? {} : { option }), message, by: input.by, via: input.via };
}

/** The message body a session receives: an `inbox_decision`'s fields, plus who decided and how (module header). */
export function hangarDecisionMessageBody(decision: Pick<HangarDecision, "id" | "title">, answer: HangarDecisionAnswer): Record<string, unknown> {
  return {
    item_id: decision.id,
    title: decision.title,
    decision: answer.decision,
    outcome: answer.outcome,
    ...(answer.option === undefined ? {} : { option: answer.option }),
    message: answer.message,
    text: hangarDecisionText(decision, answer),
    by: answer.by,
    via: answer.via,
  };
}

// --- Session liveness ------------------------------------------------------------------

/** The session's state (folded through merges is not done: a merged-away session reads nothing), share-locked so a racing stop waits; null when it is no session. */
async function sessionState(tx: Tx, sessionId: string, lock: "share" | "update"): Promise<string | null> {
  const result = await tx.execute<{ state: string | null; merged_into: string | null }>(sql`
    SELECT metadata->>'state' AS state, merged_into FROM nodes
    WHERE id = ${sessionId}::uuid AND node_type = ${HANGAR_SESSION_NODE_TYPE} AND source_system = ${HANGAR_SOURCE_SYSTEM}
    ${lock === "share" ? sql`FOR SHARE` : sql`FOR UPDATE`}
  `);
  const row = result.rows[0];
  if (row === undefined || row.merged_into !== null) return null;
  return row.state;
}

/** States that file a decision: a worker is running. */
const LIVE_STATES = ["claimed", "running"];
/** States an answer is delivered in: a requeued (queued) session's next worker reads its stream from the start (module header). */
const DELIVERABLE_STATES = ["queued", "claimed", "running"];

async function assertSessionReads(tx: Tx, sessionId: string): Promise<void> {
  const state = await sessionState(tx, sessionId, "share");
  if (state === null || !DELIVERABLE_STATES.includes(state)) {
    throw new HangarDecisionRefusedError(sessionId, "session_ended", state === null ? "no such hangar session" : `the session is ${state}, so it reads no more messages`);
  }
}

/** Whether an escalation's review has not been filed yet: queued for the relay, with no bead id recorded (module header). */
export function hangarEscalationUnfiled(escalation: HangarEscalation | null): boolean {
  return escalation !== null && escalation.via === "review" && escalation.review_id === undefined;
}

/** Fails a still-queued relay action Breakdown no longer wants run (a withdrawn or superseded escalation). A claimed one is the relay's already. */
async function withdrawRelayActions(tx: Tx, where: ReturnType<typeof sql>, reason: string): Promise<void> {
  await tx.execute(sql`
    UPDATE relay_actions SET state = 'failed', finished_at = now(), error = ${reason}
    WHERE kind = 'review_request' AND state = 'queued' AND id IN (${where})
  `);
}

// --- Filing --------------------------------------------------------------------------------

export interface FileHangarDecisionInput {
  /** The session the admitting token is bound to (server-supplied, never from the body). */
  sessionId: string;
  kind: unknown;
  title: unknown;
  summary?: unknown;
  prUrl?: unknown;
  card?: unknown;
  /** The token's client (`session-<id>`). */
  filedBy?: string;
}

/**
 * A worker files its session's result for the driver (module header). The
 * session must be claimed or running (`HangarDecisionRefusedError`
 * "session_state" otherwise). Supersedes the session's open decision, if
 * any, in the same transaction, so a session has at most one open.
 */
export async function fileHangarDecision(db: Database, input: FileHangarDecisionInput): Promise<HangarDecision> {
  const sessionId = sessionIdOf(input.sessionId);
  if (typeof input.kind !== "string" || !(HANGAR_DECISION_KINDS as readonly string[]).includes(input.kind)) {
    throw new InvalidHangarDecisionError("kind", `must be one of ${HANGAR_DECISION_KINDS.join(", ")}`);
  }
  const title = text("title", input.title, MAX_HANGAR_DECISION_TITLE_LENGTH, { required: true })!;
  const summary = text("summary", input.summary, MAX_HANGAR_DECISION_SUMMARY_LENGTH, { multiline: true }) ?? "";
  const prUrl = httpUrl("pr_url", input.prUrl);
  if (input.kind === "pr" && prUrl === null) throw new InvalidHangarDecisionError("pr_url", "is required for a pr");
  const card = input.card === undefined || input.card === null ? null : normalizeHangarDecisionCard(input.card);
  const filedBy = input.filedBy === undefined ? null : actorOf(input.filedBy);

  return db.transaction(async (tx) => {
    const state = await sessionState(tx, sessionId, "share");
    if (state === null || !LIVE_STATES.includes(state)) {
      throw new HangarDecisionRefusedError(sessionId, "session_state", state === null ? "no such hangar session" : `the session is ${state}; only a claimed or running session files a decision`);
    }
    await withdrawRelayActions(
      tx,
      sql`SELECT (escalation->>'relay_action_id')::bigint FROM hangar_decisions
          WHERE session_id = ${sessionId}::uuid AND state IN ('pending', 'escalated') AND escalation->>'via' = 'review' AND NOT (escalation ? 'review_id')`,
      "withdrawn: the session filed a new decision before this review was filed",
    );
    await tx.execute(sql`
      UPDATE hangar_decisions SET state = 'superseded', updated_at = now()
      WHERE session_id = ${sessionId}::uuid AND state IN ('pending', 'escalated')
    `);
    const inserted = await tx.execute<DecisionRow>(sql`
      INSERT INTO hangar_decisions (session_id, kind, title, summary, pr_url, card, filed_by)
      VALUES (${sessionId}::uuid, ${input.kind as string}, ${title}, ${summary}, ${prUrl}, ${card === null ? null : JSON.stringify(card)}::jsonb, ${filedBy})
      RETURNING ${COLUMNS}
    `);
    return toDecision(inserted.rows[0]!);
  });
}

// --- Reading ---------------------------------------------------------------------------------

/** Each session's open decision (pending or escalated), by session id; a session with none is absent. One statement. */
export async function getOpenHangarDecisions(db: Database, sessionIds: readonly string[]): Promise<Map<string, HangarDecision>> {
  const ids = [...new Set(sessionIds.map(sessionIdOf))];
  if (ids.length === 0) return new Map();
  const result = await db.execute<DecisionRow>(sql`
    SELECT DISTINCT ON (session_id) ${COLUMNS} FROM hangar_decisions
    WHERE session_id = ANY(${sqlArray(ids, "uuid")}) AND state IN ('pending', 'escalated')
    ORDER BY session_id, created_at DESC, id DESC
  `);
  return new Map(result.rows.map((r) => [r.session_id, toDecision(r)]));
}

export async function getHangarDecision(db: Database | Tx, id: string): Promise<HangarDecision | null> {
  if (typeof id !== "string" || !UUID_RE.test(id)) return null;
  const result = await db.execute<DecisionRow>(sql`SELECT ${COLUMNS} FROM hangar_decisions WHERE id = ${id}::uuid`);
  const row = result.rows[0];
  return row === undefined ? null : toDecision(row);
}

/** The session's open decision, row-locked. */
async function lockOpenDecision(tx: Tx, sessionId: string): Promise<HangarDecision | null> {
  const result = await tx.execute<DecisionRow>(sql`
    SELECT ${COLUMNS} FROM hangar_decisions
    WHERE session_id = ${sessionId}::uuid AND state IN ('pending', 'escalated')
    ORDER BY created_at DESC, id DESC
    LIMIT 1
    FOR UPDATE
  `);
  const row = result.rows[0];
  return row === undefined ? null : toDecision(row);
}

// --- Answering ---------------------------------------------------------------------------------

/** Records the answer and, when `send`, appends it to the session's messages; inside the caller's transaction. */
async function resolveInTx(tx: Tx, decision: HangarDecision, answer: HangarDecisionAnswer, send: boolean): Promise<{ messageId: number | null }> {
  let messageId: number | null = null;
  if (send) messageId = (await appendHangarMessage(tx, { sessionId: decision.sessionId, kind: HANGAR_DECISION_MESSAGE_KIND, body: hangarDecisionMessageBody(decision, answer) })).id;
  await tx.execute(sql`
    UPDATE hangar_decisions SET state = 'decided', decision = ${JSON.stringify(answer)}::jsonb, updated_at = now()
    WHERE id = ${decision.id}::uuid
  `);
  return { messageId };
}

export interface DecideHangarDecisionInput {
  sessionId: string;
  /** The decision the driver read; refused (`superseded`) when the session's open decision is another. */
  decisionId?: string;
  decision: unknown;
  option?: unknown;
  note?: unknown;
  /** The driver's client name: the answer's `by`. */
  actor: string;
}

export interface DecideHangarDecisionResult {
  decision: HangarDecision;
  messageId: number;
}

/**
 * The driver answers its session's open decision (module header). Refused
 * (`HangarDecisionRefusedError`, nothing written) when the session has none,
 * when `decisionId` names another (`superseded`), when it was escalated and
 * its review filed (only the person answers it), and when the session has
 * ended. An escalation whose review is not filed yet is withdrawn: its
 * queued relay action is failed. The answer is checked against the card
 * (`checkHangarDecisionAnswer`).
 */
export async function decideHangarDecision(db: Database, input: DecideHangarDecisionInput): Promise<DecideHangarDecisionResult> {
  const sessionId = sessionIdOf(input.sessionId);
  const by = actorOf(input.actor);
  return db.transaction(async (tx) => {
    const open = await lockOpenDecision(tx, sessionId);
    if (open === null) throw new HangarDecisionRefusedError(sessionId, "none", "the session has no decision waiting; it files one when it has a PR or a question");
    if (input.decisionId !== undefined && input.decisionId.toLowerCase() !== open.id) {
      throw new HangarDecisionRefusedError(sessionId, "superseded", `decision ${input.decisionId} is no longer the session's open one; it now waits on ${open.id} ("${open.title}"): read it with brain_hangar_sessions`);
    }
    if (open.state === "escalated" && !hangarEscalationUnfiled(open.escalation)) {
      throw new HangarDecisionRefusedError(sessionId, "escalated", `decision ${open.id} was escalated to the person; only their decision on the review answers it`);
    }
    const answer = checkHangarDecisionAnswer(open, { decision: input.decision, option: input.option, note: input.note, by, via: "driver" });
    await assertSessionReads(tx, sessionId);
    if (open.escalation?.via === "review" && open.state === "escalated") {
      await withdrawRelayActions(tx, sql`SELECT ${open.escalation.relay_action_id}::bigint`, "withdrawn: the driver decided it before the review was filed");
    }
    const { messageId } = await resolveInTx(tx, open, answer, true);
    return { decision: { ...open, state: "decided", decision: answer }, messageId: messageId! };
  });
}

// --- Escalation bookkeeping (hangar-escalation.ts) -------------------------------------------------

/** Refuses a decision that cannot be escalated now: none open, the one read is gone, or it is escalated already. Pure. */
function assertEscalatable(sessionId: string, open: HangarDecision | null, decisionId?: string): HangarDecision {
  if (open === null) throw new HangarDecisionRefusedError(sessionId, "none", "the session has no decision waiting to escalate");
  if (decisionId !== undefined && decisionId !== open.id) throw new HangarDecisionRefusedError(sessionId, "superseded", `decision ${decisionId} was answered or superseded while it was being escalated; it now waits on ${open.id}`);
  if (open.state === "escalated") throw new HangarDecisionRefusedError(sessionId, "escalated", `decision ${open.id} is already escalated to the person`);
  return open;
}

/**
 * The session's open decision as it can be escalated: pending, with the
 * session still reading messages. Refused otherwise (`none`, `escalated`,
 * `session_ended`). Unlocked: a read to build the escalation from;
 * `unsafeLockEscalatableInTx` decides.
 */
export async function getEscalatableHangarDecision(db: Database, sessionId: string): Promise<HangarDecision> {
  const id = sessionIdOf(sessionId);
  return db.transaction(async (tx) => {
    const open = assertEscalatable(id, await lockOpenDecision(tx, id));
    await assertSessionReads(tx, id);
    return open;
  });
}

/** `getEscalatableHangarDecision`'s locked check, in the caller's transaction, for the decision it read (`decisionId`). */
export async function unsafeLockEscalatableInTx(tx: Tx, sessionId: string, decisionId: string): Promise<HangarDecision> {
  const id = sessionIdOf(sessionId);
  const open = assertEscalatable(id, await lockOpenDecision(tx, id), decisionId);
  await assertSessionReads(tx, id);
  return open;
}

/** Marks the decision locked by `unsafeLockEscalatableInTx` escalated, in the same transaction. */
export async function unsafeMarkEscalatedInTx(tx: Tx, id: string, escalation: HangarEscalation): Promise<void> {
  await tx.execute(sql`
    UPDATE hangar_decisions SET state = 'escalated', escalation = ${JSON.stringify(escalation)}::jsonb, updated_at = now()
    WHERE id = ${id}::uuid
  `);
}

/** The fallback inbox item for an inbox escalation is filed: record its id, which the person's decision is matched on. */
export async function recordHangarEscalationItem(db: Database, input: { id: string; itemId: string }): Promise<boolean> {
  const updated = await db.execute(sql`
    UPDATE hangar_decisions SET escalation = escalation || jsonb_build_object('item_id', ${input.itemId}::text), updated_at = now()
    WHERE id = ${input.id}::uuid AND state = 'escalated' AND escalation->>'via' = 'inbox'
  `);
  return (updated.rowCount ?? 0) > 0;
}

/** Filing the fallback inbox item failed: the decision is pending again. */
export async function revertHangarEscalation(db: Database, id: string): Promise<void> {
  await db.execute(sql`
    UPDATE hangar_decisions SET state = 'pending', escalation = NULL, updated_at = now()
    WHERE id = ${id}::uuid AND state = 'escalated' AND escalation->>'via' = 'inbox' AND escalation->>'item_id' IS NULL
  `);
}

/** The relay filed the escalation's review: record its bead id, which the person's decision is matched on. */
export async function recordHangarEscalationReview(db: Database | Tx, input: { relayActionId: number; reviewId: string }): Promise<boolean> {
  const updated = await db.execute(sql`
    UPDATE hangar_decisions
    SET escalation = escalation || jsonb_build_object('review_id', ${input.reviewId}::text), updated_at = now()
    WHERE state = 'escalated' AND escalation->>'via' = 'review' AND escalation->>'relay_action_id' = ${String(input.relayActionId)}
  `);
  return (updated.rowCount ?? 0) > 0;
}

/** The relay could not file the escalation's review: the decision is pending again, with the error, so the driver can retry. */
export async function failHangarEscalation(db: Database | Tx, input: { relayActionId: number; error: string }): Promise<boolean> {
  const updated = await db.execute(sql`
    UPDATE hangar_decisions
    SET state = 'pending', escalation = escalation || jsonb_build_object('error', ${input.error.slice(0, 2000)}::text), updated_at = now()
    WHERE state = 'escalated' AND escalation->>'via' = 'review' AND escalation->>'relay_action_id' = ${String(input.relayActionId)}
  `);
  return (updated.rowCount ?? 0) > 0;
}

export interface RouteReviewDecisionInput {
  projectKey: string;
  /** The review bead's id. */
  reviewId: string;
  decision: "accept" | "changes";
  option?: string;
  message: string;
  /** The person (the deciding client, or "human"). */
  by: string;
}

/**
 * A person decided a review: when it is an escalated hangar decision's
 * review (matched on its project and bead id, module header), the decision
 * is recorded and, while the session is live, appended to its messages.
 * An option is kept when the escalation's card offers it. Delivered while
 * the session reads messages (DELIVERABLE_STATES). Null when the review is
 * no escalation's. Never throws for a mismatch: the
 * review decision itself is already written.
 */
export async function routeReviewDecision(db: Database, input: RouteReviewDecisionInput): Promise<{ decisionId: string; sessionId: string; messageId: number | null } | null> {
  return db.transaction(async (tx) => {
    const found = await tx.execute<DecisionRow>(sql`
      SELECT ${COLUMNS} FROM hangar_decisions
      WHERE state = 'escalated' AND escalation->>'via' = 'review'
        AND escalation->>'project_key' = ${input.projectKey} AND escalation->>'review_id' = ${input.reviewId}
      ORDER BY created_at DESC
      LIMIT 1
      FOR UPDATE
    `);
    const row = found.rows[0];
    if (row === undefined) return null;
    const decision = toDecision(row);
    // The person chose among the card they were shown: the escalation's, else (an escalation before cards were kept) the worker's.
    const shown = decision.escalation?.card ?? decision.card;
    const offered = shown?.options ?? [];
    const option = input.option !== undefined && offered.some((o) => o.id === input.option) ? input.option : undefined;
    const answer: HangarDecisionAnswer = { decision: input.decision, outcome: OUTCOME_OF[input.decision], ...(option === undefined ? {} : { option }), message: input.message.trim(), by: actorOf(input.by), via: "review" };
    const state = await sessionState(tx, decision.sessionId, "share");
    const { messageId } = await resolveInTx(tx, decision, answer, state !== null && DELIVERABLE_STATES.includes(state));
    return { decisionId: decision.id, sessionId: decision.sessionId, messageId };
  });
}

/**
 * The person decided the inbox item an escalation fell back to
 * (hangar-escalation.ts): inside `decideInboxItem`'s transaction, after it
 * told the session through its own message. Matched on the item's id and
 * its session (module header); true when it was one, and the decision is
 * then recorded and appended as a `session_decision`. "unsafe": the caller
 * vouches that a person decided and that the session is live.
 */
export async function unsafeRouteInboxDecisionInTx(
  tx: Tx,
  input: { itemId: string; sessionId: string; decision: HangarDecideDecision; option?: string; message: string; by: string },
): Promise<boolean> {
  const found = await tx.execute<DecisionRow>(sql`
    SELECT ${COLUMNS} FROM hangar_decisions
    WHERE state = 'escalated' AND session_id = ${input.sessionId}::uuid
      AND escalation->>'via' = 'inbox' AND escalation->>'item_id' = ${input.itemId}
    LIMIT 1
    FOR UPDATE
  `);
  const row = found.rows[0];
  if (row === undefined) return false;
  const answer: HangarDecisionAnswer = {
    decision: input.decision,
    outcome: OUTCOME_OF[input.decision],
    ...(input.option === undefined ? {} : { option: input.option }),
    message: input.message,
    by: actorOf(input.by),
    via: "inbox",
  };
  await resolveInTx(tx, toDecision(row), answer, true);
  return true;
}
