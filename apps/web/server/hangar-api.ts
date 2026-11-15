// Hangar's REST API at `/hangar/v1/` (hangar-queue decisions 1, 3, 4, 8).
// Hangar is a separate service on a machine that only connects out; it
// checks in, claims queued sessions by long-poll, and reports their state
// here. A worker inside a session reads that session's messages with the
// token its claim minted. docs/hangar-api.md is the published contract, and
// hangar-contract.test.ts keeps it in step with `HANGAR_ENDPOINTS`.
//
// The dispatcher (dispatch.ts) admits `hangar` and `agent` tokens on this
// route and hands over what admission established; this handler narrows it
// per endpoint: the service endpoints take `hangar` only, messages take an
// `agent` token bound to a session. A tokenless loopback request counts as
// `human` and is refused, like any other scope. A session's messages are
// always the admitting token's session, never one the request names.
//
// Every response is JSON; every error is `{ "error": { "code", "message" } }`.
// The request plumbing (bodies, errors, long-poll, the waiter cap) lives in
// json-api.ts, shared with the relay's API.
// A write (POST, PATCH) needs `application/json`, at most
// MAX_HANGAR_BODY_BYTES (declared or streamed), strict UTF-8, and a body the
// endpoint's schema accepts. Unknown fields are dropped, not refused, so a
// hangar built against a later v1 keeps working against this server; every
// known field is still checked for type and range. A read-only server
// answers reads and refuses every write.
//
// Long-poll (claim, messages) re-runs its query once a second until it finds
// something, its bound passes, the client's socket closes, or the server
// shuts down. Nothing is held across a pause: each attempt is its own
// statement or transaction. Once the socket is gone no further attempt runs,
// so a disconnected claimer never takes a session it cannot receive; a
// claim that commits as the socket goes, or whose answer cannot be built,
// is requeued at once rather than left claimed with a token nobody holds.
// One client holds at most MAX_CONCURRENT_LONG_POLLS long-polls open at a
// time; past that it is told to retry (429).
//
// Nothing here logs a token, a header, or a query string.

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  claimSession,
  getNodes,
  HangarEndedSessionChangeError,
  HANGAR_FLAVORS,
  HANGAR_SESSION_STATES,
  HangarSessionNotClaimedByError,
  HangarSessionNotFoundError,
  HangarTransitionError,
  InvalidHangarSessionError,
  InvalidLookupIdError,
  listSessions,
  MAX_HANGAR_DISK_PATH_LENGTH,
  MAX_HANGAR_FAILURE_REASON_LENGTH,
  MAX_HANGAR_FIELD_LENGTH,
  MAX_HANGAR_REQUEUE_REASON_LENGTH,
  MAX_HANGAR_SESSIONS_LIMIT,
  MAX_HANGAR_WAIT_S,
  DEFAULT_HANGAR_SESSIONS_LIMIT,
  readHangarMessages,
  recordCheckIn,
  requeueSession,
  updateSession,
  type HangarSession,
  type HangarSessionState,
  type ReadHangarMessagesResult,
} from "@breakdown/core";
import type { Database } from "@breakdown/db";
import { z } from "zod";
import type { AdmittedClient } from "./context.js";
import { ApiError, createWaiterCap, invalidRequest, longPoll, matchPath, readJsonBody as readCappedJsonBody, sendError, sendJson, splitUrl } from "./json-api.js";

export const HANGAR_API_PREFIX = "/hangar/v1/";
/** Every hangar request body is small JSON; anything past this is refused. */
export const MAX_HANGAR_BODY_BYTES = 64 * 1024;
/** What `GET /sessions` lists when no `state` is given: the open sessions hangar reconciles after a restart. */
const DEFAULT_LISTED_STATES: readonly HangarSessionState[] = ["claimed", "running"];
/** The most long-polls (claim and messages with `wait_s` > 0, together) one client may hold open at once. */
export const MAX_CONCURRENT_LONG_POLLS = 4;
/** The requeue reason for a claim whose caller left before it could be delivered. */
export const CLAIMER_GONE_REASON = "claimer disconnected before receiving the claim";

/** The endpoint table: the router below and docs/hangar-api.md are both checked against it. */
export const HANGAR_ENDPOINTS = [
  { method: "POST", path: "/hangar/v1/check-in", scope: "hangar" },
  { method: "POST", path: "/hangar/v1/claim", scope: "hangar" },
  { method: "PATCH", path: "/hangar/v1/sessions/:id", scope: "hangar" },
  { method: "POST", path: "/hangar/v1/sessions/:id/requeue", scope: "hangar" },
  { method: "GET", path: "/hangar/v1/sessions", scope: "hangar" },
  { method: "GET", path: "/hangar/v1/messages", scope: "agent" },
] as const;

type Endpoint = (typeof HANGAR_ENDPOINTS)[number];
/** `METHOD path` per endpoint (distributed, so not every method crossed with every path). */
type KeyOf<E> = E extends { method: infer M extends string; path: infer P extends string } ? `${M} ${P}` : never;
type EndpointKey = KeyOf<Endpoint>;

export interface HangarHandlerOptions {
  db: Database;
  /** BRAIN_READ_ONLY: every POST and PATCH is refused; reads answer. */
  readOnly?: boolean;
  /** Aborted at shutdown; a long-poll answers empty on it. */
  shutdownSignal?: AbortSignal;
  /**
   * Restricts claims to these session ids, read on every attempt. A test
   * seam (hangar.ts `ClaimSessionInput.among`): a suite sharing a database
   * with live data claims only its own fixtures. Never set in production.
   */
  claimAmong?: () => readonly string[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every hangar body is capped at MAX_HANGAR_BODY_BYTES (json-api.ts). */
const readJsonBody = <T extends z.ZodType>(req: IncomingMessage, schema: T): Promise<z.infer<T>> => readCappedJsonBody(req, schema, MAX_HANGAR_BODY_BYTES);

const checkInSchema = z.object({
  version: z.string().trim().min(1).max(MAX_HANGAR_FIELD_LENGTH),
  capacity: z.record(z.string(), z.unknown()).nullable().optional(),
});

const claimSchema = z.object({
  flavors: z
    .array(z.enum(HANGAR_FLAVORS))
    .min(1)
    .max(HANGAR_FLAVORS.length)
    .refine((flavors) => new Set(flavors).size === flavors.length, "must not name a flavor twice"),
  wait_s: z.number().int().min(0).max(MAX_HANGAR_WAIT_S).default(0),
});

// `outcome` is not a field here: only a person sets it, so a sent one is
// dropped like any unknown field (hangar-release; docs/hangar-api.md).
// `reason` is used only with state "failed"; with any other state, or none,
// it is an unused field and dropped before it is checked, so a hangar that
// sends it more widely keeps working.
const updateSchema = z.preprocess(
  (body) => {
    if (typeof body !== "object" || body === null || Array.isArray(body) || (body as Record<string, unknown>)["state"] === "failed") return body;
    const { reason: _unused, ...rest } = body as Record<string, unknown>;
    return rest;
  },
  z.object({
    state: z.enum(HANGAR_SESSION_STATES).optional(),
    container: z.string().max(MAX_HANGAR_FIELD_LENGTH).nullable().optional(),
    host: z.string().max(MAX_HANGAR_FIELD_LENGTH).nullable().optional(),
    disk_path: z.string().max(MAX_HANGAR_DISK_PATH_LENGTH).nullable().optional(),
    reason: z.string().trim().min(1).max(MAX_HANGAR_FAILURE_REASON_LENGTH).optional(),
  }),
);

const requeueSchema = z.object({
  reason: z.string().trim().min(1).max(MAX_HANGAR_REQUEUE_REASON_LENGTH),
});

// --- Query strings -----------------------------------------------------------------

/** One integer query parameter from `min` to `max`, or `fallback` when absent; given twice is refused. */
function intParam(params: URLSearchParams, name: string, min: number, max: number, fallback: number): number {
  const values = params.getAll(name);
  if (values.length === 0) return fallback;
  if (values.length > 1) throw invalidRequest(`${name}: give it at most once`);
  const value = values[0]!;
  const n = /^\d{1,16}$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) throw invalidRequest(`${name}: must be an integer from ${min} to ${max}`);
  return n;
}

// --- Responses -----------------------------------------------------------------------

interface WorkItemJson {
  id: string;
  external_id: string;
  source_system: string;
  title: string;
}

/** Sessions as the contract spells them (snake_case), each with its work item; one lookup for the batch. */
async function sessionsJson(db: Database, sessions: readonly HangarSession[]): Promise<Record<string, unknown>[]> {
  const ids = [...new Set(sessions.flatMap((s) => (s.workItemId === null ? [] : [s.workItemId])))];
  const workItems = new Map<string, WorkItemJson>();
  if (ids.length > 0) {
    for (const node of (await getNodes(db, ids)).nodes) {
      const json = { id: node.id, external_id: node.externalId, source_system: node.sourceSystem, title: node.title };
      for (const requested of [node.id, ...node.requestedIds]) workItems.set(requested, json);
    }
  }
  return sessions.map((s) => ({
    id: s.id,
    state: s.state,
    flavor: s.flavor,
    repo: s.repo,
    work_item: s.workItemId === null ? null : (workItems.get(s.workItemId) ?? null),
    container: s.container,
    host: s.host,
    disk_path: s.diskPath,
    requeue_reason: s.requeueReason,
    failure_reason: s.failureReason,
    claimed_by: s.claimedBy,
    claimed_at: s.claimedAt,
    requested_at: s.occurredAt,
    outcome: s.outcome,
    outcome_at: s.outcomeAt,
    outcome_by: s.outcomeBy,
    released: s.released,
  }));
}

async function sessionJson(db: Database, session: HangarSession): Promise<Record<string, unknown>> {
  return (await sessionsJson(db, [session]))[0]!;
}

// --- The handler ------------------------------------------------------------------------

interface Call {
  req: IncomingMessage;
  res: ServerResponse;
  admitted: AdmittedClient;
  /** The `:id` segment, when the endpoint has one (already a uuid). */
  id: string | undefined;
  query: URLSearchParams;
  /** Aborted when the client's socket closes or the server shuts down. */
  signal: AbortSignal;
}

type EndpointHandler = (call: Call) => Promise<void>;

function mapCoreError(err: unknown): ApiError | null {
  if (err instanceof ApiError) return err;
  if (err instanceof HangarTransitionError) return new ApiError(409, "invalid_transition", err.message);
  if (err instanceof HangarEndedSessionChangeError) return new ApiError(409, "session_ended", err.message);
  if (err instanceof HangarSessionNotClaimedByError) return new ApiError(403, "not_claimer", err.message);
  if (err instanceof HangarSessionNotFoundError) return new ApiError(404, "not_found", err.message);
  if (err instanceof InvalidHangarSessionError || err instanceof InvalidLookupIdError) return invalidRequest(err.message);
  return null;
}

export function createHangarHandler({ db, readOnly = false, shutdownSignal, claimAmong }: HangarHandlerOptions): (req: IncomingMessage, res: ServerResponse, admitted: AdmittedClient | null) => Promise<void> {
  /** Open long-polls per client (`MAX_CONCURRENT_LONG_POLLS`): a long-poll past the cap is refused with 429. */
  const asWaiter = createWaiterCap(
    MAX_CONCURRENT_LONG_POLLS,
    `This client already holds ${MAX_CONCURRENT_LONG_POLLS} long-polls open (claim and messages together); retry once one answers.`,
  );

  const handlers: Record<EndpointKey, EndpointHandler> = {
    "POST /hangar/v1/check-in": async ({ req, res, admitted }) => {
      const body = await readJsonBody(req, checkInSchema);
      const { intervalS, now } = await recordCheckIn(db, { hangar: admitted.client, version: body.version, capacity: body.capacity ?? null });
      sendJson(res, 200, { interval_s: intervalS, now: now.toISOString() });
    },

    "POST /hangar/v1/claim": async ({ req, res, admitted, signal }) => {
      const body = await readJsonBody(req, claimSchema);
      const claimed = await asWaiter(admitted.client, body.wait_s, () =>
        longPoll(body.wait_s, signal, () => claimSession(db, { hangar: admitted.client, flavors: body.flavors, ...(claimAmong === undefined ? {} : { among: claimAmong() }) })),
      );
      if (claimed === null) {
        sendJson(res, 200, { session: null });
        return;
      }
      // Nobody will hold this token: give the session back rather than strand it claimed (module header).
      const giveBack = () => requeueSession(db, { hangar: admitted.client, id: claimed.session.id, reason: CLAIMER_GONE_REASON });
      if (res.destroyed || res.writableEnded) {
        await giveBack();
        return;
      }
      let session: Record<string, unknown>;
      try {
        session = await sessionJson(db, claimed.session);
      } catch (err) {
        await giveBack().catch((requeueErr: unknown) => console.error(`[breakdown-web] hangar claim: could not requeue session ${claimed.session.id} after a failed answer:`, requeueErr));
        throw err;
      }
      if (res.destroyed) {
        await giveBack();
        return;
      }
      sendJson(res, 200, { session, token: claimed.token });
    },

    "PATCH /hangar/v1/sessions/:id": async ({ req, res, admitted, id }) => {
      const body = await readJsonBody(req, updateSchema);
      const result = await updateSession(db, {
        hangar: admitted.client,
        id: id!,
        ...(body.state === undefined ? {} : { state: body.state }),
        ...(body.container === undefined ? {} : { container: body.container }),
        ...(body.host === undefined ? {} : { host: body.host }),
        ...(body.disk_path === undefined ? {} : { diskPath: body.disk_path }),
        ...(body.reason === undefined ? {} : { reason: body.reason }),
      });
      sendJson(res, 200, { session: await sessionJson(db, result.session) });
    },

    "POST /hangar/v1/sessions/:id/requeue": async ({ req, res, admitted, id }) => {
      const body = await readJsonBody(req, requeueSchema);
      const result = await requeueSession(db, { hangar: admitted.client, id: id!, reason: body.reason });
      sendJson(res, 200, { session: await sessionJson(db, result.session) });
    },

    "GET /hangar/v1/sessions": async ({ res, admitted, query }) => {
      const given = query.getAll("state");
      for (const state of given) {
        if (!(HANGAR_SESSION_STATES as readonly string[]).includes(state)) throw invalidRequest(`state: must be one of ${HANGAR_SESSION_STATES.join(", ")}`);
      }
      const limit = intParam(query, "limit", 1, MAX_HANGAR_SESSIONS_LIMIT, DEFAULT_HANGAR_SESSIONS_LIMIT);
      const listed = await listSessions(db, { claimedBy: admitted.client, states: given.length === 0 ? DEFAULT_LISTED_STATES : given, limit });
      sendJson(res, 200, { sessions: await sessionsJson(db, listed.sessions), truncated: listed.truncated });
    },

    "GET /hangar/v1/messages": async ({ res, admitted, query, signal }) => {
      // Always the token's own session (module header); a `session` parameter is ignored.
      const sessionId = admitted.sessionId!;
      const after = intParam(query, "after", 0, Number.MAX_SAFE_INTEGER, 0);
      const waitS = intParam(query, "wait_s", 0, MAX_HANGAR_WAIT_S, 0);
      const read = await asWaiter(admitted.client, waitS, () =>
        longPoll<ReadHangarMessagesResult>(waitS, signal, async () => {
          const page = await readHangarMessages(db, { sessionId, after });
          return page.messages.length === 0 ? null : page;
        }),
      );
      const page = read ?? { messages: [], cursor: after };
      sendJson(res, 200, {
        messages: page.messages.map((m) => ({ id: m.id, kind: m.kind, body: m.body, created_at: m.createdAt.toISOString() })),
        cursor: page.cursor,
      });
    },
  };

  return async (req, res, admitted) => {
    const method = (req.method ?? "GET").toUpperCase();
    const { path, query } = splitUrl(req.url);

    const disconnected = new AbortController();
    res.once("close", () => disconnected.abort());
    const signal = shutdownSignal === undefined ? disconnected.signal : AbortSignal.any([disconnected.signal, shutdownSignal]);

    try {
      const matches = HANGAR_ENDPOINTS.flatMap((endpoint) => {
        const matched = matchPath(endpoint.path, path);
        return matched === null ? [] : [{ endpoint, id: matched.id }];
      });
      if (matches.length === 0) throw new ApiError(404, "not_found", "No hangar endpoint has this path (docs/hangar-api.md lists them).");
      const id = matches[0]!.id;
      if (id !== undefined && !UUID_RE.test(id)) throw new ApiError(404, "not_found", "No session has this id: a session id is a uuid.");
      const hit = matches.find((m) => m.endpoint.method === method);
      if (hit === undefined) {
        const allow = [...new Set(matches.map((m) => m.endpoint.method))].join(", ");
        throw new ApiError(405, "method_not_allowed", `This path takes ${allow}.`, { Allow: allow });
      }

      const { endpoint } = hit;
      if (admitted === null) {
        throw new ApiError(
          403,
          "forbidden",
          "Requests over loopback are treated as the local person; reach this API through the tailnet host or a proxy that sets X-Forwarded-For (docs/hangar-api.md).",
        );
      }
      if (admitted.scope !== endpoint.scope) {
        const scope = admitted.scope;
        throw new ApiError(403, "forbidden", `${/^[aeiou]/.test(scope) ? "An" : "A"} ${scope} token cannot call ${endpoint.method} ${endpoint.path}; it takes a ${endpoint.scope} token.`);
      }
      if (endpoint.scope === "agent" && admitted.sessionId === null) {
        throw new ApiError(403, "forbidden", `Only a session token (returned by a claim) can call ${endpoint.method} ${endpoint.path}.`);
      }
      if (readOnly && method !== "GET") throw new ApiError(403, "read_only", "The server is read-only (BRAIN_READ_ONLY); hangar writes are refused.");

      await handlers[`${endpoint.method} ${endpoint.path}` as EndpointKey]({ req, res, admitted, id: id?.toLowerCase(), query, signal });
    } catch (err) {
      const mapped = mapCoreError(err);
      if (mapped !== null) {
        sendError(res, mapped);
        return;
      }
      // The method and the path only: never a query string, header, or body.
      console.error(`[breakdown-web] hangar ${method} ${path} failed:`, err);
      sendError(res, new ApiError(500, "internal", "Internal error; the server logged it."));
    }
  };
}
