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
// Releasing (hangar-release change; cazzer/hangar docs/release-contract.md):
// an ended session carries an `outcome`, `accepted` or `tabled`, that only a
// person sets (`setHangarSessionOutcome`: the board's human procedure, or a
// person accepting an inbox request an agent filed). Hangar reads it from its
// listing, deletes the session's disk and container, and acknowledges with a
// PATCH that clears `container` and `disk_path`. An outcome with no disk path
// is released: hangar holds nothing more, and the outcome is final. No
// hangar or agent path writes `outcome`; `updateSession` carries it forward.
// On an ended session a PATCH only clears placement fields, never sets them
// (so nothing un-releases a session), and clears a held disk path only once
// an outcome is set (`HangarEndedSessionChangeError`).
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
// Capacity (hangar-capacity change): a check-in's `capacity` is stored as
// hangar sent it, with `capacity_at`, the database's time it arrived; a claim
// moves neither. Reads parse it leniently (`parseHangarCapacity`), field by
// field, so one field this version can't read never hides the rest. Why a
// queued session waits (`explainQueuedSessions`, classified by the pure
// `classifyQueuedWait`) is computed on read from the latest check-ins of
// online hangars and the session registry, and never stored. Breakdown
// never admits by capacity: hangar decides what it claims. Of hangar's
// blocked reasons only the `disk:` prefix is contract (the disk budget is
// full); the rest is shown verbatim and never parsed.
//
// The app makes no model call: all of this is pure Postgres.

import { randomUUID } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import type { Database } from "@breakdown/db";
import { createSessionToken, revokeSessionTokens, sessionTokenClient } from "./client-tokens.js";
import {
  unsafeBuildUpsertEdgesQuery,
  unsafePrepareEdges,
  unsafeWrapEdgeWriteError,
  type UpsertEdgeRow,
} from "./edges.js";
import {
  ClientTokenExistsError,
  ContentTooLargeError,
  EdgeUpsertFailedError,
  HangarEndedSessionChangeError,
  HangarOutcomeRefusedError,
  HangarSessionNotClaimedByError,
  HangarSessionNotFoundError,
  HangarTransitionError,
  InvalidEventTimeError,
  InvalidHangarSessionError,
  InvalidLookupIdError,
  InvalidNodeContentError,
  MetadataTooLargeError,
  NodeNotFoundError,
  NodeUpsertFailedError,
  NotAWorkItemError,
  ReservedHangarEdgeError,
  TitleTooLargeError,
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
/** A person's decision on an ended session (module header); absent means none yet. */
export const HANGAR_OUTCOMES = ["accepted", "tabled"] as const;
export type HangarOutcome = (typeof HANGAR_OUTCOMES)[number];
/** The states a session takes an outcome in. */
export const HANGAR_FINAL_STATES: readonly HangarSessionState[] = ["stopped", "failed"];
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
export const MAX_HANGAR_FAILURE_REASON_LENGTH = 500;
/** How many unclaimable queued sessions one claim attempt marks failed and passes over before it gives up until the next attempt. */
export const MAX_CLAIM_CANDIDATES = 3;
export const MAX_HANGAR_MESSAGE_KIND_LENGTH = 64;
/** Serialized size caps for the capacity JSON hangar sends and the inbox body. */
export const MAX_HANGAR_CAPACITY_CHARS = 10_000;
export const MAX_HANGAR_MESSAGE_BODY_CHARS = 50_000;
/** A blocked reason is cut to this many characters on read, for display. */
export const MAX_HANGAR_BLOCKED_REASON_LENGTH = 500;
/** The most per-session usage entries a parsed capacity keeps. */
export const MAX_HANGAR_USAGE_ENTRIES = 200;
/** The most awaiting-review sessions a disk wait lists (oldest ended first); `total` counts them all. */
export const MAX_HANGAR_AWAITING_REVIEW_LISTED = 20;
/** Why a queued session waits, in order of precedence (`classifyQueuedWait`). */
export const HANGAR_WAIT_KINDS = ["offline", "unknown", "next", "not_offered", "disk_awaiting_review", "capacity"] as const;

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
  failureReason: "failure_reason",
  outcome: "outcome",
  outcomeAt: "outcome_at",
  outcomeBy: "outcome_by",
} as const;

/** Optional text fields and their caps; empty or null deletes the key. */
const OPTIONAL_TEXT: readonly [string, number][] = [
  [KEY.requestedBy, MAX_HANGAR_FIELD_LENGTH],
  [KEY.claimedBy, MAX_HANGAR_FIELD_LENGTH],
  [KEY.container, MAX_HANGAR_FIELD_LENGTH],
  [KEY.host, MAX_HANGAR_FIELD_LENGTH],
  [KEY.diskPath, MAX_HANGAR_DISK_PATH_LENGTH],
  [KEY.requeueReason, MAX_HANGAR_REQUEUE_REASON_LENGTH],
  [KEY.failureReason, MAX_HANGAR_FAILURE_REASON_LENGTH],
  [KEY.outcomeBy, MAX_HANGAR_FIELD_LENGTH],
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

/** `outcome` as one of `HANGAR_OUTCOMES`, or undefined (absent, null, or empty) to delete it. */
function optionalOutcome(value: unknown, itemLabel?: string): HangarOutcome | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return oneOf(KEY.outcome, value, HANGAR_OUTCOMES, itemLabel);
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
 * control characters, and an empty or null one deletes its key; `outcome`,
 * when present, is one of `HANGAR_OUTCOMES`; `claimed_at`, `outcome_at`, and
 * `occurred_at` follow the event-time rules. Unknown keys pass through.
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
  const outcome = optionalOutcome(out[KEY.outcome], itemLabel);
  if (outcome === undefined) delete out[KEY.outcome];
  else out[KEY.outcome] = outcome;
  for (const key of [KEY.claimedAt, KEY.outcomeAt]) {
    const instant = optionalInstant(key, out[key], itemLabel);
    if (instant === undefined) delete out[key];
    else out[key] = instant;
  }
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
  /** Why it failed: a claim could not take it (its stored metadata broke the contract, or its token name was held), or hangar's reason when it reported it failed. */
  failureReason: string | null;
  /** The person's decision on the ended session; null when none (or a stored value this version does not know). */
  outcome: HangarOutcome | null;
  outcomeAt: string | null;
  /** Who set the outcome: the person's actor. */
  outcomeBy: string | null;
  /** An outcome is set and hangar has cleared the disk path: it holds nothing for the session any more. */
  released: boolean;
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
 * Sessions matching `where`, each with its `run_by` work item. Only `run_by`
 * edges under source system `hangar` count — the one `requestSession`
 * writes; brain_link refuses that source system and any edge out of a
 * session (`assertNoReservedHangarEdges`), so no agent can repoint a session
 * at other work. Edges are found from the session and from anything merged
 * into it, and the work item endpoint folds through `merged_into`; the
 * heaviest, then oldest, edge wins if there are several.
 */
function selectSessions(where: SQL, tail: SQL = sql``): SQL {
  return sql`
    SELECT s.id, s.external_id, s.source_system, s.title, s.metadata, s.created_at, s.updated_at, r.work_item_id
    FROM nodes s
    LEFT JOIN LATERAL (
      SELECT COALESCE(w.merged_into, w.id) AS work_item_id
      FROM edges e JOIN nodes w ON w.id = e.dst_id
      WHERE e.edge_type = ${RUN_BY_EDGE_TYPE}
        AND e.source_system = ${HANGAR_SOURCE_SYSTEM}
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
  const stored = text(m, KEY.outcome);
  const outcome = (HANGAR_OUTCOMES as readonly string[]).includes(stored ?? "") ? (stored as HangarOutcome) : null;
  const diskPath = text(m, KEY.diskPath);
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
    diskPath,
    requeueReason: text(m, KEY.requeueReason),
    failureReason: text(m, KEY.failureReason),
    outcome,
    outcomeAt: text(m, KEY.outcomeAt),
    outcomeBy: text(m, KEY.outcomeBy),
    released: outcome !== null && diskPath === null,
    occurredAt: text(m, OCCURRED_AT_KEY),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

async function loadSession(tx: Database | Tx, id: string): Promise<HangarSession> {
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

/** Session `id` (folded through merges), with the database's `now()`; locked `FOR UPDATE` when `lock`. Empty when it is not a session. */
function readSessionRow(tx: Database | Tx, id: string, lock: boolean): Promise<{ rows: LockedSessionRow[] }> {
  return tx.execute<LockedSessionRow>(sql`
    SELECT s.id, s.node_type, s.source_system, s.external_id, s.title, s.content, s.metadata, now() AS now
    FROM nodes s
    WHERE s.id = (SELECT COALESCE(merged_into, id) FROM nodes WHERE id = ${id}::uuid) AND ${IS_SESSION}
    ${lock ? sql`FOR UPDATE` : sql``}
  `);
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

/** Free text made to fit a contract field: control characters dropped, cut to `max`, trimmed. */
function fitField(value: string, max: number): string {
  let kept = "";
  for (const char of value) if (!CONTROL_CHAR_CODE_POINTS.has(char.codePointAt(0) as number)) kept += char;
  return (fitText(kept, max) as string).trim();
}

/** An actor recorded as `requested_by`. */
function requesterOf(actor: string | undefined): string | undefined {
  if (actor === undefined) return undefined;
  return fitField(actor, MAX_HANGAR_FIELD_LENGTH) || undefined;
}

// --- Reserved edges ---------------------------------------------------------------

/**
 * Refuses, for a generic edge writer (brain_link), every edge only this
 * module writes: any under source system `hangar`, and any whose source is
 * a hangar session (node_type `hangar_session` or source system `hangar`),
 * since a session's out-edges are its `run_by` link to the work it runs for.
 * One statement for the batch's sources; throws `ReservedHangarEdgeError`
 * naming the first offending edge. An edge *into* a session is allowed.
 */
export async function assertNoReservedHangarEdges(db: Database, edges: readonly { srcId: string; sourceSystem: string }[]): Promise<void> {
  edges.forEach((edge, index) => {
    if (edge.sourceSystem.trim() === HANGAR_SOURCE_SYSTEM) {
      throw new ReservedHangarEdgeError(`at batch index ${index}`, `source system "${HANGAR_SOURCE_SYSTEM}" is written only by the hangar queue`);
    }
  });
  const srcIds = [...new Set(edges.map((e) => e.srcId.trim().toLowerCase()).filter((id) => UUID_RE.test(id)))];
  if (srcIds.length === 0) return;
  const sessions = await db.execute<{ id: string }>(sql`
    SELECT id FROM nodes
    WHERE id = ANY(${sqlArray(srcIds, "uuid")})
      AND (node_type = ${HANGAR_SESSION_NODE_TYPE} OR source_system = ${HANGAR_SOURCE_SYSTEM})
  `);
  if (sessions.rows.length === 0) return;
  const reserved = new Set(sessions.rows.map((r) => r.id));
  const index = edges.findIndex((e) => reserved.has(e.srcId.trim().toLowerCase()));
  throw new ReservedHangarEdgeError(`at batch index ${index} (from ${edges[index]!.srcId})`, "its source is a hangar session, whose edges only the hangar queue writes");
}

// --- Requesting -----------------------------------------------------------------

export interface RequestSessionInput {
  repo: string;
  workItemId: string;
  flavor: string;
  /** Who asked (the MCP client); recorded as the run's actor and `requested_by`. */
  actor?: string;
  /**
   * Overrides `requested_at` (the database's `now()` otherwise). A test seam:
   * a suite sharing a database with a live hangar queues its fixtures far in
   * the future, so an oldest-first claim reaches them last. Never set in
   * production.
   */
  requestedAt?: Date;
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
 * before the run opens; `requested_at` is the database's `now()` at that
 * lookup.
 */
export async function requestSession(db: Database, input: RequestSessionInput): Promise<RequestSessionResult> {
  const requestedId = assertUuid(input.workItemId, "work item id");
  const requestedBy = requesterOf(input.actor);
  const validated = normalizeHangarSessionMetadata({
    [KEY.state]: "queued",
    [KEY.flavor]: input.flavor,
    [KEY.repo]: input.repo,
    ...(requestedBy === undefined ? {} : { [KEY.requestedBy]: requestedBy }),
  });

  const target = await db.execute<{ id: string; node_type: string; title: string; now: string | Date }>(sql`
    SELECT id, node_type, title, now() AS now FROM nodes
    WHERE id = (SELECT COALESCE(merged_into, id) FROM nodes WHERE id = ${requestedId}::uuid)
  `);
  const workItem = target.rows[0];
  if (!workItem) throw new NodeNotFoundError(requestedId);
  if (workItem.node_type !== WORK_ITEM_NODE_TYPE) throw new NotAWorkItemError(workItem.id, workItem.node_type);
  const draft = normalizeHangarSessionMetadata({ ...validated, [OCCURRED_AT_KEY]: input.requestedAt ?? new Date(workItem.now) });

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
 *
 * A locked session that cannot be claimed — its stored metadata breaks the
 * contract, or a live token already holds its `session-<id>` client name —
 * is marked `failed` with a `failure_reason` (its tokens revoked), and the
 * claim moves on to the next candidate in the same transaction, up to
 * `MAX_CLAIM_CANDIDATES` rows, rather than failing every claim on the row at
 * the head of the queue.
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
      for (let candidate = 0; candidate < MAX_CLAIM_CANDIDATES; candidate += 1) {
        // A row this transaction marked failed no longer matches `queued`.
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

        let metadata: Record<string, unknown>;
        try {
          const { [KEY.requeueReason]: _reason, ...rest } = row.metadata;
          metadata = normalizeHangarSessionMetadata({ ...rest, [KEY.state]: "claimed", [KEY.claimedBy]: hangar, [KEY.claimedAt]: new Date(row.now) });
        } catch (err) {
          if (!(err instanceof InvalidHangarSessionError || err instanceof InvalidEventTimeError)) throw err;
          await failUnclaimable(tx, run, row, `could not be claimed: its stored metadata breaks the session contract (${err.message})`);
          continue;
        }
        // The claim writes the row back whole, so one past the node write's
        // own limits (oversized metadata, title, or content) can never be
        // claimed. Checked before the savepoint, like the contract.
        try {
          unsafePrepareNodes(
            [{ nodeType: HANGAR_SESSION_NODE_TYPE, sourceSystem: HANGAR_SOURCE_SYSTEM, externalId: row.external_id, title: row.title, content: row.content, metadata }],
            DEFAULT_MAX_CONTENT_LENGTH,
            DEFAULT_MAX_METADATA_LENGTH,
            DEFAULT_MAX_TITLE_LENGTH,
          );
        } catch (err) {
          if (!isNodeLimitError(err)) throw err;
          await failUnclaimable(tx, run, row, `could not be claimed: its stored row is past the node limits (${err.message})`);
          continue;
        }
        try {
          // A savepoint: a refused token insert must not abort the claim's transaction.
          return await tx.transaction(async (sp) => {
            await writeSessionNode(sp, run, { externalId: row.external_id, title: row.title, content: row.content, metadata }, "claimSession");
            const minted = await createSessionToken(sp, row.id);
            return { session: await loadSession(sp, row.id), token: minted.token };
          });
        } catch (err) {
          if (!(err instanceof ClientTokenExistsError)) throw err;
          await failUnclaimable(tx, run, row, `could not be claimed: a live token already holds client ${sessionTokenClient(row.id)}; revoke it with \`pnpm -s client-token revoke ${sessionTokenClient(row.id)}\` and request a new session`);
        }
      }
      return null;
    });
  } finally {
    await closeIngestRun(db, run);
  }
}

function isNodeLimitError(err: unknown): err is MetadataTooLargeError | TitleTooLargeError | ContentTooLargeError | InvalidNodeContentError {
  return err instanceof MetadataTooLargeError || err instanceof TitleTooLargeError || err instanceof ContentTooLargeError || err instanceof InvalidNodeContentError;
}

const UNKNOWN_FIELD = Symbol("unknown field");

/**
 * `value` under the contract rule for `key`, undefined to drop the key, or
 * `UNKNOWN_FIELD` for a key the contract does not name. Throws as the
 * contract does for a value that breaks it.
 */
function contractField(key: string, value: unknown): unknown {
  if (key === KEY.flavor) return oneOf(key, value, HANGAR_FLAVORS);
  if (key === KEY.repo) return requiredText(key, value, MAX_HANGAR_REPO_LENGTH);
  const optional = OPTIONAL_TEXT.find(([k]) => k === key);
  if (optional !== undefined) return optionalText(key, value, optional[1]);
  if (key === KEY.outcome) return optionalOutcome(value);
  if (key === KEY.claimedAt || key === KEY.outcomeAt) return optionalInstant(key, value);
  if (key === OCCURRED_AT_KEY) return normalizeOccurredAt({ [OCCURRED_AT_KEY]: value })[OCCURRED_AT_KEY];
  return UNKNOWN_FIELD;
}

/**
 * What a failing row keeps of its stored metadata: each contract field that
 * passes the contract on its own (one that breaks it is dropped), then the
 * unknown keys in stored order while the whole still fits the node write's
 * metadata limit. Writing the stored metadata back unchanged would have the
 * write itself refuse an oversized row, aborting every claim behind it. The
 * stored row is not lost: its revision keeps it (node_revisions).
 */
function salvageSessionMetadata(stored: Record<string, unknown>, failed: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const unknown: [string, unknown][] = [];
  for (const [key, value] of Object.entries(stored)) {
    if (key in failed) continue;
    let kept: unknown;
    try {
      kept = contractField(key, value);
    } catch (err) {
      if (!(err instanceof InvalidHangarSessionError || err instanceof InvalidEventTimeError)) throw err;
      continue;
    }
    if (kept === UNKNOWN_FIELD) unknown.push([key, value]);
    else if (kept !== undefined) out[key] = kept;
  }
  Object.assign(out, failed);
  // JSON of an object: braces, one `"key":value` per entry, commas between.
  const entry = (key: string, value: unknown) => JSON.stringify(key).length + 1 + (JSON.stringify(value) ?? "null").length;
  let size = 2 + Object.entries(out).reduce((n, [k, v], i) => n + entry(k, v) + (i > 0 ? 1 : 0), 0);
  for (const [key, value] of unknown) {
    const grown = size + entry(key, value) + 1;
    if (grown > DEFAULT_MAX_METADATA_LENGTH) continue;
    out[key] = value;
    size = grown;
  }
  return out;
}

/** A failing row's title or content as the node write accepts it: kept as stored when it does, else stripped of control characters and cut to `max`. */
function fitStored(value: string, max: number): string {
  return value.length > max || hasControlChar(value) ? fitField(value, max) : value;
}

/**
 * Marks a locked queued session `failed` with `reason`, keeping what of its
 * stored row the session contract and the node limits accept
 * (`salvageSessionMetadata`, `fitStored`: the row may break them, which is
 * why it is failing), and revokes its tokens. Failed is final, so no claim
 * takes it again.
 */
async function failUnclaimable(tx: Tx, run: IngestRunHandle, row: LockedSessionRow, reason: string): Promise<void> {
  const stored = row.metadata !== null && typeof row.metadata === "object" && !Array.isArray(row.metadata) ? row.metadata : {};
  const metadata = salvageSessionMetadata(stored, { [KEY.state]: "failed", [KEY.failureReason]: fitField(reason, MAX_HANGAR_FAILURE_REASON_LENGTH) });
  const title = fitStored(row.title, DEFAULT_MAX_TITLE_LENGTH);
  const content = fitStored(row.content, DEFAULT_MAX_CONTENT_LENGTH);
  await writeSessionNode(tx, run, { externalId: row.external_id, title, content, metadata }, "claimSession");
  await revokeSessionTokens(tx, row.id);
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
  /** Why hangar failed it (1–`MAX_HANGAR_FAILURE_REASON_LENGTH` characters); taken only with `state` "failed", stored as `failure_reason`. */
  reason?: string;
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
 * whether the session's tokens die with this write, or throws to refuse it.
 * The same checks run first on an unlocked read, so a refused change opens
 * no ingest run; they run again under the row lock, which decides.
 */
async function changeClaimedSession(
  db: Database,
  hangar: string,
  id: string,
  what: string,
  change: (current: Record<string, unknown>) => { metadata: Record<string, unknown>; revoke: boolean },
): Promise<SessionWriteResult> {
  const read = (tx: Database | Tx, lock: boolean) => readSessionRow(tx, id, lock);
  const decide = (row: LockedSessionRow | undefined): { row: LockedSessionRow; metadata: Record<string, unknown>; revoke: boolean } => {
    if (!row) throw new HangarSessionNotFoundError(id);
    const current = normalizeHangarSessionMetadata(row.metadata);
    const claimedBy = (current[KEY.claimedBy] as string | undefined) ?? null;
    if (claimedBy !== hangar) throw new HangarSessionNotClaimedByError(row.id, hangar, claimedBy);
    const { metadata, revoke } = change(current);
    return { row, metadata: normalizeHangarSessionMetadata(metadata), revoke };
  };

  decide((await read(db, false)).rows[0]);
  const run = await openIngestRun(db, HANGAR_SOURCE_SYSTEM, { actor: hangar });
  try {
    return await db.transaction(async (tx) => {
      const { row, metadata, revoke } = decide((await read(tx, true)).rows[0]);
      await writeSessionNode(tx, run, { externalId: row.external_id, title: row.title, content: row.content, metadata }, what);
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
 * revision of the session node. `reason` comes only with `failed` and is
 * stored as `failure_reason` on the move into failed; a repeated failed
 * report keeps the reason already stored. A field update on an ended session
 * (no state, or the same one) is allowed within `assertEndedSessionChange`:
 * clearing `container` and `disk_path` once a person has set an outcome is
 * how hangar acknowledges a release (module header). The outcome is carried
 * forward untouched; hangar never sets it.
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
  if (input.reason !== undefined && state !== "failed") {
    throw new InvalidHangarSessionError("reason", input.reason, 'is taken only with state "failed"');
  }
  const reason = input.reason === undefined ? undefined : requiredText("reason", input.reason, MAX_HANGAR_FAILURE_REASON_LENGTH);
  if (state === undefined && fields.every(([, value]) => value === undefined)) {
    throw new InvalidHangarSessionError("update", {}, "names nothing to change: give a state, container, host, or disk_path");
  }
  // Each given field as the contract stores it: a string, or null to clear (null, "", or blank).
  const given: [string, string | null][] = fields.flatMap(([key, value, max]): [string, string | null][] => (value === undefined ? [] : [[key, optionalText(key, value, max) ?? null]]));

  return changeClaimedSession(db, hangar, id, "updateSession", (current) => {
    const from = current[KEY.state] as HangarSessionState;
    const to = state ?? from;
    checkHangarTransition(from, to);
    if (HANGAR_FINAL_STATES.includes(from)) assertEndedSessionChange(id, current, given);
    const metadata: Record<string, unknown> = { ...current, [KEY.state]: to };
    for (const [key, value] of given) {
      if (value === null) delete metadata[key];
      else metadata[key] = value;
    }
    // Only the move into failed records why: a repeated failed report keeps the first reason.
    if (reason !== undefined && from !== "failed") metadata[KEY.failureReason] = reason;
    return { metadata, revoke: to === "stopped" || to === "failed" };
  });
}

/**
 * The rules for a `PATCH` on an ended session (`HangarEndedSessionChangeError`
 * otherwise): its placement fields only clear, never set, so a released
 * session is never un-released; on a released one, nothing but a clear (an
 * acknowledgement hangar repeats after a lost answer stays a no-op); and
 * clearing a held `disk_path`, the release acknowledgement, only once a
 * person has set an outcome. `fields` are already normalized (null clears).
 */
function assertEndedSessionChange(id: string, current: Record<string, unknown>, given: readonly [string, string | null][]): void {
  const hasOutcome = current[KEY.outcome] !== undefined;
  const released = hasOutcome && current[KEY.diskPath] === undefined;
  for (const [key, value] of given) {
    if (value === null || value === current[key]) continue;
    if (released) throw new HangarEndedSessionChangeError(id, "released", key);
    if (key === KEY.container || key === KEY.diskPath) throw new HangarEndedSessionChangeError(id, "value", key);
  }
  const clearsDisk = given.some(([key, value]) => key === KEY.diskPath && value === null);
  if (clearsDisk && current[KEY.diskPath] !== undefined && !hasOutcome) throw new HangarEndedSessionChangeError(id, "no_outcome", KEY.diskPath);
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

// --- A person's outcome -------------------------------------------------------------------

export interface SetHangarSessionOutcomeInput {
  id: string;
  /** One of `HANGAR_OUTCOMES`. */
  outcome: string;
  /** The person who decided (the admitted client, or "human"); the run's actor and `outcome_by`. */
  actor?: string;
}

export interface SetHangarSessionOutcomeResult {
  session: HangarSession;
  /** False when the session already had this outcome: nothing was written. */
  changed: boolean;
}

function outcomeArgs(input: SetHangarSessionOutcomeInput): { id: string; outcome: HangarOutcome; actor: string } {
  return {
    id: assertUuid(input.id, "session id"),
    outcome: oneOf(KEY.outcome, input.outcome, HANGAR_OUTCOMES),
    actor: requesterOf(input.actor) ?? "human",
  };
}

/** Throws `HangarOutcomeRefusedError` unless a session with this (normalized) metadata can take a new outcome: ended, and not yet released. */
function assertTakesOutcome(id: string, current: Record<string, unknown>): void {
  const state = current[KEY.state] as HangarSessionState;
  if (!HANGAR_FINAL_STATES.includes(state)) throw new HangarOutcomeRefusedError(id, "state", state);
  const stored = current[KEY.outcome] as string | undefined;
  if (stored !== undefined && current[KEY.diskPath] === undefined) throw new HangarOutcomeRefusedError(id, "released", stored);
}

/**
 * The session's new metadata with `outcome`, or null when it already has
 * it (a no-op, checked after the state, before the release). Refuses as
 * `assertTakesOutcome` does. `outcome_at` is the database's `now()`.
 */
function decideOutcome(row: LockedSessionRow | undefined, id: string, outcome: HangarOutcome, actor: string): { row: LockedSessionRow; metadata: Record<string, unknown> | null } {
  if (!row) throw new HangarSessionNotFoundError(id);
  const current = normalizeHangarSessionMetadata(row.metadata);
  const state = current[KEY.state] as HangarSessionState;
  if (!HANGAR_FINAL_STATES.includes(state)) throw new HangarOutcomeRefusedError(row.id, "state", state);
  if (current[KEY.outcome] === outcome) return { row, metadata: null };
  assertTakesOutcome(row.id, current);
  return { row, metadata: normalizeHangarSessionMetadata({ ...current, [KEY.outcome]: outcome, [KEY.outcomeAt]: new Date(row.now), [KEY.outcomeBy]: actor }) };
}

/**
 * Reads session `id` (folded through merges) and refuses, as
 * `setHangarSessionOutcome` would, one that cannot take an outcome: not a
 * session, not ended, or already released. For a path that asks a person
 * (inbox.ts `requestHangarOutcome`), before it files anything.
 */
export async function getSessionTakingOutcome(db: Database, id: string): Promise<HangarSession> {
  const sessionId = assertUuid(id, "session id");
  const row = (await readSessionRow(db, sessionId, false)).rows[0];
  if (!row) throw new HangarSessionNotFoundError(sessionId);
  assertTakesOutcome(row.id, normalizeHangarSessionMetadata(row.metadata));
  return loadSession(db, row.id);
}

/**
 * A person accepts or tables an ended session (module header). Only a
 * `stopped` or `failed` session takes one, and only until hangar has
 * released it (`HangarOutcomeRefusedError` otherwise); setting the outcome
 * it already has is a no-op that writes nothing. Otherwise the outcome,
 * `outcome_at` (the database's clock), and `outcome_by` are written through
 * the upsert path under a `hangar` run whose actor is the person, so the
 * revision names them and `updated_at` moves: the session leads hangar's
 * newest-changed listing. The checks run first on an unlocked read, so a
 * refusal opens no run, and again under the row lock, which decides. Only
 * the people paths call this; no token scope but `human` reaches it.
 */
export async function setHangarSessionOutcome(db: Database, input: SetHangarSessionOutcomeInput): Promise<SetHangarSessionOutcomeResult> {
  const args = outcomeArgs(input);
  const pre = decideOutcome((await readSessionRow(db, args.id, false)).rows[0], args.id, args.outcome, args.actor);
  if (pre.metadata === null) return { session: await loadSession(db, pre.row.id), changed: false };
  const run = await openIngestRun(db, HANGAR_SOURCE_SYSTEM, { actor: args.actor });
  try {
    return await db.transaction((tx) => unsafeSetHangarSessionOutcomeInTx(tx, run, args));
  } finally {
    await closeIngestRun(db, run);
  }
}

/**
 * `setHangarSessionOutcome`'s locked half, inside the caller's transaction
 * and under its `run` (which must be a `hangar` run naming the person): an
 * inbox decision sets the outcome in the transaction that records it, so a
 * refusal rolls the decision back too. "unsafe": the caller vouches that
 * a person decided.
 */
export async function unsafeSetHangarSessionOutcomeInTx(tx: Tx, run: IngestRunHandle, input: SetHangarSessionOutcomeInput): Promise<SetHangarSessionOutcomeResult> {
  const args = outcomeArgs(input);
  const { row, metadata } = decideOutcome((await readSessionRow(tx, args.id, true)).rows[0], args.id, args.outcome, args.actor);
  if (metadata !== null) await writeSessionNode(tx, run, { externalId: row.external_id, title: row.title, content: row.content, metadata }, "setHangarSessionOutcome");
  return { session: await loadSession(tx, row.id), changed: metadata !== null };
}

// --- Listing ---------------------------------------------------------------------------

export interface ListSessionsOptions {
  /** Only sessions this hangar claimed. */
  claimedBy?: string;
  states?: readonly string[];
  /** Only sessions run for this work item (folded through merges). */
  workItemId?: string;
  /** Only sessions hangar has yet to release: an outcome set, and a disk path still held. */
  releasable?: boolean;
  /** Default `DEFAULT_HANGAR_SESSIONS_LIMIT`, at most `MAX_HANGAR_SESSIONS_LIMIT`. */
  limit?: number;
}

export interface ListSessionsResult {
  sessions: HangarSession[];
  /** More sessions matched than `limit`. */
  truncated: boolean;
}

/** The sessions these ids name, in one statement; an id that names no session is left out. The caller bounds the ids (an inbox page's outcome requests). */
export async function getSessionsByIds(db: Database, ids: readonly string[]): Promise<HangarSession[]> {
  const wanted = [...new Set(ids.map((id) => assertUuid(id, "session id")))];
  if (wanted.length === 0) return [];
  const result = await db.execute<SessionRow>(selectSessions(sql`s.id = ANY(${sqlArray(wanted, "uuid")})`));
  return result.rows.map(toSession);
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
  if (options.releasable === true) {
    filters.push(sql`s.metadata ? ${KEY.outcome} AND s.metadata ? ${KEY.diskPath}`);
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
  /**
   * Stored as given (an object of at most `MAX_HANGAR_CAPACITY_CHARS`
   * serialized), parsed leniently on read (`parseHangarCapacity`). Null or
   * absent clears the stored capacity and its time.
   */
  capacity?: Record<string, unknown> | null;
}

/**
 * Records a check-in at the database's `now()`, with its capacity and
 * `capacity_at` (that `now()`, or null with no capacity); returns the
 * interval hangar should check in on, and that `now()`.
 */
export async function recordCheckIn(db: Database, input: RecordCheckInInput): Promise<{ intervalS: number; now: Date }> {
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
  const result = await db.execute<{ interval_s: number; last_seen_at: string | Date }>(sql`
    INSERT INTO hangar_check_ins (hangar, last_seen_at, version, capacity, capacity_at)
    VALUES (${hangar}, now(), ${version}, ${capacity}::jsonb, ${capacity === null ? sql`NULL` : sql`now()`})
    ON CONFLICT (hangar) DO UPDATE SET last_seen_at = now(), version = excluded.version, capacity = excluded.capacity, capacity_at = excluded.capacity_at
    RETURNING interval_s, last_seen_at
  `);
  const row = result.rows[0];
  if (!row) throw new Error("recordCheckIn: the upsert returned no row");
  return { intervalS: Number(row.interval_s), now: new Date(row.last_seen_at) };
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
  /** That hangar's latest capacity, parsed (`parseHangarCapacity`); null when it sent none. */
  capacity: HangarCapacity | null;
  /** The database's time that capacity arrived; null with no capacity. */
  capacityAt: Date | null;
};

/** Hangar's status (the named hangar, or the most recent check-in), its capacity, and the open session counts. One statement. */
export async function getHangarStatus(db: Database, options: { hangar?: string } = {}): Promise<HangarStatus> {
  const hangar = options.hangar === undefined ? undefined : hangarName(options.hangar);
  const result = await db.execute<{
    now: string | Date;
    hangar: string | null;
    last_seen_at: string | Date | null;
    version: string | null;
    interval_s: number | null;
    capacity: unknown;
    capacity_at: string | Date | null;
    queued: string | number;
    claimed: string | number;
    running: string | number;
  }>(sql`
    SELECT now() AS now, c.hangar, c.last_seen_at, c.version, c.interval_s, c.capacity, c.capacity_at, k.queued, k.claimed, k.running
    FROM (SELECT 1) one
    LEFT JOIN LATERAL (
      SELECT hangar, last_seen_at, version, interval_s, capacity, capacity_at FROM hangar_check_ins
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
    capacity: row.capacity === null || row.capacity === undefined ? null : parseHangarCapacity(row.capacity),
    capacityAt: row.capacity_at === null ? null : new Date(row.capacity_at),
  };
}

// --- Capacity and why a queued session waits ----------------------------------------

/**
 * A check-in's capacity as this version reads it, under hangar's wire names
 * (docs/hangar-api.md). Every field is optional: one hangar didn't send, or
 * sent in a shape this version can't read, is absent.
 */
export interface HangarCapacity {
  /** How many more sessions of each flavor fit now: non-negative integers. */
  slots?: Record<string, number>;
  /** Why each flavor that doesn't fit doesn't, cut to `MAX_HANGAR_BLOCKED_REASON_LENGTH`. A `disk:` prefix means the disk budget is full. */
  blocked?: Record<string, string>;
  free?: { ram_mb: number; cpus: number; vram_mb: number; disk_mb: number };
  sessions?: { running: number; kept: number };
  disk?: { allocated_bytes: number; apparent_bytes: number };
  /** Per-session disk usage, session ids lowercased, at most `MAX_HANGAR_USAGE_ENTRIES`. */
  usage?: { session: string; allocated_bytes: number; apparent_bytes: number }[];
}

export type HangarWaitKind = (typeof HANGAR_WAIT_KINDS)[number];

/** One online hangar's reason it can't take a flavor. */
export interface HangarWaitReason {
  hangar: string;
  reason: string;
}

/** An ended session still holding a disk with no outcome: a person's accept or table frees it. */
export interface HangarAwaitingReviewSession {
  id: string;
  claimedBy: string | null;
  /** The work item it ran for (folded through merges), with its `project` metadata; null if the edge or the node is gone. */
  workItem: { id: string; externalId: string; title: string; project: string | null } | null;
  /** The allocated bytes hangar reported for its disk; absent when no online hangar's usage lists it. */
  diskAllocatedBytes?: number;
}

/** Why a queued session waits. `text` is the one-line summary every surface shows. */
export type HangarWaiting =
  | { kind: "offline"; text: string; since: string | null }
  | { kind: "unknown"; text: string }
  | { kind: "next"; text: string; ahead: number }
  | { kind: "not_offered"; text: string }
  | { kind: "disk_awaiting_review"; text: string; reasons: HangarWaitReason[]; sessions: HangarAwaitingReviewSession[]; total: number }
  | { kind: "capacity"; text: string; reasons: HangarWaitReason[] };

/** One hangar's latest check-in, as `classifyQueuedWait` reads it. */
export interface HangarCheckInSnapshot {
  hangar: string;
  lastSeenAt: Date;
  intervalS: number;
  /** Parsed; null when the check-in sent none. */
  capacity: HangarCapacity | null;
}

export interface QueuedWaitContext {
  /** The database's clock. */
  now: Date;
  checkIns: readonly HangarCheckInSnapshot[];
  /** The listed awaiting-review sessions (at most `MAX_HANGAR_AWAITING_REVIEW_LISTED`) and how many there are in all. */
  awaitingReview: { sessions: readonly Omit<HangarAwaitingReviewSession, "diskAllocatedBytes">[]; total: number };
}

export interface ExplainQueuedSessionsOptions {
  /** Only these sessions (at most `MAX_HANGAR_SESSIONS_LIMIT`); every queued session when absent. */
  ids?: readonly string[];
  /**
   * Restricts the read to these hangars' check-ins and these sessions (the
   * queue and the awaiting-review list alike). A test seam, like
   * `claimSession`'s `among`: a suite sharing a database with live data
   * explains only its own fixtures this way. Never set in production.
   */
  among?: { hangars: readonly string[]; sessions: readonly string[] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** `obj[key]` when it is `obj`'s own property, so a key like `constructor` never reads the prototype. */
function own(obj: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(obj, key) ? obj[key] : undefined;
}

function isCount(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** The object at `raw[key]` with exactly `fields`, each passing `valid`; undefined if any is missing or bad. */
function wholeRecord<K extends string>(raw: Record<string, unknown>, key: string, fields: readonly K[], valid: (v: unknown) => v is number): Record<K, number> | undefined {
  const value = own(raw, key);
  if (!isRecord(value)) return undefined;
  const out = {} as Record<K, number>;
  for (const field of fields) {
    const v = own(value, field);
    if (!valid(v)) return undefined;
    out[field] = v;
  }
  return out;
}

/**
 * Reads a stored capacity field by field (design decision 1). Pure; never
 * throws. Anything but an object reads as `{}`; unknown keys are ignored;
 * `slots` and `blocked` drop their bad entries; `free`, `sessions`, and
 * `disk` are read whole (all their fields, or absent); `usage` keeps entries
 * whose `session` is a uuid (lowercased) and whose byte counts are
 * non-negative finite numbers, the first `MAX_HANGAR_USAGE_ENTRIES` of them.
 * Maps are built with `Object.fromEntries`, so a `__proto__` key is inert.
 */
export function parseHangarCapacity(raw: unknown): HangarCapacity {
  if (!isRecord(raw)) return {};
  const out: HangarCapacity = {};

  const slots = own(raw, "slots");
  if (isRecord(slots)) out.slots = Object.fromEntries(Object.entries(slots).filter((entry): entry is [string, number] => isCount(entry[1])));

  const blocked = own(raw, "blocked");
  if (isRecord(blocked)) {
    out.blocked = Object.fromEntries(
      Object.entries(blocked).flatMap(([flavor, reason]): [string, string][] =>
        typeof reason === "string" && reason.trim() !== "" ? [[flavor, fitText(reason, MAX_HANGAR_BLOCKED_REASON_LENGTH) as string]] : [],
      ),
    );
  }

  const free = wholeRecord(raw, "free", ["ram_mb", "cpus", "vram_mb", "disk_mb"], (v): v is number => typeof v === "number" && Number.isFinite(v));
  if (free !== undefined) out.free = free;
  const sessions = wholeRecord(raw, "sessions", ["running", "kept"], isCount);
  if (sessions !== undefined) out.sessions = sessions;
  const disk = wholeRecord(raw, "disk", ["allocated_bytes", "apparent_bytes"], isAmount);
  if (disk !== undefined) out.disk = disk;

  const usage = own(raw, "usage");
  if (Array.isArray(usage)) {
    const kept: NonNullable<HangarCapacity["usage"]> = [];
    for (const entry of usage) {
      if (kept.length >= MAX_HANGAR_USAGE_ENTRIES) break;
      if (!isRecord(entry)) continue;
      const session = own(entry, "session");
      const allocated = own(entry, "allocated_bytes");
      const apparent = own(entry, "apparent_bytes");
      if (typeof session !== "string" || !UUID_RE.test(session.trim()) || !isAmount(allocated) || !isAmount(apparent)) continue;
      kept.push({ session: session.trim().toLowerCase(), allocated_bytes: allocated, apparent_bytes: apparent });
    }
    out.usage = kept;
  }
  return out;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/**
 * Why a queued session of `flavor`, with `ahead` same-flavor sessions before
 * it in claim order, waits (design decision 2). Pure. Only online hangars
 * count, and of those only ones that reported a capacity decide the reason:
 *
 * 1. none online → `offline`, since the newest check-in (null: never);
 * 2. none of them reported a capacity → `unknown`;
 * 3. one has a free slot for the flavor → `next`;
 * 4. none names the flavor in `slots` or `blocked` → `not_offered`;
 * 5. every naming hangar's reason starts with `disk:` and a session awaits
 *    review → `disk_awaiting_review`;
 * 6. otherwise → `capacity`.
 *
 * A naming hangar's reason is its `blocked` entry, or "no free slot" for a
 * flavor at 0 slots with none. A listed awaiting-review session's disk bytes
 * come from the usage of the online hangar that claimed it, else of any
 * online hangar that lists it.
 */
export function classifyQueuedWait(session: { flavor: string; ahead: number }, ctx: QueuedWaitContext): HangarWaiting {
  const { flavor, ahead } = session;
  const online = ctx.checkIns.filter((c) => classifyHangarStatus(c, ctx.now).state === "online");
  if (online.length === 0) {
    if (ctx.checkIns.length === 0) return { kind: "offline", text: "Waiting: hangar has never checked in.", since: null };
    const since = new Date(Math.max(...ctx.checkIns.map((c) => c.lastSeenAt.getTime()))).toISOString();
    return { kind: "offline", text: `Waiting: hangar is offline (last check-in ${since}).`, since };
  }
  const reporting = online.filter((c): c is HangarCheckInSnapshot & { capacity: HangarCapacity } => c.capacity !== null);
  if (reporting.length === 0) return { kind: "unknown", text: "Waiting: hangar is online but reported no capacity." };

  const slotsFor = (c: HangarCapacity): number | undefined => (c.slots !== undefined && Object.hasOwn(c.slots, flavor) ? c.slots[flavor] : undefined);
  const blockedFor = (c: HangarCapacity): string | undefined => (c.blocked !== undefined && Object.hasOwn(c.blocked, flavor) ? c.blocked[flavor] : undefined);

  if (reporting.some((c) => (slotsFor(c.capacity) ?? 0) > 0)) {
    const text =
      ahead === 0
        ? `Next in line: hangar has room for a ${flavor} session.`
        : `Waiting: ${ahead} ${flavor} ${plural(ahead, "request", "requests")} ahead; hangar has room for ${flavor}.`;
    return { kind: "next", text, ahead };
  }

  const reasons: HangarWaitReason[] = reporting.flatMap((c): HangarWaitReason[] => {
    const blocked = blockedFor(c.capacity);
    if (blocked !== undefined) return [{ hangar: c.hangar, reason: blocked }];
    return slotsFor(c.capacity) === 0 ? [{ hangar: c.hangar, reason: "no free slot" }] : [];
  });
  if (reasons.length === 0) return { kind: "not_offered", text: `Waiting: no online hangar runs ${flavor}.` };

  const quoted = reasons.map((r) => `${r.hangar}: ${r.reason}`).join("; ");
  const { total } = ctx.awaitingReview;
  if (total > 0 && reasons.every((r) => r.reason.trim().startsWith("disk:"))) {
    const bytesOf = (c: HangarCapacity, id: string): number | undefined => c.usage?.find((u) => u.session === id)?.allocated_bytes;
    const sessions = ctx.awaitingReview.sessions.map((s): HangarAwaitingReviewSession => {
      const claimer = reporting.find((c) => c.hangar === s.claimedBy);
      const bytes = (claimer === undefined ? undefined : bytesOf(claimer.capacity, s.id)) ?? reporting.map((c) => bytesOf(c.capacity, s.id)).find((b) => b !== undefined);
      return bytes === undefined ? { ...s } : { ...s, diskAllocatedBytes: bytes };
    });
    const held = `${total} ended ${plural(total, "session still holds", "sessions still hold")} a disk awaiting accept or table.`;
    return { kind: "disk_awaiting_review", text: `Waiting on disk: ${quoted}. ${held}`, reasons, sessions, total };
  }
  return { kind: "capacity", text: `Waiting on capacity: ${quoted}.`, reasons };
}

interface ExplainContextRow extends Record<string, unknown> {
  now: string | Date;
  check_ins: { hangar: string; last_seen_ms: number; interval_s: number | null; capacity: unknown }[];
  awaiting_total: string | number;
  awaiting: { id: string; claimed_by: string | null; work_item: { id: string; external_id: string; title: string; project: string | null } | null }[];
}

/**
 * Why each queued session waits (all of them, or `ids`), keyed by session
 * id; a session that is not queued is left out. Two statements however long
 * the queue (design decision 3): the queued sessions, with `ahead` counted by
 * a window over every queued session before `ids` filters, in claim order
 * (`occurred_at`, then id, as `claimSession` takes them); then the database's
 * `now()`, every check-in, and the awaiting-review sessions (ended, a disk
 * held, no outcome; oldest ended first, by `updated_at` then id) with their
 * work items. The second is skipped when nothing is queued. The two are not
 * one snapshot, so a reason can be a poll stale.
 */
export async function explainQueuedSessions(db: Database, options: ExplainQueuedSessionsOptions = {}): Promise<Map<string, HangarWaiting>> {
  const ids = options.ids === undefined ? undefined : [...new Set(options.ids.map((id) => assertUuid(id, "session id")))];
  if (ids !== undefined && ids.length > MAX_HANGAR_SESSIONS_LIMIT) {
    throw new InvalidHangarSessionError("ids", `${ids.length} ids`, `must list at most ${MAX_HANGAR_SESSIONS_LIMIT} sessions`);
  }
  const among = options.among === undefined ? undefined : { hangars: options.among.hangars.map(hangarName), sessions: options.among.sessions.map((id) => assertUuid(id, "session id")) };
  const waiting = new Map<string, HangarWaiting>();
  if (ids !== undefined && ids.length === 0) return waiting;
  const amongSessions = among === undefined ? sql`` : sql`AND s.id = ANY(${sqlArray(among.sessions, "uuid")})`;

  const queued = await db.execute<{ id: string; flavor: string | null; ahead: string | number }>(sql`
    SELECT q.id, q.flavor, q.ahead FROM (
      SELECT s.id, s.metadata->>${KEY.flavor} AS flavor,
             row_number() OVER (PARTITION BY s.metadata->>${KEY.flavor} ORDER BY s.metadata->>${OCCURRED_AT_KEY}, s.id) - 1 AS ahead
      FROM nodes s
      WHERE ${IS_SESSION} AND s.metadata @> ${JSON.stringify({ [KEY.state]: "queued" })}::jsonb ${amongSessions}
    ) q
    ${ids === undefined ? sql`` : sql`WHERE q.id = ANY(${sqlArray(ids, "uuid")})`}
  `);
  if (queued.rows.length === 0) return waiting;

  const awaitingWhere = sql`s.metadata->>${KEY.state} = ANY(${sqlArray(HANGAR_FINAL_STATES, "text")})
    AND s.metadata ? ${KEY.diskPath} AND NOT (s.metadata ? ${KEY.outcome}) ${amongSessions}`;
  const result = await db.execute<ExplainContextRow>(sql`
    WITH awaiting AS (${selectSessions(awaitingWhere)})
    SELECT now() AS now,
      COALESCE((
        SELECT json_agg(json_build_object(
                 'hangar', c.hangar,
                 'last_seen_ms', floor(extract(epoch FROM c.last_seen_at) * 1000)::float8,
                 'interval_s', c.interval_s,
                 'capacity', c.capacity) ORDER BY c.hangar)
        FROM hangar_check_ins c
        ${among === undefined ? sql`` : sql`WHERE c.hangar = ANY(${sqlArray(among.hangars, "text")})`}
      ), '[]'::json) AS check_ins,
      (SELECT count(*) FROM awaiting) AS awaiting_total,
      COALESCE((
        SELECT json_agg(json_build_object(
                 'id', a.id,
                 'claimed_by', a.metadata->>${KEY.claimedBy},
                 'work_item', CASE WHEN w.id IS NULL THEN NULL ELSE json_build_object(
                   'id', w.id, 'external_id', w.external_id, 'title', w.title, 'project', w.metadata->>'project') END)
               ORDER BY a.updated_at, a.id)
        FROM (SELECT * FROM awaiting ORDER BY updated_at, id LIMIT ${MAX_HANGAR_AWAITING_REVIEW_LISTED}) a
        LEFT JOIN nodes w ON w.id = a.work_item_id
      ), '[]'::json) AS awaiting
  `);
  const row = result.rows[0];
  if (!row) throw new Error("explainQueuedSessions: the context query returned no row");
  const ctx: QueuedWaitContext = {
    now: new Date(row.now),
    checkIns: row.check_ins.map((c) => ({
      hangar: c.hangar,
      lastSeenAt: new Date(c.last_seen_ms),
      intervalS: c.interval_s === null ? HANGAR_CHECK_IN_INTERVAL_S : Number(c.interval_s),
      capacity: c.capacity === null ? null : parseHangarCapacity(c.capacity),
    })),
    awaitingReview: {
      total: Number(row.awaiting_total),
      sessions: row.awaiting.map((a) => ({
        id: a.id,
        claimedBy: a.claimed_by,
        workItem: a.work_item === null ? null : { id: a.work_item.id, externalId: a.work_item.external_id, title: a.work_item.title, project: a.work_item.project },
      })),
    },
  };
  for (const q of queued.rows) waiting.set(q.id, classifyQueuedWait({ flavor: q.flavor ?? "", ahead: Number(q.ahead) }, ctx));
  return waiting;
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
