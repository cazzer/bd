// The laptop relay's REST API at `/relay/v1/` (laptop-relay decisions 4, 5,
// and 9). A Breakdown without `bd` or `herdr` (the Jetson) queues the work
// those binaries do in `relay_actions` (packages/core relay.ts); the relay
// on the Mac checks in, claims actions by long-poll, runs them, reports
// them, and pushes each beads checkout's ingest here so the board stays
// live. docs/relay.md is the published contract, and relay-contract.test.ts
// keeps it in step with `RELAY_ENDPOINTS`.
//
// The dispatcher (dispatch.ts) admits only `relay` tokens on this route and
// hands over what admission established; every endpoint takes scope
// `relay`. A tokenless loopback request counts as `human` and is refused,
// so a relay is never admitted from the server's own host: it is meant for
// another one. A read-only server answers GETs and refuses every POST.
//
// The request plumbing — body caps, JSON errors, the long-poll loop, the
// per-client waiter cap — is json-api.ts, shared with hangar. Every body is
// at most MAX_RELAY_BODY_BYTES except a beads push, which may be
// MAX_RELAY_PUSH_BYTES. Unknown fields are dropped, not refused.
//
// A claim long-polls like hangar's: once the socket is gone no further
// attempt runs, and a claim that commits as the socket goes is requeued at
// once rather than left claimed for the five-minute reclaim.
//
// A beads push carries the raw `bd` export and review threads, never
// prepared nodes: Breakdown builds every node itself (`applyBeadsIngest`)
// and takes the registry node's path from its own registration, so a leaked
// relay token can only upsert `beads` items for a project already
// registered, and cannot re-point it. The push names the path the relay
// watches, and a path other than the registered one is refused, so a relay
// pointed at the wrong checkout says so. Pushes are serialized per project
// (the guard and the upsert are not one transaction; beads-ingest.ts
// header). The run is attributed to the relay's client, and the outcome is
// reported through the beads watcher's `record`, so open boards get the
// same events a local load sends.
//
// Nothing here logs a token, a header, a query string, or a body.

import { isAbsolute } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  applyBeadsIngest,
  BeadsProjectConflictError,
  claimRelayAction,
  ContentTooLargeError,
  DuplicateEdgeInBatchError,
  DuplicateNodeInBatchError,
  getRegisteredBeadsProject,
  InvalidEdgeInputError,
  InvalidEdgeWeightError,
  InvalidEventTimeError,
  InvalidNodeContentError,
  InvalidNodeInputError,
  InvalidRelayActionError,
  InvalidWorkItemError,
  listBeadsProjects,
  MAX_RELAY_CLAIM_PROJECTS,
  MAX_RELAY_CWD_LENGTH,
  MAX_RELAY_FIELD_LENGTH,
  MAX_RELAY_ISSUE_ID_LENGTH,
  MAX_RELAY_WAIT_S,
  MetadataTooLargeError,
  parseBeadsIssues,
  PROJECT_KEY_PATTERN,
  recordRelayCheckIn,
  RELAY_ACTION_KINDS,
  RELAY_ISSUE_ID_PATTERN,
  RelayActionNotClaimedByError,
  RelayActionNotFoundError,
  reportRelayAction,
  onRelayActionReported,
  requeueRelayAction,
  TitleTooLargeError,
  type ClaimedRelayAction,
  type HostBinary,
  type IngestBeadsCheckoutResult,
} from "@breakdown/core";
import type { Database } from "@breakdown/db";
import { z } from "zod";
import type { BeadsWatcher } from "./beads-watcher.js";
import type { AdmittedClient } from "./context.js";
import { ApiError, createWaiterCap, invalidRequest, longPoll, matchPath, readJsonBody, sendError, sendJson, splitUrl } from "./json-api.js";

export const RELAY_API_PREFIX = "/relay/v1/";
/** Every relay body but a beads push is small JSON; anything past this is refused. */
export const MAX_RELAY_BODY_BYTES = 64 * 1024;
/** A beads push: one project's whole export and review threads. */
export const MAX_RELAY_PUSH_BYTES = 8 * 1024 * 1024;
/** The most issues one push may carry. */
export const MAX_RELAY_PUSH_ISSUES = 20_000;
/** The most comments one review thread in a push may carry. */
export const MAX_RELAY_PUSH_THREAD_COMMENTS = 1000;
/** The most claims with `wait_s` > 0 one relay client may hold open at once. */
export const MAX_CONCURRENT_RELAY_LONG_POLLS = 2;
/** The requeue reason for a claim whose caller left before it could be delivered. */
export const RELAY_CLAIMER_GONE_REASON = "claimer disconnected before receiving the claim";

/** The endpoint table: the router below and docs/relay.md are both checked against it. */
export const RELAY_ENDPOINTS = [
  { method: "POST", path: "/relay/v1/check-in", scope: "relay" },
  { method: "POST", path: "/relay/v1/claim", scope: "relay" },
  { method: "POST", path: "/relay/v1/actions/:id/result", scope: "relay" },
  { method: "POST", path: "/relay/v1/beads-ingest", scope: "relay" },
  { method: "GET", path: "/relay/v1/projects", scope: "relay" },
] as const;

type Endpoint = (typeof RELAY_ENDPOINTS)[number];
type KeyOf<E> = E extends { method: infer M extends string; path: infer P extends string } ? `${M} ${P}` : never;
type EndpointKey = KeyOf<Endpoint>;

/** A relay action id: bigserial, so a positive decimal integer of at most 18 digits (relay.ts takes no other spelling). */
const ACTION_ID_RE = /^[1-9]\d{0,17}$/;

export interface RelayHandlerOptions {
  db: Database;
  /** BRAIN_READ_ONLY: every POST is refused; GETs answer. */
  readOnly?: boolean;
  /** Aborted at shutdown; a long-poll answers empty on it. */
  shutdownSignal?: AbortSignal;
  /** Where a push's outcome is reported, so open boards refresh (beads-watcher.ts `record`). */
  watcher?: Pick<BeadsWatcher, "record">;
  /** The host binaries this server lacks; `GET /projects` says whether the relay must push (`bd` missing). */
  missingBinaries?: readonly HostBinary[];
  /**
   * Restricts claims to these action ids, read on every attempt. A test
   * seam (relay.ts `ClaimRelayActionInput.among`): a suite sharing a
   * database with live data claims only its own fixtures. Never set in production.
   */
  claimAmong?: () => readonly (number | string)[];
}

// --- Request bodies -------------------------------------------------------------------

const checkInSchema = z.object({
  version: z.string().trim().min(1).max(MAX_RELAY_FIELD_LENGTH),
});

/** A claim's body; exported so the contract test checks every field is documented. */
export const claimSchema = z.object({
  kinds: z
    .array(z.enum(RELAY_ACTION_KINDS))
    .min(1)
    .max(RELAY_ACTION_KINDS.length)
    .refine((kinds) => new Set(kinds).size === kinds.length, "must not name a kind twice")
    .optional(),
  projects: z
    .array(z.string().regex(PROJECT_KEY_PATTERN, "must be project keys"))
    .max(MAX_RELAY_CLAIM_PROJECTS)
    .optional(),
  wait_s: z.number().int().min(0).max(MAX_RELAY_WAIT_S).default(0),
});

const resultSchema = z.object({
  state: z.enum(["done", "failed"]),
  result: z.record(z.string(), z.unknown()).nullable().optional(),
  error: z.string().nullable().optional(),
});

const beadId = z.string().max(MAX_RELAY_ISSUE_ID_LENGTH).regex(RELAY_ISSUE_ID_PATTERN, "must be a beads issue id");

const pushSchema = z.object({
  project_key: z.string().regex(PROJECT_KEY_PATTERN, "must be a registered project key"),
  path: z.string().min(1).max(MAX_RELAY_CWD_LENGTH).refine(isAbsolute, "must be an absolute path"),
  issues: z.array(z.looseObject({ id: beadId, title: z.string(), status: z.string() })).min(1).max(MAX_RELAY_PUSH_ISSUES),
  comments: z.record(beadId, z.array(z.unknown()).max(MAX_RELAY_PUSH_THREAD_COMMENTS)),
});

// --- Responses -------------------------------------------------------------------------

function actionJson(action: ClaimedRelayAction): Record<string, unknown> {
  return { id: action.id, kind: action.kind, payload: action.payload, created_at: action.createdAt.toISOString(), attempts: action.attempts };
}

function pushJson(result: IngestBeadsCheckoutResult): Record<string, unknown> {
  return {
    project: result.project,
    nodes: result.nodes,
    edges: result.edges,
    edges_deleted: result.edgesDeleted,
    changed: result.changed,
    changed_node_ids: result.changedNodeIds,
  };
}

// --- The handler ------------------------------------------------------------------------

interface Call {
  req: IncomingMessage;
  res: ServerResponse;
  admitted: AdmittedClient;
  /** The `:id` segment, when the endpoint has one (already a decimal id). */
  id: string | undefined;
  /** Aborted when the client's socket closes or the server shuts down. */
  signal: AbortSignal;
}

type EndpointHandler = (call: Call) => Promise<void>;

/** A write path's refusal of the pushed data itself: the relay sent something the contract does not take. */
const CONTRACT_ERRORS = [
  InvalidWorkItemError,
  InvalidEventTimeError,
  InvalidNodeInputError,
  InvalidNodeContentError,
  TitleTooLargeError,
  ContentTooLargeError,
  MetadataTooLargeError,
  DuplicateNodeInBatchError,
  InvalidEdgeInputError,
  InvalidEdgeWeightError,
  DuplicateEdgeInBatchError,
] as const;

function mapCoreError(err: unknown): ApiError | null {
  if (err instanceof ApiError) return err;
  if (err instanceof RelayActionNotFoundError) return new ApiError(404, "not_found", err.message);
  if (err instanceof RelayActionNotClaimedByError) return new ApiError(409, "not_claimer", err.message);
  if (err instanceof InvalidRelayActionError) return invalidRequest(err.message);
  if (err instanceof BeadsProjectConflictError) return new ApiError(409, "project_conflict", err.message);
  if (CONTRACT_ERRORS.some((type) => err instanceof type)) return invalidRequest((err as Error).message);
  return null;
}

export function createRelayHandler({ db, readOnly = false, shutdownSignal, watcher, missingBinaries = [], claimAmong }: RelayHandlerOptions): (req: IncomingMessage, res: ServerResponse, admitted: AdmittedClient | null) => Promise<void> {
  const asWaiter = createWaiterCap(
    MAX_CONCURRENT_RELAY_LONG_POLLS,
    `This client already holds ${MAX_CONCURRENT_RELAY_LONG_POLLS} claims open; retry once one answers.`,
  );
  /** The tail of each project's push chain (module header); dropped once it settles with nothing behind it. */
  const pushes = new Map<string, Promise<unknown>>();

  function serialized<T>(project: string, run: () => Promise<T>): Promise<T> {
    const result = (pushes.get(project) ?? Promise.resolve()).then(run, run);
    const tail = result.catch(() => {});
    pushes.set(project, tail);
    void tail.then(() => {
      if (pushes.get(project) === tail) pushes.delete(project);
    });
    return result;
  }

  const handlers: Record<EndpointKey, EndpointHandler> = {
    "POST /relay/v1/check-in": async ({ req, res, admitted }) => {
      const body = await readJsonBody(req, checkInSchema, MAX_RELAY_BODY_BYTES);
      const { intervalS, now } = await recordRelayCheckIn(db, { relay: admitted.client, version: body.version });
      sendJson(res, 200, { interval_s: intervalS, now: now.toISOString() });
    },

    "POST /relay/v1/claim": async ({ req, res, admitted, signal }) => {
      const body = await readJsonBody(req, claimSchema, MAX_RELAY_BODY_BYTES);
      const claimed = await asWaiter(admitted.client, body.wait_s, () =>
        longPoll(body.wait_s, signal, () =>
          claimRelayAction(db, {
            relay: admitted.client,
            ...(body.kinds === undefined ? {} : { kinds: body.kinds }),
            ...(body.projects === undefined ? {} : { projects: body.projects }),
            ...(claimAmong === undefined ? {} : { among: claimAmong() }),
          }),
        ),
      );
      if (claimed === null) {
        sendJson(res, 200, { action: null });
        return;
      }
      // Nobody will run this action: give it back rather than leave it claimed until the reclaim (module header).
      if (res.destroyed || res.writableEnded) {
        await requeueRelayAction(db, { relay: admitted.client, id: claimed.id, reason: RELAY_CLAIMER_GONE_REASON });
        return;
      }
      sendJson(res, 200, { action: actionJson(claimed) });
    },

    "POST /relay/v1/actions/:id/result": async ({ req, res, admitted, id }) => {
      const body = await readJsonBody(req, resultSchema, MAX_RELAY_BODY_BYTES);
      const reported = await reportRelayAction(db, {
        relay: admitted.client,
        id: id!,
        state: body.state,
        ...(body.result === undefined ? {} : { result: body.result }),
        ...(body.error === undefined ? {} : { error: body.error }),
      });
      // A hangar escalation's review, or a person's decision on one, goes on to its session
      // (core hangar-escalation.ts). The report is recorded either way. It runs on a repeated
      // report too, from the stored action: the follow-up is idempotent, so a relay retrying a
      // report whose answer was lost (or whose follow-up died with the server) completes it.
      await onRelayActionReported(db, reported.action).catch((err: unknown) => console.error(`[breakdown-web] relay action ${reported.action.id}: hangar follow-up failed:`, err));
      sendJson(res, 200, { action: { id: reported.action.id, state: reported.action.state }, already_finished: reported.alreadyFinished });
    },

    "POST /relay/v1/beads-ingest": async ({ req, res, admitted }) => {
      const body = await readJsonBody(req, pushSchema, MAX_RELAY_PUSH_BYTES);
      const issues = parseBeadsIssues(body.issues);
      const registered = await getRegisteredBeadsProject(db, body.project_key);
      if (registered === null) {
        throw new ApiError(404, "not_registered", `No beads project ${JSON.stringify(body.project_key)} is registered here; register it with a local beads ingest first.`);
      }
      if (registered.path !== body.path) {
        throw new ApiError(409, "path_mismatch", `Project ${JSON.stringify(registered.key)} is registered at ${JSON.stringify(registered.path)}, not ${JSON.stringify(body.path)}.`);
      }
      const project = registered.key;
      const result = await serialized(project, async () => {
        try {
          const applied = await applyBeadsIngest(db, { project, path: registered.path, issues, comments: body.comments, actor: admitted.client });
          watcher?.record(project, { ok: true, changed: applied.changed, nodes: applied.nodes, edges: applied.edges }, applied);
          return applied;
        } catch (err) {
          watcher?.record(project, { ok: false, error: err instanceof Error ? err.message : String(err) }, null);
          throw err;
        }
      });
      sendJson(res, 200, pushJson(result));
    },

    "GET /relay/v1/projects": async ({ res }) => {
      const projects = await listBeadsProjects(db, { registeredByBeads: true });
      sendJson(res, 200, {
        projects: projects.filter((p) => p.key !== "" && p.path !== "").map((p) => ({ key: p.key, path: p.path })),
        push: missingBinaries.includes("bd"),
      });
    },
  };

  return async (req, res, admitted) => {
    const method = (req.method ?? "GET").toUpperCase();
    const { path } = splitUrl(req.url);

    const disconnected = new AbortController();
    res.once("close", () => disconnected.abort());
    const signal = shutdownSignal === undefined ? disconnected.signal : AbortSignal.any([disconnected.signal, shutdownSignal]);

    try {
      const matches = RELAY_ENDPOINTS.flatMap((endpoint) => {
        const matched = matchPath(endpoint.path, path);
        return matched === null ? [] : [{ endpoint, id: matched.id }];
      });
      if (matches.length === 0) throw new ApiError(404, "not_found", "No relay endpoint has this path (docs/relay.md lists them).");
      const id = matches[0]!.id;
      if (id !== undefined && !ACTION_ID_RE.test(id)) throw new ApiError(404, "not_found", "No relay action has this id: an action id is a positive decimal integer.");
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
          "Requests over loopback are treated as the local person; reach this API through the tailnet host or a proxy that sets X-Forwarded-For (docs/relay.md).",
        );
      }
      if (admitted.scope !== endpoint.scope) {
        const scope = admitted.scope;
        throw new ApiError(403, "forbidden", `${/^[aeiou]/.test(scope) ? "An" : "A"} ${scope} token cannot call ${endpoint.method} ${endpoint.path}; it takes a ${endpoint.scope} token.`);
      }
      if (readOnly && method !== "GET") throw new ApiError(403, "read_only", "The server is read-only (BRAIN_READ_ONLY); relay writes are refused.");

      await handlers[`${endpoint.method} ${endpoint.path}` as EndpointKey]({ req, res, admitted, id, signal });
    } catch (err) {
      const mapped = mapCoreError(err);
      if (mapped !== null) {
        sendError(res, mapped);
        return;
      }
      // The method and the path only: never a query string, header, or body.
      console.error(`[breakdown-web] relay ${method} ${path} failed:`, err);
      sendError(res, new ApiError(500, "internal", "Internal error; the server logged it."));
    }
  };
}
