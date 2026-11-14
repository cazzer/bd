// The three hangar tools (hangar-queue change, design decision 7; brain-mcp
// spec, "Hangar tools"): brain_hangar_request queues a session for a work
// item, brain_hangar_status reports hangar's liveness and the open session
// counts, brain_hangar_sessions lists sessions. Hangar itself claims and
// reports over the web server's REST API (docs/hangar-api.md); nothing here
// claims, changes a session's state, or returns a token. Only
// brain_hangar_request writes, so read-only mode refuses it alone.

import {
  getHangarStatus,
  HANGAR_FLAVORS,
  HANGAR_SESSION_STATES,
  listSessions,
  MAX_HANGAR_REPO_LENGTH,
  requestSession,
  type HangarSession,
  type HangarStatus,
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

function liveness(status: HangarStatus): { status: HangarStatus["state"]; lastSeenAt: string | null; text: string } {
  return { status: status.state, lastSeenAt: status.lastSeenAt?.toISOString() ?? null, text: hangarStatusText(status) };
}

function sessionJson(s: HangarSession): Record<string, unknown> {
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
    "of the hangar that last checked in; and how many sessions are queued, claimed, and running across every hangar. text is a one-line summary to show the person.",
  schema: statusSchema,
  isWrite: false,
  async handler(ctx: ToolContext) {
    const status = await getHangarStatus(ctx.db);
    const { text, ...rest } = liveness(status);
    return { ...rest, hangar: status.hangar, version: status.version, queued: status.counts.queued, claimed: status.counts.claimed, running: status.counts.running, text };
  },
};

// --- brain_hangar_sessions --------------------------------------------------------

const sessionsSchema = z.object({
  states: z.array(z.enum(HANGAR_SESSION_STATES)).min(1).max(HANGAR_SESSION_STATES.length).optional(),
  workItemId: workItemIdField.optional(),
  limit: z.number().int().min(1).max(MAX_SESSIONS_LIMIT).optional(),
});

export const hangarSessionsTool: ToolDef<typeof sessionsSchema> = {
  name: "brain_hangar_sessions",
  description:
    `List hangar sessions, most recently changed first: filter by states (${HANGAR_SESSION_STATES.join(", ")}) and by workItemId (the work item a session runs for). ` +
    `limit is 1-${MAX_SESSIONS_LIMIT}, default ${DEFAULT_SESSIONS_LIMIT}; hasMore says more sessions matched. Each session carries its state, flavor, repo, work item, ` +
    "who requested it, which hangar claimed it and when, where it runs (container, host, diskPath), why it was last requeued, and why a claim marked it failed (failureReason). Read-only.",
  schema: sessionsSchema,
  isWrite: false,
  async handler(ctx: ToolContext, args) {
    const listed = await listSessions(ctx.db, {
      ...(args.states === undefined ? {} : { states: args.states }),
      ...(args.workItemId === undefined ? {} : { workItemId: args.workItemId }),
      limit: args.limit ?? DEFAULT_SESSIONS_LIMIT,
    });
    return boundResponse(
      listed.sessions.map(sessionJson),
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

export const hangarTools: ToolDef[] = [hangarRequestTool, hangarStatusTool, hangarSessionsTool];
