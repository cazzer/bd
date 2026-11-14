// The hangar queue (hangar-queue change, design decisions 2–4 and 9).
// Hangar is a separate service that runs remote Claude sessions on a
// machine that only connects out; Breakdown is its control plane. A caller
// requests a session for a work item, hangar claims it over HTTP, reports
// its state as it runs, and a worker inside it reads its messages with a
// token bound to the session.
//
// A session is an ordinary node of type `hangar_session` under source system
// `hangar`, keyed on a uuid generated at request time, joined to its work
// item by a `run_by` edge (session → work item). Its metadata obeys the
// contract below, enforced by `normalizeHangarSessionMetadata` on every
// write this module makes. The type is reserved: only these paths write it
// (brain_write refuses it), so no agent can forge a state. Every change goes
// through the ordinary upsert path inside an ingest run (source `hangar`;
// actor the requester or the hangar), so the revision trigger records it.
// Every read here also requires `source_system = 'hangar'`, so a session
// node written any other way is never claimed, updated, or counted.
//
// State machine: queued → claimed → running → stopped, or failed from any
// state but stopped. Only a claim sets claimed, only a requeue (from claimed)
// sets queued again; `checkHangarTransition` decides the rest.
//
// Claiming is one transaction: `FOR UPDATE SKIP LOCKED` on the oldest queued
// session of an admitted flavor, the state change, and the session token
// (client-tokens.ts `createSessionToken`), so racing claims take different
// rows or none. A cheap probe runs first, so a long-poll that finds nothing
// opens no ingest run. Ending a session (stopped, failed) or requeueing it
// revokes its token in the same transaction.
//
// Check-ins (`hangar_check_ins`) and messages (`hangar_messages`) are tables,
// not nodes: liveness and delivery, not knowledge. Status is computed on
// read against the database's `now()`, never hangar's clock. A message
// append takes a per-session advisory lock, so ids commit in order within a
// session and a reader's `id > after` cursor never skips one.
//
// The app makes no model call: all of this is pure Postgres.

import { randomUUID } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import type { Database } from "@breakdown/db";
import { createSessionToken, revokeSessionTokens } from "./client-tokens.js";
import {
  unsafeBuildUpsertEdgesQuery,
  unsafePrepareEdges,
  unsafeWrapEdgeWriteError,
  type UpsertEdgeRow,
} from "./edges.js";
import {
  EdgeUpsertFailedError,
  HangarSessionNotClaimedByError,
  HangarSessionNotFoundError,
  HangarTransitionError,
  InvalidEventTimeError,
  InvalidHangarSessionError,
  InvalidLookupIdError,
  NodeNotFoundError,
  NodeUpsertFailedError,
  NotAWorkItemError,
} from "./errors.js";
import { normalizeOccurredAt, OCCURRED_AT_KEY } from "./event-time.js";
import { fitText } from "./fit-text.js";
import { closeIngestRun, openIngestRun, type IngestRunHandle } from "./ingest-runs.js";
import {
  CONTROL_CHAR_CODE_POINTS,
  DEFAULT_MAX_CONTENT_LENGTH,
  DEFAULT_MAX_METADATA_LENGTH,
  DEFAULT_MAX_TITLE_LENGTH,
  unsafeBuildUpsertNodesQuery,
  unsafePrepareNodes,
  unsafeWrapNodeWriteError,
  type UpsertNodeRow,
} from "./nodes.js";
import { sqlArray, type Tx } from "./sql-helpers.js";
import { WORK_ITEM_NODE_TYPE } from "./work-items.js";

export const HANGAR_SESSION_NODE_TYPE = "hangar_session";
export const HANGAR_SOURCE_SYSTEM = "hangar";
/** session → work item: the work item a session runs for. */
export const RUN_BY_EDGE_TYPE = "run_by";
export const HANGAR_FLAVORS = ["headless", "display-godot", "display-browser"] as const;
export type HangarFlavor = (typeof HANGAR_FLAVORS)[number];
export const HANGAR_SESSION_STATES = ["queued", "claimed", "running", "stopped", "failed"] as const;
export type HangarSessionState = (typeof HANGAR_SESSION_STATES)[number];
/** The check-in interval hangar is told to use; the offline threshold is three of these. */
export const HANGAR_CHECK_IN_INTERVAL_S = 30;
/** The longest a claim or a message read may long-poll (enforced by the HTTP handler). */
export const MAX_HANGAR_WAIT_S = 30;
/** The most messages one read returns, and its default. */
export const MAX_HANGAR_MESSAGES = 50;
export const DEFAULT_HANGAR_SESSIONS_LIMIT = 50;
export const MAX_HANGAR_SESSIONS_LIMIT = 200;
export const MAX_HANGAR_NAME_LENGTH = 200;
export const MAX_HANGAR_REPO_LENGTH = 200;
export const MAX_HANGAR_FIELD_LENGTH = 200;
export const MAX_HANGAR_DISK_PATH_LENGTH = 1024;
export const MAX_HANGAR_REQUEUE_REASON_LENGTH = 500;
export const MAX_HANGAR_MESSAGE_KIND_LENGTH = 64;
/** Serialized size caps for the opaque JSON hangar and the inbox send. */
export const MAX_HANGAR_CAPACITY_CHARS = 10_000;
export const MAX_HANGAR_MESSAGE_BODY_CHARS = 50_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const KEY = {
  state: "state",
  flavor: "flavor",
  repo: "repo",
  requestedBy: "requested_by",
  claimedBy: "claimed_by",
  claimedAt: "claimed_at",
  container: "container",
  host: "host",
  diskPath: "disk_path",
  requeueReason: "requeue_reason",
} as const;

/** Optional text fields and their caps; empty or null deletes the key. */
const OPTIONAL_TEXT: readonly [string, number][] = [
  [KEY.requestedBy, MAX_HANGAR_FIELD_LENGTH],
  [KEY.claimedBy, MAX_HANGAR_FIELD_LENGTH],
  [KEY.container, MAX_HANGAR_FIELD_LENGTH],
  [KEY.host, MAX_HANGAR_FIELD_LENGTH],
  [KEY.diskPath, MAX_HANGAR_DISK_PATH_LENGTH],
  [KEY.requeueReason, MAX_HANGAR_REQUEUE_REASON_LENGTH],
];

// --- The metadata contract (pure) --------------------------------------------

function hasControlChar(value: string): boolean {
  for (const char of value) if (CONTROL_CHAR_CODE_POINTS.has(char.codePointAt(0) as number)) return true;
  return false;
}

/**
 * A trimmed text value, or undefined when it is absent, null, or empty (the
 * caller deletes the key). Refuses a non-string, a control character, or a
 * value over `max` characters.
 */
function optionalText(field: string, value: unknown, max: number, itemLabel?: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new InvalidHangarSessionError(field, value, "must be a string", itemLabel);
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  if (trimmed.length > max) throw new InvalidHangarSessionError(field, `${trimmed.slice(0, 40)}…`, `must be at most ${max} characters`, itemLabel);
  if (hasControlChar(trimmed)) throw new InvalidHangarSessionError(field, trimmed, "must not contain control characters", itemLabel);
  return trimmed;
}

function requiredText(field: string, value: unknown, max: number, itemLabel?: string): string {
  const text = optionalText(field, value, max, itemLabel);
  if (text === undefined) throw new InvalidHangarSessionError(field, value, "is required", itemLabel);
  return text;
}

function oneOf<T extends string>(field: string, value: unknown, allowed: readonly T[], itemLabel?: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new InvalidHangarSessionError(field, value, `must be one of ${allowed.join(", ")}`, itemLabel);
  }
  return value as T;
}

/** `claimed_at` under the event-time rules (event-time.ts), or undefined to delete it. */
function optionalInstant(field: string, value: unknown, itemLabel?: string): string | undefined {
  if (value === "") return undefined;
  try {
    return normalizeOccurredAt({ [OCCURRED_AT_KEY]: value })[OCCURRED_AT_KEY] as string | undefined;
  } catch (err) {
    if (!(err instanceof InvalidEventTimeError)) throw err;
    throw new InvalidHangarSessionError(field, value, "must be an ISO-8601 instant with a zone, a date alone, or a Date", itemLabel);
  }
}

export interface NormalizeHangarSessionOptions {
  /** How errors name the item, e.g. `at batch index 2`. */
  itemLabel?: string;
}

/**
 * Applies the hangar session contract to a session's metadata. Pure;
 * returns a copy. `state` and `flavor` must be known values and `repo` a
 * non-empty string; the other text fields are trimmed, capped, and free of
 * control characters, and an empty or null one deletes its key; `claimed_at`
 * and `occurred_at` follow the event-time rules. Unknown keys pass through.
 * Throws `InvalidHangarSessionError` (or `InvalidEventTimeError` for
 * `occurred_at`).
 */
export function normalizeHangarSessionMetadata(raw: unknown, options: NormalizeHangarSessionOptions = {}): Record<string, unknown> {
  const { itemLabel } = options;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new InvalidHangarSessionError("metadata", raw, "must be an object", itemLabel);
  }
  const out = normalizeOccurredAt(raw as Record<string, unknown>, itemLabel === undefined ? {} : { itemLabel });
  out[KEY.state] = oneOf(KEY.state, out[KEY.state], HANGAR_SESSION_STATES, itemLabel);
  out[KEY.flavor] = oneOf(KEY.flavor, out[KEY.flavor], HANGAR_FLAVORS, itemLabel);
  out[KEY.repo] = requiredText(KEY.repo, out[KEY.repo], MAX_HANGAR_REPO_LENGTH, itemLabel);
  for (const [key, max] of OPTIONAL_TEXT) {
    const text = optionalText(key, out[key], max, itemLabel);
    if (text === undefined) delete out[key];
    else out[key] = text;
  }
  const claimedAt = optionalInstant(KEY.claimedAt, out[KEY.claimedAt], itemLabel);
  if (claimedAt === undefined) delete out[KEY.claimedAt];
  else out[KEY.claimedAt] = claimedAt;
  return out;
}

const RANK: Record<HangarSessionState, number> = { queued: 0, claimed: 1, running: 2, stopped: 3, failed: 4 };

/**
 * Throws `HangarTransitionError` unless a session in `from` may be reported
 * in `to`: the same state (a field update), `failed` from anything but
 * `stopped` or `failed`, or a forward move to `running` or `stopped`. Only a
 * claim moves a session to `claimed` and only a requeue back to `queued`, so
 * neither is a reportable target. Pure.
 */
export function checkHangarTransition(from: HangarSessionState, to: HangarSessionState): void {
  if (from === to) return;
  if (to === "failed") {
    if (from === "stopped") throw new HangarTransitionError(from, to);
    return;
  }
  if (to === "queued" || to === "claimed" || RANK[to] <= RANK[from]) throw new HangarTransitionError(from, to);
}

// --- Reads shared by every path -----------------------------------------------

export interface HangarSession {
  id: string;
  externalId: string;
  sourceSystem: string;
  title: string;
  /** The work item its `run_by` edge names, folded through merges; null if the edge is gone. */
  workItemId: string | null;
  state: HangarSessionState;
  flavor: HangarFlavor;
  repo: string;
  requestedBy: string | null;
  claimedBy: string | null;
  claimedAt: string | null;
  container: string | null;
  host: string | null;
  diskPath: string | null;
  requeueReason: string | null;
  /** When it was requested; claims take the oldest first. */
  occurredAt: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface SessionRow extends Record<string, unknown> {
  id: string;
  external_id: string;
  source_system: string;
  title: string;
  metadata: Record<string, unknown>;
  created_at: string | Date;
  updated_at: string | Date;
  work_item_id: string | null;
}

/** Canonical sessions written by this module. */
const IS_SESSION = sql`s.node_type = ${HANGAR_SESSION_NODE_TYPE} AND s.source_system = ${HANGAR_SOURCE_SYSTEM} AND s.merged_into IS NULL`;

/**
 * Sessions matching `where`, each with its `run_by` work item. Edges are
 * found from the session and from anything merged into it, and the work
 * item endpoint folds through `merged_into`; the heaviest, then oldest, edge
 * wins if there are several.
 */
function selectSessions(where: SQL, tail: SQL = sql``): SQL {
  return sql`
    SELECT s.id, s.external_id, s.source_system, s.title, s.metadata, s.created_at, s.updated_at, r.work_item_id
    FROM nodes s
    LEFT JOIN LATERAL (
      SELECT COALESCE(w.merged_into, w.id) AS work_item_id
      FROM edges e JOIN nodes w ON w.id = e.dst_id
      WHERE e.edge_type = ${RUN_BY_EDGE_TYPE}
        AND e.src_id IN (SELECT s.id UNION ALL SELECT m.id FROM nodes m WHERE m.merged_into = s.id)
      ORDER BY e.weight DESC, e.created_at, e.id
      LIMIT 1
    ) r ON true
    WHERE ${IS_SESSION} AND ${where}
    ${tail}
  `;
}

function text(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === "string" ? value : null;
}

function toSession(row: SessionRow): HangarSession {
  const m = row.metadata;
  return {
    id: row.id,
    externalId: row.external_id,
    sourceSystem: row.source_system,
    title: row.title,
    workItemId: row.work_item_id,
    state: m[KEY.state] as HangarSessionState,
    flavor: m[KEY.flavor] as HangarFlavor,
    repo: text(m, KEY.repo) ?? "",
    requestedBy: text(m, KEY.requestedBy),
    claimedBy: text(m, KEY.claimedBy),
    claimedAt: text(m, KEY.claimedAt),
    container: text(m, KEY.container),
    host: text(m, KEY.host),
    diskPath: text(m, KEY.diskPath),
    requeueReason: text(m, KEY.requeueReason),
    occurredAt: text(m, OCCURRED_AT_KEY),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

async function loadSession(tx: Tx, id: string): Promise<HangarSession> {
  const result = await tx.execute<SessionRow>(selectSessions(sql`s.id = ${id}::uuid`));
  const row = result.rows[0];
  if (!row) throw new HangarSessionNotFoundError(id);
  return toSession(row);
}

interface LockedSessionRow extends Record<string, unknown> {
  id: string;
  node_type: string;
  source_system: string;
  external_id: string;
  title: string;
  content: string;
  metadata: Record<string, unknown>;
  now: string | Date;
}

/** Writes one session node's new metadata through the upsert path, in `tx`, under `run`. */
async function writeSessionNode(tx: Tx, run: IngestRunHandle, node: { externalId: string; title: string; content: string; metadata: Record<string, unknown> }, what: string): Promise<UpsertNodeRow> {
  const prepared = unsafePrepareNodes(
    [{ nodeType: HANGAR_SESSION_NODE_TYPE, sourceSystem: HANGAR_SOURCE_SYSTEM, externalId: node.externalId, title: node.title, content: node.content, metadata: node.metadata }],
    DEFAULT_MAX_CONTENT_LENGTH,
    DEFAULT_MAX_METADATA_LENGTH,
    DEFAULT_MAX_TITLE_LENGTH,
  );
  let written: { rows: UpsertNodeRow[] };
  try {
    written = await tx.execute<UpsertNodeRow>(unsafeBuildUpsertNodesQuery(prepared, run.id));
  } catch (err) {
    throw unsafeWrapNodeWriteError(err, prepared);
  }
  const row = written.rows[0];
  if (!row) throw new NodeUpsertFailedError(`${what}: upsert returned no row for hangar session ${node.externalId}`, 0, 0);
  return row;
}

function assertUuid(value: unknown, label: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!UUID_RE.test(trimmed)) throw new InvalidLookupIdError(value, "must be a valid uuid", label);
  return trimmed.toLowerCase();
}

function hangarName(value: unknown): string {
  return requiredText("hangar", value, MAX_HANGAR_NAME_LENGTH);
}

/** An actor recorded as `requested_by`: control characters dropped, cut to the cap, trimmed. */
function requesterOf(actor: string | undefined): string | undefined {
  if (actor === undefined) return undefined;
  let kept = "";
  for (const char of actor) if (!CONTROL_CHAR_CODE_POINTS.has(char.codePointAt(0) as number)) kept += char;
  return (fitText(kept, MAX_HANGAR_FIELD_LENGTH) as string).trim() || undefined;
}

// --- Requesting -----------------------------------------------------------------

export interface RequestSessionInput {
  repo: string;
  workItemId: string;
  flavor: string;
  /** Who asked (the MCP client); recorded as the run's actor and `requested_by`. */
  actor?: string;
}

export interface RequestSessionResult {
  session: HangarSession;
  status: HangarStatus;
}

/**
 * Queues a session for `workItemId` (folded through merges; it must be a
 * work item), whether or not hangar is online: the session node and its
 * `run_by` edge in one transaction under a `hangar` run. Returns the session
 * and hangar's current status. Validation and the work item lookup run
 * before the run opens.
 */
export async function requestSession(db: Database, input: RequestSessionInput): Promise<RequestSessionResult> {
  const requestedId = assertUuid(input.workItemId, "work item id");
  const requestedBy = requesterOf(input.actor);
  const draft = normalizeHangarSessionMetadata({
    [KEY.state]: "queued",
    [KEY.flavor]: input.flavor,
    [KEY.repo]: input.repo,
    ...(requestedBy === undefined ? {} : { [KEY.requestedBy]: requestedBy }),
    [OCCURRED_AT_KEY]: new Date(),
  });

  const target = await db.execute<{ id: string; node_type: string; title: string }>(sql`
    SELECT id, node_type, title FROM nodes
    WHERE id = (SELECT COALESCE(merged_into, id) FROM nodes WHERE id = ${requestedId}::uuid)
  `);
  const workItem = target.rows[0];
  if (!workItem) throw new NodeNotFoundError(requestedId);
  if (workItem.node_type !== WORK_ITEM_NODE_TYPE) throw new NotAWorkItemError(workItem.id, workItem.node_type);

  const externalId = randomUUID();
  const title = fitText(`Hangar ${draft[KEY.flavor] as string} session: ${workItem.title}`, DEFAULT_MAX_TITLE_LENGTH) as string;

  const run = await openIngestRun(db, HANGAR_SOURCE_SYSTEM, requestedBy === undefined ? {} : { actor: requestedBy });
  let session: HangarSession;
  try {
    session = await db.transaction(async (tx) => {
      const node = await writeSessionNode(tx, run, { externalId, title, content: "", metadata: draft }, "requestSession");
      const preparedEdges = unsafePrepareEdges([{ srcId: node.id, dstId: workItem.id, edgeType: RUN_BY_EDGE_TYPE, sourceSystem: HANGAR_SOURCE_SYSTEM }]);
      let edge: { rows: UpsertEdgeRow[] };
      try {
        edge = await tx.execute<UpsertEdgeRow>(unsafeBuildUpsertEdgesQuery(preparedEdges, run.id));
      } catch (err) {
        throw unsafeWrapEdgeWriteError(err, preparedEdges);
      }
      if (!edge.rows[0]) throw new EdgeUpsertFailedError(`requestSession: run_by edge upsert returned no row for session ${node.id}`, 0, 0);
      return loadSession(tx, node.id);
    });
  } finally {
    await closeIngestRun(db, run);
  }
  return { session, status: await getHangarStatus(db) };
}

// --- Claiming --------------------------------------------------------------------

export interface ClaimSessionInput {
  /** The claiming hangar's name (its token client). */
  hangar: string;
  /** The flavors it can admit now; at least one. */
  flavors: readonly string[];
  /**
   * Restricts the claim to these session ids. A test seam: a suite sharing a
   * database with live data claims only its own fixtures this way.
   */
  among?: readonly string[];
}

export interface ClaimedSession {
  session: HangarSession;
  /** The session token, shown once; only its hash is stored. */
  token: string;
}

/**
 * Takes the oldest queued session whose flavor is among `flavors` (module
 * header), or returns null when there is none or a racing claim took it.
 * Counts as the hangar's check-in either way. The claimed session's
 * `requeue_reason` is dropped; its `occurred_at` is kept.
 */
export async function claimSession(db: Database, input: ClaimSessionInput): Promise<ClaimedSession | null> {
  const hangar = hangarName(input.hangar);
  if (!Array.isArray(input.flavors) || input.flavors.length === 0) {
    throw new InvalidHangarSessionError("flavors", input.flavors, `must list at least one of ${HANGAR_FLAVORS.join(", ")}`);
  }
  const flavors = [...new Set(input.flavors.map((f) => oneOf("flavors", f, HANGAR_FLAVORS)))];
  const among = input.among?.map((id) => assertUuid(id, "session id"));

  const predicate = sql`${IS_SESSION}
    AND s.metadata @> ${JSON.stringify({ [KEY.state]: "queued" })}::jsonb
    AND s.metadata->>${KEY.flavor} = ANY(${sqlArray(flavors, "text")})
    ${among === undefined ? sql`` : sql`AND s.id = ANY(${sqlArray(among, "uuid")})`}`;

  await touchCheckIn(db, hangar);
  const probe = await db.execute(sql`SELECT 1 FROM nodes s WHERE ${predicate} LIMIT 1`);
  if (probe.rows.length === 0) return null;

  const run = await openIngestRun(db, HANGAR_SOURCE_SYSTEM, { actor: hangar });
  try {
    return await db.transaction(async (tx) => {
      const locked = await tx.execute<LockedSessionRow>(sql`
        SELECT s.id, s.node_type, s.source_system, s.external_id, s.title, s.content, s.metadata, now() AS now
        FROM nodes s
        WHERE ${predicate}
        ORDER BY s.metadata->>${OCCURRED_AT_KEY}, s.id
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `);
      const row = locked.rows[0];
      if (!row) return null;

      const { [KEY.requeueReason]: _reason, ...rest } = row.metadata;
      const metadata = normalizeHangarSessionMetadata({ ...rest, [KEY.state]: "claimed", [KEY.claimedBy]: hangar, [KEY.claimedAt]: new Date(row.now) });
      await writeSessionNode(tx, run, { externalId: row.external_id, title: row.title, content: row.content, metadata }, "claimSession");
      const minted = await createSessionToken(tx, row.id);
      return { session: await loadSession(tx, row.id), token: minted.token };
    });
  } finally {
    await closeIngestRun(db, run);
  }
}

// --- Reporting state ----------------------------------------------------------------

export interface UpdateSessionInput {
  hangar: string;
  id: string;
  state?: string;
  /** undefined leaves a field as it is; null or "" clears it. */
  container?: string | null;
  host?: string | null;
  diskPath?: string | null;
}

export interface SessionWriteResult {
  session: HangarSession;
  /** Session tokens this write revoked (stopped, failed, requeued). */
  revokedTokens: number;
}

/**
 * Locks session `id` and runs `change` on its current metadata, in one
 * transaction under a run whose actor is `hangar`. Refuses a node that is not
 * a session (`HangarSessionNotFoundError`) or one `hangar` did not claim
 * (`HangarSessionNotClaimedByError`). `change` returns the new metadata and
 * whether the session's tokens die with this write.
 */
async function changeClaimedSession(
  db: Database,
  hangar: string,
  id: string,
  what: string,
  change: (current: Record<string, unknown>) => { metadata: Record<string, unknown>; revoke: boolean },
): Promise<SessionWriteResult> {
  const run = await openIngestRun(db, HANGAR_SOURCE_SYSTEM, { actor: hangar });
  try {
    return await db.transaction(async (tx) => {
      const locked = await tx.execute<LockedSessionRow>(sql`
        SELECT s.id, s.node_type, s.source_system, s.external_id, s.title, s.content, s.metadata, now() AS now
        FROM nodes s
        WHERE s.id = (SELECT COALESCE(merged_into, id) FROM nodes WHERE id = ${id}::uuid) AND ${IS_SESSION}
        FOR UPDATE
      `);
      const row = locked.rows[0];
      if (!row) throw new HangarSessionNotFoundError(id);
      const current = normalizeHangarSessionMetadata(row.metadata);
      const claimedBy = (current[KEY.claimedBy] as string | undefined) ?? null;
      if (claimedBy !== hangar) throw new HangarSessionNotClaimedByError(row.id, hangar, claimedBy);

      const { metadata, revoke } = change(current);
      await writeSessionNode(tx, run, { externalId: row.external_id, title: row.title, content: row.content, metadata: normalizeHangarSessionMetadata(metadata) }, what);
      const revokedTokens = revoke ? await revokeSessionTokens(tx, row.id) : 0;
      return { session: await loadSession(tx, row.id), revokedTokens };
    });
  } finally {
    await closeIngestRun(db, run);
  }
}

/**
 * The claiming hangar reports a session's state and where it runs. The
 * transition must pass `checkHangarTransition`; `stopped` and `failed`
 * revoke the session token in the same transaction. Each change is a
 * revision of the session node.
 */
export async function updateSession(db: Database, input: UpdateSessionInput): Promise<SessionWriteResult> {
  const hangar = hangarName(input.hangar);
  const id = assertUuid(input.id, "session id");
  const state = input.state === undefined ? undefined : oneOf(KEY.state, input.state, HANGAR_SESSION_STATES);
  const fields: [string, string | null | undefined, number][] = [
    [KEY.container, input.container, MAX_HANGAR_FIELD_LENGTH],
    [KEY.host, input.host, MAX_HANGAR_FIELD_LENGTH],
    [KEY.diskPath, input.diskPath, MAX_HANGAR_DISK_PATH_LENGTH],
  ];
  if (state === undefined && fields.every(([, value]) => value === undefined)) {
    throw new InvalidHangarSessionError("update", {}, "names nothing to change: give a state, container, host, or disk_path");
  }
  for (const [key, value, max] of fields) optionalText(key, value, max);

  return changeClaimedSession(db, hangar, id, "updateSession", (current) => {
    const from = current[KEY.state] as HangarSessionState;
    const to = state ?? from;
    checkHangarTransition(from, to);
    const metadata: Record<string, unknown> = { ...current, [KEY.state]: to };
    for (const [key, value] of fields) {
      if (value === undefined) continue;
      if (value === null) delete metadata[key];
      else metadata[key] = value;
    }
    return { metadata, revoke: to === "stopped" || to === "failed" };
  });
}

export interface RequeueSessionInput {
  hangar: string;
  id: string;
  /** Why hangar could not start it; shown on the session. */
  reason: string;
}

/**
 * Returns a claimed session to the queue with `reason`, when hangar cannot
 * start it: state `queued`, the claim and placement fields cleared,
 * `occurred_at` kept (so it keeps its place in line), and the session token
 * revoked in the same transaction. Only from `claimed`.
 */
export async function requeueSession(db: Database, input: RequeueSessionInput): Promise<SessionWriteResult> {
  const hangar = hangarName(input.hangar);
  const id = assertUuid(input.id, "session id");
  const reason = requiredText(KEY.requeueReason, input.reason, MAX_HANGAR_REQUEUE_REASON_LENGTH);

  return changeClaimedSession(db, hangar, id, "requeueSession", (current) => {
    const from = current[KEY.state] as HangarSessionState;
    if (from !== "claimed") throw new HangarTransitionError(from, "queued");
    const { [KEY.claimedBy]: _by, [KEY.claimedAt]: _at, [KEY.container]: _c, [KEY.host]: _h, [KEY.diskPath]: _d, ...rest } = current;
    return { metadata: { ...rest, [KEY.state]: "queued", [KEY.requeueReason]: reason }, revoke: true };
  });
}

// --- Listing ---------------------------------------------------------------------------

export interface ListSessionsOptions {
  /** Only sessions this hangar claimed. */
  claimedBy?: string;
  states?: readonly string[];
  /** Only sessions run for this work item (folded through merges). */
  workItemId?: string;
  /** Default `DEFAULT_HANGAR_SESSIONS_LIMIT`, at most `MAX_HANGAR_SESSIONS_LIMIT`. */
  limit?: number;
}

export interface ListSessionsResult {
  sessions: HangarSession[];
  /** More sessions matched than `limit`. */
  truncated: boolean;
}

/** Sessions newest-changed first, filtered and bounded. One statement. */
export async function listSessions(db: Database, options: ListSessionsOptions = {}): Promise<ListSessionsResult> {
  const limit = options.limit ?? DEFAULT_HANGAR_SESSIONS_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_HANGAR_SESSIONS_LIMIT) {
    throw new InvalidHangarSessionError("limit", options.limit, `must be an integer from 1 to ${MAX_HANGAR_SESSIONS_LIMIT}`);
  }
  const filters: SQL[] = [sql`true`];
  if (options.claimedBy !== undefined) {
    filters.push(sql`s.metadata @> ${JSON.stringify({ [KEY.claimedBy]: hangarName(options.claimedBy) })}::jsonb`);
  }
  if (options.states !== undefined) {
    const states = options.states.map((s) => oneOf("states", s, HANGAR_SESSION_STATES));
    filters.push(states.length === 0 ? sql`false` : sql`s.metadata->>${KEY.state} = ANY(${sqlArray(states, "text")})`);
  }
  if (options.workItemId !== undefined) {
    const workItemId = assertUuid(options.workItemId, "work item id");
    filters.push(sql`r.work_item_id = (SELECT COALESCE(merged_into, id) FROM nodes WHERE id = ${workItemId}::uuid)`);
  }
  const result = await db.execute<SessionRow>(
    selectSessions(sql.join(filters, sql` AND `), sql`ORDER BY s.updated_at DESC, s.id DESC LIMIT ${limit + 1}`),
  );
  const rows = result.rows.map(toSession);
  return { sessions: rows.slice(0, limit), truncated: rows.length > limit };
}

// --- Check-ins and status --------------------------------------------------------------

/** A claim's check-in: only the time moves. */
async function touchCheckIn(db: Database, hangar: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO hangar_check_ins (hangar) VALUES (${hangar})
    ON CONFLICT (hangar) DO UPDATE SET last_seen_at = now()
  `);
}

export interface RecordCheckInInput {
  hangar: string;
  version?: string | null;
  /** Opaque until bd-d38.5; stored as given. */
  capacity?: Record<string, unknown> | null;
}

/** Records a check-in at the database's `now()`; returns the interval hangar should check in on. */
export async function recordCheckIn(db: Database, input: RecordCheckInInput): Promise<{ intervalS: number }> {
  const hangar = hangarName(input.hangar);
  const version = optionalText("version", input.version, MAX_HANGAR_FIELD_LENGTH) ?? null;
  let capacity: string | null = null;
  if (input.capacity !== undefined && input.capacity !== null) {
    if (typeof input.capacity !== "object" || Array.isArray(input.capacity)) {
      throw new InvalidHangarSessionError("capacity", input.capacity, "must be an object");
    }
    capacity = JSON.stringify(input.capacity);
    if (capacity.length > MAX_HANGAR_CAPACITY_CHARS) {
      throw new InvalidHangarSessionError("capacity", `${capacity.slice(0, 40)}…`, `must serialize to at most ${MAX_HANGAR_CAPACITY_CHARS} characters`);
    }
  }
  const result = await db.execute<{ interval_s: number }>(sql`
    INSERT INTO hangar_check_ins (hangar, last_seen_at, version, capacity)
    VALUES (${hangar}, now(), ${version}, ${capacity}::jsonb)
    ON CONFLICT (hangar) DO UPDATE SET last_seen_at = now(), version = excluded.version, capacity = excluded.capacity
    RETURNING interval_s
  `);
  return { intervalS: Number(result.rows[0]?.interval_s ?? HANGAR_CHECK_IN_INTERVAL_S) };
}

export type HangarLiveness =
  | { state: "online"; lastSeenAt: Date }
  | { state: "offline"; lastSeenAt: Date }
  | { state: "never"; lastSeenAt: null };

/**
 * Online while `now - lastSeenAt` is under three check-in intervals,
 * offline since `lastSeenAt` from then on, never with no check-in. Pure;
 * `now` is the database's.
 */
export function classifyHangarStatus(row: { lastSeenAt: Date; intervalS: number } | null, now: Date): HangarLiveness {
  if (row === null) return { state: "never", lastSeenAt: null };
  const ageMs = now.getTime() - row.lastSeenAt.getTime();
  return ageMs < 3 * row.intervalS * 1000 ? { state: "online", lastSeenAt: row.lastSeenAt } : { state: "offline", lastSeenAt: row.lastSeenAt };
}

export type HangarStatus = HangarLiveness & {
  /** The hangar the status is about: the named one, or the most recent to check in; null when none has. */
  hangar: string | null;
  version: string | null;
  intervalS: number;
  /** The database's clock when the status was read. */
  now: Date;
  /** Open sessions across every hangar. */
  counts: { queued: number; claimed: number; running: number };
};

/** Hangar's status (the named hangar, or the most recent check-in) and the open session counts. One statement. */
export async function getHangarStatus(db: Database, options: { hangar?: string } = {}): Promise<HangarStatus> {
  const hangar = options.hangar === undefined ? undefined : hangarName(options.hangar);
  const result = await db.execute<{
    now: string | Date;
    hangar: string | null;
    last_seen_at: string | Date | null;
    version: string | null;
    interval_s: number | null;
    queued: string | number;
    claimed: string | number;
    running: string | number;
  }>(sql`
    SELECT now() AS now, c.hangar, c.last_seen_at, c.version, c.interval_s, k.queued, k.claimed, k.running
    FROM (SELECT 1) one
    LEFT JOIN LATERAL (
      SELECT hangar, last_seen_at, version, interval_s FROM hangar_check_ins
      ${hangar === undefined ? sql`` : sql`WHERE hangar = ${hangar}`}
      ORDER BY last_seen_at DESC, hangar
      LIMIT 1
    ) c ON true
    CROSS JOIN (
      SELECT count(*) FILTER (WHERE s.metadata->>${KEY.state} = 'queued') AS queued,
             count(*) FILTER (WHERE s.metadata->>${KEY.state} = 'claimed') AS claimed,
             count(*) FILTER (WHERE s.metadata->>${KEY.state} = 'running') AS running
      FROM nodes s WHERE ${IS_SESSION}
    ) k
  `);
  const row = result.rows[0];
  if (!row) throw new Error("getHangarStatus: the status query returned no row");
  const now = new Date(row.now);
  const intervalS = row.interval_s === null ? HANGAR_CHECK_IN_INTERVAL_S : Number(row.interval_s);
  const liveness = classifyHangarStatus(row.last_seen_at === null ? null : { lastSeenAt: new Date(row.last_seen_at), intervalS }, now);
  return {
    ...liveness,
    hangar: row.hangar,
    version: row.version,
    intervalS,
    now,
    counts: { queued: Number(row.queued), claimed: Number(row.claimed), running: Number(row.running) },
  };
}

// --- Messages --------------------------------------------------------------------------------

export interface HangarMessage {
  id: number;
  kind: string;
  body: Record<string, unknown>;
  createdAt: Date;
}

export interface AppendHangarMessageInput {
  sessionId: string;
  kind: string;
  body: Record<string, unknown>;
}

/**
 * Appends a message for a session inside the caller's transaction (an inbox
 * decision appends in the transaction that records it). Takes the session's
 * advisory transaction lock before the id is drawn, so ids commit in order
 * within a session and an `id > after` read never skips one.
 */
export async function appendHangarMessage(tx: Tx, input: AppendHangarMessageInput): Promise<{ id: number; createdAt: Date }> {
  const sessionId = assertUuid(input.sessionId, "session id");
  const kind = requiredText("kind", input.kind, MAX_HANGAR_MESSAGE_KIND_LENGTH);
  if (input.body === null || typeof input.body !== "object" || Array.isArray(input.body)) {
    throw new InvalidHangarSessionError("body", input.body, "must be an object");
  }
  const body = JSON.stringify(input.body);
  if (body.length > MAX_HANGAR_MESSAGE_BODY_CHARS) {
    throw new InvalidHangarSessionError("body", `${body.slice(0, 40)}…`, `must serialize to at most ${MAX_HANGAR_MESSAGE_BODY_CHARS} characters`);
  }
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${sessionId}::uuid::text, 0))`);
  const result = await tx.execute<{ id: string | number; created_at: string | Date }>(sql`
    INSERT INTO hangar_messages (session_id, kind, body) VALUES (${sessionId}::uuid, ${kind}, ${body}::jsonb)
    RETURNING id, created_at
  `);
  const row = result.rows[0];
  if (!row) throw new Error("appendHangarMessage: insert returned no row");
  return { id: Number(row.id), createdAt: new Date(row.created_at) };
}

export interface ReadHangarMessagesInput {
  sessionId: string;
  /** The last id already seen; 0 (the default) reads from the start. */
  after?: number;
  /** Default and maximum `MAX_HANGAR_MESSAGES`. */
  limit?: number;
}

export interface ReadHangarMessagesResult {
  messages: HangarMessage[];
  /** The id to pass as `after` next: the last returned, or `after` when none. */
  cursor: number;
}

/** A session's messages after the cursor, oldest first. */
export async function readHangarMessages(db: Database, input: ReadHangarMessagesInput): Promise<ReadHangarMessagesResult> {
  const sessionId = assertUuid(input.sessionId, "session id");
  const after = input.after ?? 0;
  if (!Number.isSafeInteger(after) || after < 0) throw new InvalidHangarSessionError("after", input.after, "must be a non-negative integer");
  const limit = input.limit ?? MAX_HANGAR_MESSAGES;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_HANGAR_MESSAGES) {
    throw new InvalidHangarSessionError("limit", input.limit, `must be an integer from 1 to ${MAX_HANGAR_MESSAGES}`);
  }
  const result = await db.execute<{ id: string | number; kind: string; body: Record<string, unknown>; created_at: string | Date }>(sql`
    SELECT id, kind, body, created_at FROM hangar_messages
    WHERE session_id = ${sessionId}::uuid AND id > ${after}
    ORDER BY id
    LIMIT ${limit}
  `);
  const messages = result.rows.map((r) => ({ id: Number(r.id), kind: r.kind, body: r.body, createdAt: new Date(r.created_at) }));
  return { messages, cursor: messages.length === 0 ? after : (messages[messages.length - 1] as HangarMessage).id };
}
