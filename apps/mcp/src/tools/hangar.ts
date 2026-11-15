// The four hangar tools (hangar-queue change, design decision 7; brain-mcp
// spec, "Hangar tools"; hangar-release): brain_hangar_request queues a
// session for a work item, brain_hangar_status reports hangar's liveness, its
// latest capacity and when it was reported, and the open session counts,
// brain_hangar_sessions lists sessions, each queued one with why it waits
// (hangar-capacity: `explainQueuedSessions`, computed on read), and
// brain_hangar_outcome_request asks the person to accept or table an ended
// session through an inbox item. Hangar itself claims and reports over the
// web server's REST API (docs/hangar-api.md); nothing here claims, changes a
// session's state or outcome, or returns a token: only a person sets an
// outcome. brain_hangar_request and brain_hangar_outcome_request write, so
// read-only mode refuses them; a session token is refused both
// (server.ts SESSION_REFUSED_TOOLS).

import {
  explainQueuedSessions,
  getHangarStatus,
  HANGAR_FLAVORS,
  HANGAR_OUTCOMES,
  HANGAR_SESSION_STATES,
  listSessions,
  MAX_HANGAR_OUTCOME_NOTE_LENGTH,
  MAX_HANGAR_REPO_LENGTH,
  requestHangarOutcome,
  requestSession,
  type HangarCapacity,
  type HangarSession,
  type HangarStatus,
  type HangarWaiting,
} from "@breakdown/core";
import { z } from "zod";
import { boundResponse } from "../budget.js";
import type { ToolContext, ToolDef } from "../types.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const workItemIdField = z.string().regex(UUID_RE, "must be a valid uuid (a work_item node id returned by brain_list, brain_search, or brain_get)");

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

/** `waiting` is why a queued session waits (null for every other state). */
function sessionJson(s: HangarSession, waiting: HangarWaiting | null): Record<string, unknown> {
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
    released: s.released,
    waiting,
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
    "the person's outcome (accepted, tabled, or null) with when and by whom, and released (hangar has deleted its disk). Read-only.",
  schema: sessionsSchema,
  isWrite: false,
  async handler(ctx: ToolContext, args) {
    const listed = await listSessions(ctx.db, {
      ...(args.states === undefined ? {} : { states: args.states }),
      ...(args.workItemId === undefined ? {} : { workItemId: args.workItemId }),
      ...(args.releasable === undefined ? {} : { releasable: args.releasable }),
      limit: args.limit ?? DEFAULT_SESSIONS_LIMIT,
    });
    const queued = listed.sessions.filter((s) => s.state === "queued").map((s) => s.id);
    const waiting = queued.length === 0 ? new Map<string, HangarWaiting>() : await explainQueuedSessions(ctx.db, { ids: queued });
    return boundResponse(
      listed.sessions.map((s) => sessionJson(s, waiting.get(s.id) ?? null)),
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
        };
      },
      ctx.responseCharBudget,
    );
  },
};

// --- brain_hangar_outcome_request -----------------------------------------------

const outcomeRequestSchema = z.object({
  sessionId: z.string().regex(UUID_RE, "must be a valid uuid (a hangar session id returned by brain_hangar_sessions)"),
  outcome: z.enum(HANGAR_OUTCOMES),
  note: z.string().trim().min(1).max(MAX_HANGAR_OUTCOME_NOTE_LENGTH),
});

export const hangarOutcomeRequestTool: ToolDef<typeof outcomeRequestSchema> = {
  name: "brain_hangar_outcome_request",
  description:
    "Ask the person to accept or table an ended (stopped or failed) hangar session: sessionId, outcome (accepted when the work is done or kept, tabled to set it aside), and note (why, 1-" +
    `${MAX_HANGAR_OUTCOME_NOTE_LENGTH} characters, shown to them). Files one inbox item for the session, with Accept and Table options and your outcome recommended; ` +
    "the person's choice sets the session's outcome, and hangar then deletes its disk and container. This tool sets no outcome itself: only a person does. " +
    "A repeat request for the same session updates its pending item; once the person has decided or dismissed it, status says so and nothing is re-asked. " +
    "Refused for a session that has not ended or that hangar has already released. Returns the inbox item id and its status.",
  schema: outcomeRequestSchema,
  isWrite: true,
  async handler(ctx: ToolContext, args) {
    const actor = ctx.actor();
    const filed = await requestHangarOutcome(ctx.db, { sessionId: args.sessionId, outcome: args.outcome, note: args.note, ...(actor === undefined ? {} : { actor }) });
    return { inboxItemId: filed.id, status: filed.status, action: filed.action, sessionId: filed.sessionId, requested: filed.requested };
  },
};

export const hangarTools: ToolDef[] = [hangarRequestTool, hangarStatusTool, hangarSessionsTool, hangarOutcomeRequestTool];
