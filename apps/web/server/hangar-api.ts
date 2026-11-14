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
// so a disconnected claimer never takes a session it cannot receive.
//
// Nothing here logs a token, a header, or a query string.

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  claimSession,
  getNodes,
  HANGAR_FLAVORS,
  HANGAR_SESSION_STATES,
  HangarSessionNotClaimedByError,
  HangarSessionNotFoundError,
  HangarTransitionError,
  InvalidHangarSessionError,
  InvalidLookupIdError,
  listSessions,
  MAX_HANGAR_DISK_PATH_LENGTH,
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

export const HANGAR_API_PREFIX = "/hangar/v1/";
/** Every hangar request body is small JSON; anything past this is refused. */
export const MAX_HANGAR_BODY_BYTES = 64 * 1024;
/** How often a long-poll re-runs its query. */
const POLL_INTERVAL_MS = 1000;
/** What `GET /sessions` lists when no `state` is given: what hangar reconciles after a restart. */
const DEFAULT_LISTED_STATES: readonly HangarSessionState[] = ["claimed", "running", "stopped"];

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

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A refusal this handler answers with its own status and error code. */
class HangarApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

const invalidRequest = (message: string): HangarApiError => new HangarApiError(400, "invalid_request", message);

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  // A long-poll whose client left has nobody to answer.
  if (res.destroyed) return;
  res.writeHead(status, { ...JSON_HEADERS, ...headers });
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, err: HangarApiError): void {
  sendJson(res, err.status, { error: { code: err.code, message: err.message } }, err.headers);
}

// --- Request bodies ----------------------------------------------------------------

/** The whole body, or undefined once it passes `limit` bytes (auth-connect.ts's shape). */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = (): void => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > limit) {
        cleanup();
        resolve(undefined);
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

const TOO_LARGE = (): HangarApiError => new HangarApiError(413, "too_large", `The body must be at most ${MAX_HANGAR_BODY_BYTES} bytes.`, { Connection: "close" });

function isJsonContentType(header: string | undefined): boolean {
  if (header === undefined) return false;
  return header.split(";")[0]!.trim().toLowerCase() === "application/json";
}

function formatIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.length === 0 ? "(body)" : issue.path.join(".")}: ${issue.message}`).join("; ");
}

/** The body parsed against `schema`, or a 415, 413, 400 invalid_json, or 400 invalid_request. */
async function readJsonBody<T extends z.ZodType>(req: IncomingMessage, schema: T): Promise<z.infer<T>> {
  if (!isJsonContentType(req.headers["content-type"])) {
    throw new HangarApiError(415, "unsupported_media_type", "Send the body as Content-Type: application/json.");
  }
  const declared = req.headers["content-length"];
  if (declared !== undefined && Number(declared) > MAX_HANGAR_BODY_BYTES) {
    req.resume();
    throw TOO_LARGE();
  }
  const raw = await readBody(req, MAX_HANGAR_BODY_BYTES);
  if (raw === undefined) {
    req.resume();
    throw TOO_LARGE();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    throw new HangarApiError(400, "invalid_json", "The body is not valid UTF-8 JSON.");
  }
  const result = schema.safeParse(parsed);
  if (!result.success) throw invalidRequest(formatIssues(result.error));
  return result.data;
}

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

const updateSchema = z.object({
  state: z.enum(HANGAR_SESSION_STATES).optional(),
  container: z.string().max(MAX_HANGAR_FIELD_LENGTH).nullable().optional(),
  host: z.string().max(MAX_HANGAR_FIELD_LENGTH).nullable().optional(),
  disk_path: z.string().max(MAX_HANGAR_DISK_PATH_LENGTH).nullable().optional(),
});

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
    claimed_by: s.claimedBy,
    claimed_at: s.claimedAt,
    requested_at: s.occurredAt,
  }));
}

async function sessionJson(db: Database, session: HangarSession): Promise<Record<string, unknown>> {
  return (await sessionsJson(db, [session]))[0]!;
}

// --- Long-poll ------------------------------------------------------------------------

/** Resolves after `ms`, or as soon as `signal` aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Runs `attempt` until it returns something, `waitS` seconds pass, or
 * `signal` aborts (module header); null when nothing turned up. An aborted
 * signal stops it before the next attempt, never after.
 */
async function longPoll<T>(waitS: number, signal: AbortSignal, attempt: () => Promise<T | null>): Promise<T | null> {
  const deadline = Date.now() + waitS * 1000;
  for (;;) {
    if (signal.aborted) return null;
    const found = await attempt();
    if (found !== null) return found;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    await pause(Math.min(POLL_INTERVAL_MS, remaining), signal);
  }
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

/** The path's `:id`, or null when `path` does not fit `pattern` segment by segment. */
function matchPath(pattern: string, path: string): { id: string | undefined } | null {
  const want = pattern.split("/");
  const got = path.split("/");
  if (want.length !== got.length) return null;
  let id: string | undefined;
  for (let i = 0; i < want.length; i += 1) {
    if (want[i] === ":id") id = got[i];
    else if (want[i] !== got[i]) return null;
  }
  return { id };
}

function mapCoreError(err: unknown): HangarApiError | null {
  if (err instanceof HangarApiError) return err;
  if (err instanceof HangarTransitionError) return new HangarApiError(409, "invalid_transition", err.message);
  if (err instanceof HangarSessionNotClaimedByError) return new HangarApiError(403, "not_claimer", err.message);
  if (err instanceof HangarSessionNotFoundError) return new HangarApiError(404, "not_found", err.message);
  if (err instanceof InvalidHangarSessionError || err instanceof InvalidLookupIdError) return invalidRequest(err.message);
  return null;
}

export function createHangarHandler({ db, readOnly = false, shutdownSignal, claimAmong }: HangarHandlerOptions): (req: IncomingMessage, res: ServerResponse, admitted: AdmittedClient | null) => Promise<void> {
  const handlers: Record<EndpointKey, EndpointHandler> = {
    "POST /hangar/v1/check-in": async ({ req, res, admitted }) => {
      const body = await readJsonBody(req, checkInSchema);
      const { intervalS } = await recordCheckIn(db, { hangar: admitted.client, version: body.version, capacity: body.capacity ?? null });
      sendJson(res, 200, { interval_s: intervalS, now: new Date().toISOString() });
    },

    "POST /hangar/v1/claim": async ({ req, res, admitted, signal }) => {
      const body = await readJsonBody(req, claimSchema);
      const claimed = await longPoll(body.wait_s, signal, () =>
        claimSession(db, { hangar: admitted.client, flavors: body.flavors, ...(claimAmong === undefined ? {} : { among: claimAmong() }) }),
      );
      if (claimed === null) {
        sendJson(res, 200, { session: null });
        return;
      }
      sendJson(res, 200, { session: await sessionJson(db, claimed.session), token: claimed.token });
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
      const read = await longPoll<ReadHangarMessagesResult>(waitS, signal, async () => {
        const page = await readHangarMessages(db, { sessionId, after });
        return page.messages.length === 0 ? null : page;
      });
      const page = read ?? { messages: [], cursor: after };
      sendJson(res, 200, {
        messages: page.messages.map((m) => ({ id: m.id, kind: m.kind, body: m.body, created_at: m.createdAt.toISOString() })),
        cursor: page.cursor,
      });
    },
  };

  return async (req, res, admitted) => {
    const method = (req.method ?? "GET").toUpperCase();
    const rawUrl = req.url ?? "/";
    const queryAt = rawUrl.indexOf("?");
    const path = queryAt === -1 ? rawUrl : rawUrl.slice(0, queryAt);
    const query = new URLSearchParams(queryAt === -1 ? "" : rawUrl.slice(queryAt + 1));

    const disconnected = new AbortController();
    res.once("close", () => disconnected.abort());
    const signal = shutdownSignal === undefined ? disconnected.signal : AbortSignal.any([disconnected.signal, shutdownSignal]);

    try {
      const matches = HANGAR_ENDPOINTS.flatMap((endpoint) => {
        const matched = matchPath(endpoint.path, path);
        return matched === null ? [] : [{ endpoint, id: matched.id }];
      });
      if (matches.length === 0) throw new HangarApiError(404, "not_found", "No hangar endpoint has this path (docs/hangar-api.md lists them).");
      const id = matches[0]!.id;
      if (id !== undefined && !UUID_RE.test(id)) throw new HangarApiError(404, "not_found", "No session has this id: a session id is a uuid.");
      const hit = matches.find((m) => m.endpoint.method === method);
      if (hit === undefined) {
        const allow = [...new Set(matches.map((m) => m.endpoint.method))].join(", ");
        throw new HangarApiError(405, "method_not_allowed", `This path takes ${allow}.`, { Allow: allow });
      }

      const { endpoint } = hit;
      const scope = admitted?.scope ?? "human";
      if (admitted === null || scope !== endpoint.scope) {
        throw new HangarApiError(403, "forbidden", `${/^[aeiou]/.test(scope) ? "An" : "A"} ${scope} token cannot call ${endpoint.method} ${endpoint.path}; it takes a ${endpoint.scope} token.`);
      }
      if (endpoint.scope === "agent" && admitted.sessionId === null) {
        throw new HangarApiError(403, "forbidden", `Only a session token (returned by a claim) can call ${endpoint.method} ${endpoint.path}.`);
      }
      if (readOnly && method !== "GET") throw new HangarApiError(403, "read_only", "The server is read-only (BRAIN_READ_ONLY); hangar writes are refused.");

      await handlers[`${endpoint.method} ${endpoint.path}` as EndpointKey]({ req, res, admitted, id: id?.toLowerCase(), query, signal });
    } catch (err) {
      const mapped = mapCoreError(err);
      if (mapped !== null) {
        sendError(res, mapped);
        return;
      }
      // The method and the path only: never a query string, header, or body.
      console.error(`[breakdown-web] hangar ${method} ${path} failed:`, err);
      sendError(res, new HangarApiError(500, "internal", "Internal error; the server logged it."));
    }
  };
}
