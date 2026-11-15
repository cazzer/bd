// The hangar tools (hangar-queue change, design decision 7; brain-mcp
// spec, "Hangar tools"; hangar-release; hangar-driver-decisions):
// brain_hangar_request queues a session for a work item, brain_hangar_status
// reports hangar's liveness, its latest capacity and when it was reported,
// and the open session counts, and brain_hangar_sessions lists sessions, each
// queued one with why it waits (hangar-capacity: `explainQueuedSessions`,
// computed on read; the sessions awaiting release behind a full disk are
// listed once, at the top level, not on every queued session, to keep the
// response inside its budget) and each open one with the decision it waits
// on (`pendingDecision`).
//
// The driver — the agent that requested and runs the work — decides for its
// sessions (hangar-driver-decisions): brain_hangar_outcome releases an ended
// session itself (accepted or tabled, `outcome_by` its client),
// brain_hangar_decide answers a session's pending decision (a PR, a
// question) through the session's messages, and brain_hangar_escalate hands
// a big call to the person as a review. brain_hangar_outcome_request is
// retired: it files nothing and points at brain_hangar_outcome, since
// releasing never goes to the person. Hangar itself claims and reports over
// the web server's REST API (docs/hangar-api.md); nothing here claims,
// changes a session's state, or returns a token. Every tool that writes is
// refused in read-only mode, and a session token is refused each one but the
// reads (server.ts SESSION_REFUSED_TOOLS): a worker never decides, releases,
// or escalates its own work.

import {
  decideHangarDecision,
  escalateHangarDecision,
  explainQueuedSessions,
  getOpenHangarDecisions,
  HANGAR_DECIDE_DECISIONS,
  MAX_HANGAR_DECISION_NOTE_LENGTH,
  MAX_HANGAR_ESCALATION_NOTE_LENGTH,
  setHangarSessionOutcome,
  type HangarDecision,
  getHangarStatus,
  HANGAR_FLAVORS,
  HANGAR_OUTCOMES,
  HANGAR_SESSION_STATES,
  HANGAR_WAIT_KINDS,
  listSessions,
  MAX_HANGAR_OUTCOME_NOTE_LENGTH,
  MAX_HANGAR_REPO_LENGTH,
  requestSession,
  type HangarCapacity,
  type HangarSession,
  type HangarStatus,
  type HangarWaiting,
} from "@breakdown/core";
import { z } from "zod";
import { boundResponse } from "../budget.js";
import { RetiredToolError } from "../errors.js";
import type { ToolContext, ToolDef } from "../types.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const workItemIdField = z.string().regex(UUID_RE, "must be a valid uuid (a work_item node id returned by brain_list, brain_search, or brain_get)");
const sessionIdField = z.string().regex(UUID_RE, "must be a valid uuid (a hangar session id returned by brain_hangar_sessions)");

/** Who decided, for `outcome_by` and a decision's `by`: the token's client, else the connected software, else "agent". */
function decider(ctx: ToolContext): string {
  return ctx.tokenClient ?? ctx.actor() ?? "agent";
}

const MAX_SESSIONS_LIMIT = 100;
const DEFAULT_SESSIONS_LIMIT = 50;

/** "hangar online", "hangar offline since <ISO>", or "hangar has never checked in". */
export function hangarStatusText(status: HangarStatus): string {
  if (status.state === "online") return "hangar online";
  if (status.state === "offline") return `hangar offline since ${status.lastSeenAt.toISOString()}`;
  return "hangar has never checked in";
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * The capacity summary brain_hangar_status shows: "headless: 2 slots;
 * display-godot blocked (vram: …); free 12000 MB RAM, 4 CPUs, 0 MB VRAM,
 * 50000 MB disk; reported <ISO>", leaving out what hangar did not send, or
 * "no capacity reported".
 */
export function hangarCapacityText(capacity: HangarCapacity | null, capacityAt: Date | null): string {
  if (capacity === null) return "no capacity reported";
  const parts: string[] = [];
  for (const [flavor, n] of Object.entries(capacity.slots ?? {})) parts.push(`${flavor}: ${plural(n, "slot", "slots")}`);
  for (const [flavor, reason] of Object.entries(capacity.blocked ?? {})) parts.push(`${flavor} blocked (${reason})`);
  const free = capacity.free;
  if (free !== undefined) parts.push(`free ${free.ram_mb} MB RAM, ${plural(free.cpus, "CPU", "CPUs")}, ${free.vram_mb} MB VRAM, ${free.disk_mb} MB disk`);
  if (parts.length === 0) parts.push("no slots, blocked flavors, or free figures");
  if (capacityAt !== null) parts.push(`reported ${capacityAt.toISOString()}`);
  return parts.join("; ");
}

function liveness(status: HangarStatus): { status: HangarStatus["state"]; lastSeenAt: string | null; text: string } {
  return { status: status.state, lastSeenAt: status.lastSeenAt?.toISOString() ?? null, text: hangarStatusText(status) };
}

type WaitingJson = Exclude<HangarWaiting, { kind: "disk_awaiting_review" }> | Omit<Extract<HangarWaiting, { kind: "disk_awaiting_review" }>, "sessions">;

/** A session's `waiting` without the awaiting-review list, which the response carries once as `awaitingReview`. */
function waitingJson(waiting: HangarWaiting): WaitingJson {
  if (waiting.kind !== "disk_awaiting_review") return waiting;
  const { sessions: _listedOnce, ...rest } = waiting;
  return rest;
}

/** A session's open decision as the driver reads it (null when it waits on none). */
function pendingDecisionJson(d: HangarDecision | undefined): Record<string, unknown> | null {
  if (d === undefined) return null;
  return { id: d.id, kind: d.kind, title: d.title, summary: d.summary, prUrl: d.prUrl, card: d.card, state: d.state, escalation: d.escalation, filedAt: d.createdAt.toISOString() };
}

/** `waiting` is why a queued session waits (null for every other state). */
function sessionJson(s: HangarSession, waiting: WaitingJson | null, pending: HangarDecision | undefined): Record<string, unknown> {
  return {
    id: s.id,
    title: s.title,
    state: s.state,
    flavor: s.flavor,
    repo: s.repo,
    workItemId: s.workItemId,
    requestedBy: s.requestedBy,
    requestedAt: s.occurredAt,
    claimedBy: s.claimedBy,
    claimedAt: s.claimedAt,
    container: s.container,
    host: s.host,
    diskPath: s.diskPath,
    requeueReason: s.requeueReason,
    failureReason: s.failureReason,
    outcome: s.outcome,
    outcomeAt: s.outcomeAt,
    outcomeBy: s.outcomeBy,
    outcomeVia: s.outcomeVia,
    outcomeNote: s.outcomeNote,
    released: s.released,
    waiting,
    pendingDecision: pendingDecisionJson(pending),
    updatedAt: s.updatedAt.toISOString(),
  };
}

// --- brain_hangar_request ------------------------------------------------------

const requestSchema = z.object({
  repo: z.string().trim().min(1).max(MAX_HANGAR_REPO_LENGTH),
  workItemId: workItemIdField,
  flavor: z.enum(HANGAR_FLAVORS),
});

export const hangarRequestTool: ToolDef<typeof requestSchema> = {
  name: "brain_hangar_request",
  description:
    "Request a remote Claude session from hangar for one work item: repo (e.g. owner/name), workItemId (a work_item node id), and flavor " +
    `(${HANGAR_FLAVORS.join(", ")}: headless for plain shell work, display-godot or display-browser when the work needs a display). ` +
    "The session is queued whether or not hangar is online, linked to the work item, and recorded as requested by this client; hangar claims it the next time it polls. " +
    "Returns the session id, state \"queued\", and hangar's status (online, offline since a time, or never checked in) so you can tell the person when to expect it. " +
    "Follow it with brain_hangar_sessions. This tool never claims a session, changes one, or returns a token.",
  schema: requestSchema,
  isWrite: true,
  async handler(ctx: ToolContext, args) {
    const actor = ctx.actor();
    const { session, status } = await requestSession(ctx.db, { repo: args.repo, workItemId: args.workItemId, flavor: args.flavor, ...(actor === undefined ? {} : { actor }) });
    return { sessionId: session.id, state: "queued", hangar: liveness(status) };
  },
};

// --- brain_hangar_status ---------------------------------------------------------

const statusSchema = z.object({});

export const hangarStatusTool: ToolDef<typeof statusSchema> = {
  name: "brain_hangar_status",
  description:
    "Hangar's status: online (checked in within the last three check-in intervals), offline since its last check-in, or never checked in; the name and version " +
    "of the hangar that last checked in; that hangar's latest capacity as it reported it (capacity: slots per flavor, why other flavors are blocked, free RAM/CPU/VRAM/disk, " +
    "session and disk totals, per-session disk usage; null when it sent none) and when it was reported (capacityAt); and how many sessions are queued, claimed, and running " +
    "across every hangar. text is a one-line liveness summary and capacityText a one-line capacity summary, both to show the person.",
  schema: statusSchema,
  isWrite: false,
  async handler(ctx: ToolContext) {
    const status = await getHangarStatus(ctx.db);
    const { text, ...rest } = liveness(status);
    return {
      ...rest,
      hangar: status.hangar,
      version: status.version,
      queued: status.counts.queued,
      claimed: status.counts.claimed,
      running: status.counts.running,
      capacity: status.capacity,
      capacityAt: status.capacityAt?.toISOString() ?? null,
      capacityText: hangarCapacityText(status.capacity, status.capacityAt),
      text,
    };
  },
};

// --- brain_hangar_sessions --------------------------------------------------------

const sessionsSchema = z.object({
  states: z.array(z.enum(HANGAR_SESSION_STATES)).min(1).max(HANGAR_SESSION_STATES.length).optional(),
  workItemId: workItemIdField.optional(),
  releasable: z.boolean().optional(),
  limit: z.number().int().min(1).max(MAX_SESSIONS_LIMIT).optional(),
});

export const hangarSessionsTool: ToolDef<typeof sessionsSchema> = {
  name: "brain_hangar_sessions",
  description:
    `List hangar sessions, most recently changed first: filter by states (${HANGAR_SESSION_STATES.join(", ")}), by workItemId (the work item a session runs for), ` +
    "and with releasable: true to only those a person has accepted or tabled whose disk hangar still holds. " +
    `limit is 1-${MAX_SESSIONS_LIMIT}, default ${DEFAULT_SESSIONS_LIMIT}; hasMore says more sessions matched. Each session carries its state, flavor, repo, work item, ` +
    "who requested it, which hangar claimed it and when, where it runs (container, host, diskPath), why it was last requeued, why it failed (failureReason), " +
    "the person's outcome (accepted, tabled, or null) with when and by whom, released (hangar has deleted its disk), and waiting: on a queued session, why it waits " +
    `(kind ${HANGAR_WAIT_KINDS.join(", ")}; text is a one-line summary to show the person; since, ahead, reasons, and total as the kind has them), null on any other state. ` +
    "pendingDecision is what the session waits on you, its driver, to decide, or null: { id, kind (pr or question), title, summary, prUrl, card (question, options, " +
    "recommend, on_accept, body: the session's decision card, or null), state (pending: yours to answer with brain_hangar_decide; escalated: the person's, on the " +
    "review or inbox item escalation names), escalation, filedAt }. " +
    "When a queued session waits on a full disk (disk_awaiting_review), the response carries awaitingReview once: { sessions, each with id, claimedBy, workItem " +
    "({id, externalId, title, project} or null), and diskAllocatedBytes when hangar reported it, at most 20, oldest ended first; total }. Those are ended sessions " +
    "nobody has released: release the ones that are yours with brain_hangar_outcome (accepted when the work landed or is kept, tabled to set it aside) — do not ask " +
    "the person. awaitingReview is null otherwise. Read-only.",
  schema: sessionsSchema,
  isWrite: false,
  async handler(ctx: ToolContext, args) {
    const listed = await listSessions(ctx.db, {
      ...(args.states === undefined ? {} : { states: args.states }),
      ...(args.workItemId === undefined ? {} : { workItemId: args.workItemId }),
      ...(args.releasable === undefined ? {} : { releasable: args.releasable }),
      limit: args.limit ?? DEFAULT_SESSIONS_LIMIT,
    });
    const pending = await getOpenHangarDecisions(ctx.db, listed.sessions.filter((s) => s.state === "claimed" || s.state === "running").map((s) => s.id));
    const queued = listed.sessions.filter((s) => s.state === "queued").map((s) => s.id);
    const waiting = queued.length === 0 ? new Map<string, HangarWaiting>() : await explainQueuedSessions(ctx.db, { ids: queued });
    // Every disk wait from one call reads the same awaiting-review list, so the first stands for all.
    const onDisk = [...waiting.values()].find((w) => w.kind === "disk_awaiting_review");
    const awaitingReview = onDisk === undefined ? null : { sessions: onDisk.sessions, total: onDisk.total };
    return boundResponse(
      listed.sessions.map((s) => {
        const w = waiting.get(s.id);
        return sessionJson(s, w === undefined ? null : waitingJson(w), pending.get(s.id));
      }),
      (s) => s["id"] as string,
      (kept, meta) => {
        const notes: string[] = [];
        if (listed.truncated) notes.push("More sessions match than limit; raise limit or narrow states/workItemId.");
        if (meta.droppedIds.length > 0) notes.push(`${meta.droppedIds.length} session(s) were dropped to fit the response-size budget (ids in droppedSessionIds); narrow the filter or lower limit.`);
        if (meta.shrunkIds.length > 0) notes.push(`${meta.shrunkIds.length} session(s) had oversized fields truncated in place.`);
        return {
          sessions: kept,
          hasMore: listed.truncated,
          truncated: listed.truncated || meta.truncated,
          ...(notes.length > 0 ? { truncationNote: notes.join(" ") } : {}),
          droppedSessionIds: meta.droppedIds,
          shrunkSessionIds: meta.shrunkIds,
          awaitingReview,
        };
      },
      ctx.responseCharBudget,
    );
  },
};

// --- brain_hangar_outcome ----------------------------------------------------------

const outcomeSchema = z.object({
  sessionId: sessionIdField,
  outcome: z.enum(HANGAR_OUTCOMES),
  note: z.string().trim().min(1).max(MAX_HANGAR_OUTCOME_NOTE_LENGTH).optional(),
});

export const hangarOutcomeTool: ToolDef<typeof outcomeSchema> = {
  name: "brain_hangar_outcome",
  description:
    "Release an ended (stopped or failed) hangar session you drive: sessionId, outcome (accepted when the work landed or is kept — its PR merged, its answer used; " +
    "tabled to set it aside), and an optional note (stored with the outcome as outcomeNote). Sets the session's outcome directly, with outcomeBy your client name; hangar then removes its container and deletes its " +
    "disk at its next check-in, which frees disk for queued sessions. This is your decision as the driver: never ask the person whether a session can be released. " +
    "Setting the outcome it already has changes nothing (changed: false); the outcome can change until hangar has released the session. Refused for a session that has " +
    "not ended (a merged or closed PR ends it; so does the session finishing), that hangar has already released, or whose outcome a person set (yours never overwrites theirs). Returns the session's outcome, outcomeBy, and released.",
  schema: outcomeSchema,
  isWrite: true,
  async handler(ctx: ToolContext, args) {
    const set = await setHangarSessionOutcome(ctx.db, { id: args.sessionId, outcome: args.outcome, actor: decider(ctx), via: "driver", ...(args.note === undefined ? {} : { note: args.note }) });
    return { sessionId: set.session.id, outcome: set.session.outcome, outcomeBy: set.session.outcomeBy, outcomeNote: set.session.outcomeNote, released: set.session.released, changed: set.changed };
  },
};

// --- brain_hangar_decide -----------------------------------------------------------

const decideSchema = z.object({
  sessionId: sessionIdField,
  decisionId: z.string().regex(UUID_RE, "must be a valid uuid (the pendingDecision.id you read)").optional(),
  decision: z.enum(HANGAR_DECIDE_DECISIONS),
  option: z.string().min(1).max(16).optional(),
  note: z.string().max(MAX_HANGAR_DECISION_NOTE_LENGTH).optional(),
});

export const hangarDecideTool: ToolDef<typeof decideSchema> = {
  name: "brain_hangar_decide",
  description:
    "Answer the decision a hangar session you drive is waiting on (its pendingDecision on brain_hangar_sessions): sessionId; decisionId (recommended: the pendingDecision.id you read; " +
    "refused if the session has filed another since, so your answer never lands on a decision you didn't see); decision — accept (a PR: good " +
    "to merge, and you may merge it when nothing blocks it; a question: carry on, with your answer as option and/or note), changes (send it back to rework; note required, " +
    "saying what to change), or dismiss (drop it; the session stops work on it); option (accept only: one of the card's option ids; on a PR card, an option other " +
    "than the recommended one sends the session to rework the PR to it); and note. The answer goes straight to the session as a message; nothing reaches the person. " +
    "Decide routine calls yourself: PR reviews, which of the session's options to take, clarifications. Escalate with brain_hangar_escalate only when the call changes the " +
    "architecture or sets a fundamental direction. An escalated decision whose review is not filed yet (escalation without reviewId: the relay is away or failed it) " +
    "can still be answered here, which withdraws the escalation. Refused when the session has no pending decision, when it was escalated and its review filed (only the " +
    "person answers that one), or when the session has ended. Returns the decision id and the message id.",
  schema: decideSchema,
  isWrite: true,
  async handler(ctx: ToolContext, args) {
    const decided = await decideHangarDecision(ctx.db, {
      sessionId: args.sessionId,
      ...(args.decisionId === undefined ? {} : { decisionId: args.decisionId }),
      decision: args.decision,
      ...(args.option === undefined ? {} : { option: args.option }),
      ...(args.note === undefined ? {} : { note: args.note }),
      actor: decider(ctx),
    });
    return { decisionId: decided.decision.id, sessionId: decided.decision.sessionId, decision: args.decision, state: decided.decision.state, messageId: decided.messageId };
  },
};

// --- brain_hangar_escalate ------------------------------------------------------------

const escalateCardSchema = z.object({
  question: z.string(),
  options: z.array(z.object({ id: z.string(), label: z.string(), what: z.string().optional(), risk: z.string().optional() })).optional(),
  recommend: z.string().optional(),
  on_accept: z.array(z.string()).optional(),
  body: z.string().optional(),
});

const escalateSchema = z.object({
  sessionId: sessionIdField,
  card: escalateCardSchema,
  note: z.string().trim().max(MAX_HANGAR_ESCALATION_NOTE_LENGTH).optional(),
});

export const hangarEscalateTool: ToolDef<typeof escalateSchema> = {
  name: "brain_hangar_escalate",
  description:
    "Hand a hangar session's pending decision to the person, as a review. Use it ONLY for a big decision point: one that changes the architecture or sets a fundamental " +
    "direction for the project. Do NOT use it for routine calls — reviewing or merging a PR, releasing a session, picking among a session's options, answering a " +
    "clarifying question — which are yours to make with brain_hangar_decide and brain_hangar_outcome. sessionId; card, your decision card for the person: question " +
    "(at most 140 characters), options (2 to 6 of {id, label, what?, risk?}, only for a real choice), recommend (one option id), on_accept (at most 8 steps), and body " +
    "(markdown evidence: what is at stake, what you and the session found, a diff or mermaid diagram as a fenced block); limits are checked, never trimmed; and note " +
    "(why this needs the person). Files a review (a beads issue labelled review) under the session's work item, through the laptop relay, so it appears in the board's " +
    "review queue and in Needs me; when the work item has no registered beads project, it files an inbox item with the card instead. The person's decision goes back to " +
    "the session as a message; until then brain_hangar_decide refuses the decision. Refused when the session has no pending decision, it is already escalated, or the " +
    "session has ended. Returns via (review or inbox) and where it went.",
  schema: escalateSchema,
  isWrite: true,
  async handler(ctx: ToolContext, args) {
    const escalated = await escalateHangarDecision(ctx.db, { sessionId: args.sessionId, card: args.card, ...(args.note === undefined ? {} : { note: args.note }), actor: decider(ctx) });
    return { sessionId: args.sessionId, ...escalated };
  },
};

// --- brain_hangar_outcome_request (retired) -------------------------------------------

const outcomeRequestSchema = z.object({}).passthrough();

export const hangarOutcomeRequestTool: ToolDef<typeof outcomeRequestSchema> = {
  name: "brain_hangar_outcome_request",
  description: "Retired: files nothing. Releasing a session is the driver's decision, not the person's: release it yourself with brain_hangar_outcome.",
  schema: outcomeRequestSchema,
  isWrite: true,
  retired: true,
  async handler() {
    throw new RetiredToolError(
      "brain_hangar_outcome_request",
      "Releasing a hangar session is the driver's decision and never goes to the person. Call brain_hangar_outcome { sessionId, outcome: accepted | tabled, note? } instead; nothing was filed.",
    );
  },
};

export const hangarTools: ToolDef[] = [hangarRequestTool, hangarStatusTool, hangarSessionsTool, hangarOutcomeTool, hangarDecideTool, hangarEscalateTool, hangarOutcomeRequestTool];
