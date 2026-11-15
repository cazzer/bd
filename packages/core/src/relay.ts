// The laptop relay's queue (laptop-relay change, design decisions 1–3 and 9).
// A Breakdown that lacks `bd` or `herdr` (the Jetson) queues the work those
// binaries do as rows in `relay_actions`; a relay on the Mac, which has
// them, claims each row over HTTP, runs it, and reports it done or failed.
//
// An action is a kind and a payload of validated data, never a command
// string. Each kind's payload has a strict zod schema below; enqueue
// refuses anything else, and the relay parses it again with the same
// schemas before running it. Every free-text field the relay will pass to
// a binary is also checked against the allowlist (relay-allowlist.ts).
// Both checks bound an action's *shape* only: a compromised Breakdown can
// still queue any well-formed action, and what keeps it from choosing
// where `bd` runs or which herdr server is prompted is the relay's own
// configuration (its projects and sockets), never anything stored here.
//
// State machine: queued → claimed → done | failed. Claiming is one
// transaction: `FOR UPDATE SKIP LOCKED` on the oldest open row of an
// admitted kind (and, when the relay names its projects, of one of them;
// a herdr prompt has no project and is admitted by kind alone), so racing
// claims take different rows or none. A claimed
// row whose claim is older than `RELAY_RECLAIM_AFTER_S` is claimable again
// in the same predicate, so a relay that died mid-action loses nothing and
// no sweeper runs. `attempts` counts claims not followed by a report (a
// requeue gives its attempt back): a row claimed `MAX_RELAY_ATTEMPTS` times
// without one is failed at its next claim rather than run again. A review
// decision or herdr prompt queued more than `RELAY_MAX_AGE_S` (24 h) ago is
// failed at its next claim as stale rather than run: a decision or a reply
// that old is no longer the person's present intent. A re-ingest is never
// stale. A cheap probe runs first, so a long-poll that finds nothing opens
// no transaction.
//
// One action per target is open at a time: the unique open-target index
// (kind, project, issue; herdr prompts excluded) makes a second pending
// review decision on the same review a `RelayActionPendingError`, while a
// second re-ingest of a project folds into the one already queued.
//
// Reporting is idempotent: a report of an action already finished is a
// no-op answered `alreadyFinished`, so a relay that retries a report after
// a lost response does not fail.
//
// Check-ins (`relay_check_ins`) are a table, like hangar's; every claim
// counts as one. Status is computed on read against the database's
// `now()`, never the relay's clock.
//
// The app makes no model call: all of this is pure Postgres.

import path from "node:path";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { RELAY_ACTION_KINDS, RELAY_ACTION_STATES, type Database, type RelayActionKind, type RelayActionState } from "@breakdown/db";
import { InvalidRelayActionError, RelayActionNotClaimedByError, RelayActionNotFoundError, RelayActionPendingError } from "./errors.js";
import { fitText } from "./fit-text.js";
import { CONTROL_CHAR_CODE_POINTS } from "./nodes.js";
import {
  isAllowedHerdrArgs,
  isRelayIssueId,
  isRelayPane,
  isRelayText,
  MAX_RELAY_HERDR_PAYLOAD_TEXT_LENGTH,
  MAX_RELAY_ISSUE_ID_LENGTH,
  RELAY_ISSUE_ID_PATTERN,
} from "./relay-allowlist.js";
import {
  isReviewSocketPath,
  MAX_REVIEW_DECISION_MESSAGE_LENGTH,
  MAX_REVIEW_OPTION_LABEL_LENGTH,
  MAX_REVIEW_OPTION_TEXT_LENGTH,
  MAX_REVIEW_QUESTION_LENGTH,
  REVIEW_DECISION_MESSAGE_REFUSED_CHARS,
  REVIEW_OPTION_ID_PATTERN,
} from "./reviews.js";
import { sqlArray } from "./sql-helpers.js";
import { PROJECT_KEY_PATTERN } from "./work-items.js";

export { RELAY_ACTION_KINDS, RELAY_ACTION_STATES, type RelayActionKind, type RelayActionState };

/** A claim older than this counts as abandoned, and the action is claimable again. */
export const RELAY_RECLAIM_AFTER_S = 300;
/** A review decision or herdr prompt queued longer ago than this is failed as stale at its next claim (module header). */
export const RELAY_MAX_AGE_S = 24 * 60 * 60;
/** The most project keys one claim may name. */
export const MAX_RELAY_CLAIM_PROJECTS = 100;
export const RELAY_CHECK_IN_INTERVAL_S = 30;
/** The longest a claim long-poll waits. */
export const MAX_RELAY_WAIT_S = 30;
/** Claims without a report before an action is failed rather than claimed again. */
export const MAX_RELAY_ATTEMPTS = 3;
/** Rows one claim may fail (abandoned, or a stored payload that breaks the contract) before giving up. */
export const MAX_RELAY_CLAIM_CANDIDATES = 3;
export const MAX_RELAY_NAME_LENGTH = 200;
export const MAX_RELAY_FIELD_LENGTH = 200;
export const MAX_RELAY_CWD_LENGTH = 4096;
export const MAX_RELAY_ERROR_LENGTH = 2000;
export const MAX_RELAY_REQUEUE_REASON_LENGTH = 500;
export const MAX_RELAY_RESULT_CHARS = 10_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTION_ID_RE = /^[1-9]\d{0,17}$/;
const ABANDONED_ERROR = `abandoned after ${MAX_RELAY_ATTEMPTS} claims without a report`;

function staleError(createdAt: Date): string {
  return `stale: queued ${createdAt.toISOString()}, older than ${RELAY_MAX_AGE_S / 3600} h`;
}

// --- Payload schemas (pure) ---------------------------------------------------

function hasControlChar(value: string): boolean {
  for (const char of value) if (CONTROL_CHAR_CODE_POINTS.has(char.codePointAt(0) as number)) return true;
  return false;
}

const projectKey = z.string().regex(PROJECT_KEY_PATTERN, `must match ${PROJECT_KEY_PATTERN}`);
const issueId = z
  .string()
  .max(MAX_RELAY_ISSUE_ID_LENGTH, `must be at most ${MAX_RELAY_ISSUE_ID_LENGTH} characters`)
  .regex(RELAY_ISSUE_ID_PATTERN, `must be a beads issue id matching ${RELAY_ISSUE_ID_PATTERN}`);

export const reviewDecisionPayloadSchema = z
  .strictObject({
    project_key: projectKey,
    cwd: z
      .string()
      .max(MAX_RELAY_CWD_LENGTH, `must be at most ${MAX_RELAY_CWD_LENGTH} characters`)
      .refine((p) => path.isAbsolute(p), "must be an absolute path")
      .refine((p) => !hasControlChar(p), "must not contain control characters"),
    issue_id: issueId,
    decision: z.enum(["accept", "changes"]),
    message: z
      .string()
      .max(MAX_REVIEW_DECISION_MESSAGE_LENGTH, `must be at most ${MAX_REVIEW_DECISION_MESSAGE_LENGTH} characters`)
      .refine((m) => !REVIEW_DECISION_MESSAGE_REFUSED_CHARS.test(m), "must not contain control characters (other than newline and tab) or bidirectional override characters"),
    option: z.string().regex(REVIEW_OPTION_ID_PATTERN, `must be an option id matching ${REVIEW_OPTION_ID_PATTERN}`).optional(),
    seen: z
      .strictObject({
        question: z.string().max(MAX_REVIEW_QUESTION_LENGTH),
        label: z.string().max(MAX_REVIEW_OPTION_LABEL_LENGTH),
        what: z.string().max(MAX_REVIEW_OPTION_TEXT_LENGTH).optional(),
        risk: z.string().max(MAX_REVIEW_OPTION_TEXT_LENGTH).optional(),
      })
      .optional(),
  })
  .superRefine((p, ctx) => {
    if (p.decision === "changes" && p.message.trim() === "") ctx.addIssue({ code: "custom", path: ["message"], message: "is required when requesting changes" });
    if (p.decision === "changes" && p.option !== undefined) ctx.addIssue({ code: "custom", path: ["option"], message: "is chosen only by accepting" });
    if (p.option !== undefined && p.seen === undefined) ctx.addIssue({ code: "custom", path: ["seen"], message: "is required with an option" });
    if (p.option === undefined && p.seen !== undefined) ctx.addIssue({ code: "custom", path: ["seen"], message: "is sent only with an option" });
  });

export const herdrPromptPayloadSchema = z
  .strictObject({
    pane: z.string().refine(isRelayPane, "must be a herdr pane id"),
    socket: z.string().refine((s) => isReviewSocketPath(s), "must be an absolute herdr socket path, at most 512 characters, with no control characters"),
    text: z.string(),
  })
  .superRefine((p, ctx) => {
    // The relay prefixes its provenance line, so the payload's text leaves room for it (relay-allowlist.ts).
    if (!isRelayText(p.text, MAX_RELAY_HERDR_PAYLOAD_TEXT_LENGTH) || !isAllowedHerdrArgs(["agent", "prompt", p.pane, p.text])) {
      ctx.addIssue({ code: "custom", path: ["text"], message: `must be 1 to ${MAX_RELAY_HERDR_PAYLOAD_TEXT_LENGTH} characters, with no NUL, not starting with "-"` });
    }
  });

export const beadsReingestPayloadSchema = z.strictObject({ project_key: projectKey });

export type ReviewDecisionPayload = z.infer<typeof reviewDecisionPayloadSchema>;
export type HerdrPromptPayload = z.infer<typeof herdrPromptPayloadSchema>;
export type BeadsReingestPayload = z.infer<typeof beadsReingestPayloadSchema>;

export interface RelayPayloads {
  review_decision: ReviewDecisionPayload;
  herdr_prompt: HerdrPromptPayload;
  beads_reingest: BeadsReingestPayload;
}

export const RELAY_PAYLOAD_SCHEMAS = {
  review_decision: reviewDecisionPayloadSchema,
  herdr_prompt: herdrPromptPayloadSchema,
  beads_reingest: beadsReingestPayloadSchema,
} as const;

function relayKind(value: unknown, field = "kind"): RelayActionKind {
  if (typeof value !== "string" || !(RELAY_ACTION_KINDS as readonly string[]).includes(value)) {
    throw new InvalidRelayActionError(field, value, `must be one of ${RELAY_ACTION_KINDS.join(", ")}`);
  }
  return value as RelayActionKind;
}

/** `raw` as a payload of `kind`, or InvalidRelayActionError naming the first field that breaks the kind's schema. Pure. */
export function parseRelayPayload<K extends RelayActionKind>(kind: K, raw: unknown): RelayPayloads[K];
export function parseRelayPayload(kind: unknown, raw: unknown): RelayPayloads[RelayActionKind];
export function parseRelayPayload(kind: unknown, raw: unknown): RelayPayloads[RelayActionKind] {
  const schema = RELAY_PAYLOAD_SCHEMAS[relayKind(kind)];
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const at = issue?.path ?? [];
  const field = ["payload", ...at.map(String)].join(".");
  let value: unknown = raw;
  for (const key of at) value = value !== null && typeof value === "object" ? (value as Record<PropertyKey, unknown>)[key as PropertyKey] : undefined;
  if (issue?.code === "unrecognized_keys") {
    throw new InvalidRelayActionError(field, issue.keys, "has keys the schema does not name");
  }
  throw new InvalidRelayActionError(field, value, issue?.message ?? "is invalid");
}

// --- Argument checks ---------------------------------------------------------------

function requiredText(field: string, value: unknown, max: number): string {
  if (typeof value !== "string") throw new InvalidRelayActionError(field, value, "must be a string");
  const trimmed = value.trim();
  if (trimmed === "") throw new InvalidRelayActionError(field, value, "is required");
  if (trimmed.length > max) throw new InvalidRelayActionError(field, value, `must be at most ${max} characters`);
  if (hasControlChar(trimmed)) throw new InvalidRelayActionError(field, value, "must not contain control characters");
  return trimmed;
}

function relayName(value: unknown): string {
  return requiredText("relay", value, MAX_RELAY_NAME_LENGTH);
}

/** An action id as a decimal string: a positive integer, or its decimal form of at most 18 digits (bigserial). */
function actionId(value: unknown): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && ACTION_ID_RE.test(value)) return value;
  throw new InvalidRelayActionError("id", value, "must be a positive integer action id");
}

/** Free text cut to `max` with control characters dropped; a report's error must never be refused for its length. */
function fitField(value: string, max: number): string {
  let kept = "";
  for (const char of value) if (!CONTROL_CHAR_CODE_POINTS.has(char.codePointAt(0) as number)) kept += char;
  return (fitText(kept, max) as string).trim();
}

// --- Rows ------------------------------------------------------------------------------

export interface RelayAction {
  id: number;
  kind: RelayActionKind;
  /** As stored. A claim returns it parsed (`ClaimedRelayAction`). */
  payload: unknown;
  state: RelayActionState;
  attempts: number;
  claimedBy: string | null;
  claimedAt: Date | null;
  finishedAt: Date | null;
  result: unknown;
  error: string | null;
  requestedBy: string | null;
  originNodeId: string | null;
  createdAt: Date;
}

/** A claimed action with its payload parsed under its kind's schema. */
export type ClaimedRelayAction = {
  [K in RelayActionKind]: Omit<RelayAction, "kind" | "payload"> & { kind: K; payload: RelayPayloads[K] };
}[RelayActionKind];

interface RelayActionRow {
  id: string | number;
  kind: RelayActionKind;
  payload: unknown;
  state: RelayActionState;
  attempts: number;
  claimed_by: string | null;
  claimed_at: string | Date | null;
  finished_at: string | Date | null;
  result: unknown;
  error: string | null;
  requested_by: string | null;
  origin_node_id: string | null;
  created_at: string | Date;
  [key: string]: unknown;
}

const COLUMNS = sql.raw(
  "id, kind, payload, state, attempts, claimed_by, claimed_at, finished_at, result, error, requested_by, origin_node_id, created_at",
);

function toDate(value: string | Date | null): Date | null {
  return value === null ? null : new Date(value);
}

function toAction(row: RelayActionRow): RelayAction {
  return {
    id: Number(row.id),
    kind: row.kind,
    payload: row.payload,
    state: row.state,
    attempts: Number(row.attempts),
    claimedBy: row.claimed_by,
    claimedAt: toDate(row.claimed_at),
    finishedAt: toDate(row.finished_at),
    result: row.result,
    error: row.error,
    requestedBy: row.requested_by,
    originNodeId: row.origin_node_id,
    createdAt: new Date(row.created_at),
  };
}

/** The action with `id`, as stored, or null when there is none. */
export async function getRelayAction(db: Database, id: number | string): Promise<RelayAction | null> {
  const result = await db.execute<RelayActionRow>(sql`SELECT ${COLUMNS} FROM relay_actions WHERE id = ${actionId(id)}::bigint`);
  const row = result.rows[0];
  return row === undefined ? null : toAction(row);
}

// --- Enqueue ---------------------------------------------------------------------------

/** The target an open action holds: the open-target index's key. Herdr prompts hold none. */
function targetOf(kind: RelayActionKind, payload: RelayPayloads[RelayActionKind]): { projectKey: string; issueId: string | null } | null {
  if (kind === "herdr_prompt") return null;
  const p = payload as { project_key: string; issue_id?: string };
  return { projectKey: p.project_key, issueId: p.issue_id ?? null };
}

export interface FindOpenRelayActionInput {
  kind: RelayActionKind;
  projectKey: string;
  /** The review's issue; omitted for a project-wide action (a re-ingest). */
  issueId?: string | null;
}

/** The queued or claimed action on a target, or null. Served by the open-target index. */
export async function findOpenRelayAction(db: Database, input: FindOpenRelayActionInput): Promise<RelayAction | null> {
  const kind = relayKind(input.kind);
  if (kind === "herdr_prompt") throw new InvalidRelayActionError("kind", kind, "has no target: herdr prompts are never folded into one another");
  if (typeof input.projectKey !== "string" || !PROJECT_KEY_PATTERN.test(input.projectKey)) {
    throw new InvalidRelayActionError("projectKey", input.projectKey, `must match ${PROJECT_KEY_PATTERN}`);
  }
  const issue = input.issueId ?? null;
  if (issue !== null && !isRelayIssueId(issue)) throw new InvalidRelayActionError("issueId", issue, `must be a beads issue id matching ${RELAY_ISSUE_ID_PATTERN}`);
  const result = await db.execute<RelayActionRow>(sql`
    SELECT ${COLUMNS} FROM relay_actions
    WHERE state IN ('queued', 'claimed') AND kind <> 'herdr_prompt'
      AND kind = ${kind} AND payload->>'project_key' = ${input.projectKey}
      AND coalesce(payload->>'issue_id', '') = ${issue ?? ""}
    LIMIT 1
  `);
  const row = result.rows[0];
  return row === undefined ? null : toAction(row);
}

export interface EnqueueRelayActionInput {
  kind: RelayActionKind;
  payload: unknown;
  /** Who asked: the requesting client's name. */
  requestedBy: string;
  /** The review or inbox item the action is for, so the UI can show it pending. */
  originNodeId?: string | null;
}

export interface EnqueueRelayActionResult {
  action: RelayAction;
  /** False when a re-ingest folded into the one already open. */
  created: boolean;
}

/**
 * Queues an action after validating its payload under its kind's schema
 * and the allowlist. A second open action on a target already held is
 * refused with RelayActionPendingError naming the open one, except a
 * re-ingest, which answers the open re-ingest instead (`created: false`):
 * one pending re-ingest covers every request for it.
 */
export async function enqueueRelayAction(db: Database, input: EnqueueRelayActionInput): Promise<EnqueueRelayActionResult> {
  const kind = relayKind(input.kind);
  const payload = parseRelayPayload(kind, input.payload);
  const requestedBy = requiredText("requestedBy", input.requestedBy, MAX_RELAY_FIELD_LENGTH);
  const origin = input.originNodeId ?? null;
  if (origin !== null && (typeof origin !== "string" || !UUID_RE.test(origin))) {
    throw new InvalidRelayActionError("originNodeId", origin, "must be a node uuid");
  }
  const target = targetOf(kind, payload);

  // The open action can finish between a refused insert and the lookup; a
  // short retry covers that race without a lock.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const inserted = await db.execute<RelayActionRow>(sql`
      INSERT INTO relay_actions (kind, payload, requested_by, origin_node_id)
      VALUES (${kind}, ${JSON.stringify(payload)}::jsonb, ${requestedBy}, ${origin}::uuid)
      ON CONFLICT (kind, (payload->>'project_key'), coalesce(payload->>'issue_id', ''))
        WHERE state IN ('queued', 'claimed') AND kind <> 'herdr_prompt'
        DO NOTHING
      RETURNING ${COLUMNS}
    `);
    const row = inserted.rows[0];
    if (row !== undefined) return { action: toAction(row), created: true };
    if (target === null) throw new Error("enqueueRelayAction: a herdr prompt conflicted on the open-target index, which excludes it");
    const open = await findOpenRelayAction(db, { kind, projectKey: target.projectKey, issueId: target.issueId });
    if (open === null) continue;
    if (kind === "beads_reingest") return { action: open, created: false };
    throw new RelayActionPendingError(kind, target.projectKey, target.issueId, open.id);
  }
  throw new Error("enqueueRelayAction: the open action on this target kept changing; try again");
}

// --- Claiming ----------------------------------------------------------------------------

export interface ClaimRelayActionInput {
  /** The claiming relay's name (its token client). */
  relay: string;
  /** The kinds it can run; every kind when omitted. */
  kinds?: readonly string[];
  /**
   * The project keys it serves. When given, an action whose payload names
   * a `project_key` is admitted only for one of these; an action with no
   * project (a herdr prompt) is admitted by kind alone. Every project when
   * omitted.
   */
  projects?: readonly string[];
  /**
   * Restricts the claim to these action ids. A test seam: a suite sharing a
   * database with live data claims only its own fixtures this way.
   */
  among?: readonly (number | string)[];
}

/**
 * Takes the oldest open action of an admitted kind (module header), or
 * returns null when there is none or a racing claim took it. Counts as the
 * relay's check-in either way.
 *
 * A locked row that cannot be claimed — claimed `MAX_RELAY_ATTEMPTS` times
 * without a report, or a stored payload that breaks its kind's schema — is
 * marked `failed` with the reason, and the claim moves on to the next
 * candidate in the same transaction, up to `MAX_RELAY_CLAIM_CANDIDATES`
 * rows, rather than handing the relay something it must not run. A review
 * decision or herdr prompt queued over `RELAY_MAX_AGE_S` ago is failed the
 * same way, as stale.
 */
export async function claimRelayAction(db: Database, input: ClaimRelayActionInput): Promise<ClaimedRelayAction | null> {
  const relay = relayName(input.relay);
  if (input.kinds !== undefined && (!Array.isArray(input.kinds) || input.kinds.length === 0)) {
    throw new InvalidRelayActionError("kinds", input.kinds, `must list at least one of ${RELAY_ACTION_KINDS.join(", ")}`);
  }
  const kinds = input.kinds === undefined ? [...RELAY_ACTION_KINDS] : [...new Set(input.kinds.map((k) => relayKind(k, "kinds")))];
  const among = input.among?.map(actionId);
  const projects = input.projects === undefined ? undefined : claimProjects(input.projects);

  const predicate: SQL = sql`state IN ('queued', 'claimed')
    AND (state = 'queued' OR claimed_at < now() - make_interval(secs => ${RELAY_RECLAIM_AFTER_S}))
    AND kind = ANY(${sqlArray(kinds, "text")})
    ${projects === undefined ? sql`` : sql`AND (payload->>'project_key' IS NULL OR payload->>'project_key' = ANY(${sqlArray(projects, "text")}))`}
    ${among === undefined ? sql`` : sql`AND id = ANY(${sqlArray(among, "bigint")})`}`;

  await touchCheckIn(db, relay);
  const probe = await db.execute(sql`SELECT 1 FROM relay_actions WHERE ${predicate} LIMIT 1`);
  if (probe.rows.length === 0) return null;

  return db.transaction(async (tx) => {
    for (let candidate = 0; candidate < MAX_RELAY_CLAIM_CANDIDATES; candidate += 1) {
      // A row this transaction marked failed no longer matches the predicate.
      const locked = await tx.execute<RelayActionRow & { stale: boolean }>(sql`
        SELECT ${COLUMNS}, (kind <> 'beads_reingest' AND created_at < now() - make_interval(secs => ${RELAY_MAX_AGE_S}))
          AS stale
        FROM relay_actions
        WHERE ${predicate}
        ORDER BY created_at, id
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `);
      const row = locked.rows[0];
      if (row === undefined) return null;

      let failure: string | null = null;
      let payload: RelayPayloads[RelayActionKind] | undefined;
      if (Number(row.attempts) >= MAX_RELAY_ATTEMPTS) {
        failure = ABANDONED_ERROR;
      } else if (row.stale) {
        failure = staleError(new Date(row.created_at));
      } else {
        try {
          payload = parseRelayPayload(row.kind, row.payload);
        } catch (err) {
          if (!(err instanceof InvalidRelayActionError)) throw err;
          failure = fitField(`could not be claimed: its stored payload breaks the ${row.kind} schema (${err.message})`, MAX_RELAY_ERROR_LENGTH);
        }
      }
      if (failure !== null) {
        await tx.execute(sql`UPDATE relay_actions SET state = 'failed', finished_at = now(), error = ${failure} WHERE id = ${row.id}::bigint`);
        continue;
      }

      const claimed = await tx.execute<RelayActionRow>(sql`
        UPDATE relay_actions
        SET state = 'claimed', claimed_by = ${relay}, claimed_at = now(), attempts = attempts + 1, error = NULL
        WHERE id = ${row.id}::bigint
        RETURNING ${COLUMNS}
      `);
      const updated = claimed.rows[0];
      if (updated === undefined) throw new Error(`claimRelayAction: relay action ${row.id} vanished under its row lock`);
      return { ...toAction(updated), payload } as ClaimedRelayAction;
    }
    return null;
  });
}

function claimProjects(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_RELAY_CLAIM_PROJECTS) {
    throw new InvalidRelayActionError("projects", value, `must list at most ${MAX_RELAY_CLAIM_PROJECTS} project keys`);
  }
  for (const key of value) {
    if (typeof key !== "string" || !PROJECT_KEY_PATTERN.test(key)) throw new InvalidRelayActionError("projects", key, `must be project keys matching ${PROJECT_KEY_PATTERN}`);
  }
  return [...new Set(value as string[])];
}

// --- Reporting ------------------------------------------------------------------------------

async function heldBy(db: Database, id: string, relay: string): Promise<never> {
  const found = await db.execute<{ state: RelayActionState; claimed_by: string | null }>(sql`SELECT state, claimed_by FROM relay_actions WHERE id = ${id}::bigint`);
  const row = found.rows[0];
  if (row === undefined) throw new RelayActionNotFoundError(id);
  throw new RelayActionNotClaimedByError(id, relay, row.state, row.claimed_by);
}

export interface RequeueRelayActionInput {
  relay: string;
  id: number | string;
  /** Why the relay gave the action back; kept in `error` until the next claim. */
  reason: string;
}

/**
 * Returns an action the relay holds to `queued`, giving back the claim's
 * attempt: the relay reported, so the claim was not abandoned. Refused for
 * an action the relay does not hold.
 */
export async function requeueRelayAction(db: Database, input: RequeueRelayActionInput): Promise<RelayAction> {
  const relay = relayName(input.relay);
  const id = actionId(input.id);
  const reason = requiredText("reason", input.reason, MAX_RELAY_REQUEUE_REASON_LENGTH);
  const result = await db.execute<RelayActionRow>(sql`
    UPDATE relay_actions
    SET state = 'queued', claimed_by = NULL, claimed_at = NULL, attempts = GREATEST(attempts - 1, 0), error = ${reason}
    WHERE id = ${id}::bigint AND state = 'claimed' AND claimed_by = ${relay}
    RETURNING ${COLUMNS}
  `);
  const row = result.rows[0];
  if (row === undefined) return heldBy(db, id, relay);
  return toAction(row);
}

export interface ReportRelayActionInput {
  relay: string;
  id: number | string;
  state: "done" | "failed";
  /** A JSON object describing what ran (`note: "already applied"`, the steps written). */
  result?: Record<string, unknown> | null;
  /** Required when failed; cut to `MAX_RELAY_ERROR_LENGTH`. */
  error?: string | null;
}

export interface ReportRelayActionResult {
  action: RelayAction;
  /** The action was already done or failed; nothing changed. */
  alreadyFinished: boolean;
}

/**
 * Finishes an action the relay holds. Idempotent: reporting an action
 * already finished changes nothing and answers `alreadyFinished`. Refused
 * with RelayActionNotClaimedByError for an action another relay holds or
 * one that is queued, and RelayActionNotFoundError for an unknown id.
 */
export async function reportRelayAction(db: Database, input: ReportRelayActionInput): Promise<ReportRelayActionResult> {
  const relay = relayName(input.relay);
  const id = actionId(input.id);
  if (input.state !== "done" && input.state !== "failed") {
    throw new InvalidRelayActionError("state", input.state, "must be done or failed");
  }
  let result: string | null = null;
  if (input.result !== undefined && input.result !== null) {
    if (typeof input.result !== "object" || Array.isArray(input.result)) throw new InvalidRelayActionError("result", input.result, "must be an object");
    result = JSON.stringify(input.result);
    if (result.length > MAX_RELAY_RESULT_CHARS) throw new InvalidRelayActionError("result", input.result, `must serialize to at most ${MAX_RELAY_RESULT_CHARS} characters`);
  }
  let error: string | null = null;
  if (input.error !== undefined && input.error !== null) {
    if (typeof input.error !== "string") throw new InvalidRelayActionError("error", input.error, "must be a string");
    error = fitField(input.error, MAX_RELAY_ERROR_LENGTH) || null;
  }
  if (input.state === "failed" && error === null) throw new InvalidRelayActionError("error", input.error, "is required when an action failed");
  if (input.state === "done" && error !== null) throw new InvalidRelayActionError("error", input.error, "is sent only when an action failed");

  const updated = await db.execute<RelayActionRow>(sql`
    UPDATE relay_actions
    SET state = ${input.state}, finished_at = now(), result = ${result}::jsonb, error = ${error}
    WHERE id = ${id}::bigint AND state = 'claimed' AND claimed_by = ${relay}
    RETURNING ${COLUMNS}
  `);
  const row = updated.rows[0];
  if (row !== undefined) return { action: toAction(row), alreadyFinished: false };
  const existing = await getRelayAction(db, id);
  if (existing === null) throw new RelayActionNotFoundError(id);
  if (existing.state === "done" || existing.state === "failed") return { action: existing, alreadyFinished: true };
  throw new RelayActionNotClaimedByError(id, relay, existing.state, existing.claimedBy);
}

// --- Check-ins and status ------------------------------------------------------------------

/** A claim's check-in: only the time moves. */
async function touchCheckIn(db: Database, relay: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO relay_check_ins (relay) VALUES (${relay})
    ON CONFLICT (relay) DO UPDATE SET last_seen_at = now()
  `);
}

export interface RecordRelayCheckInInput {
  relay: string;
  version?: string | null;
}

/** Records a check-in at the database's `now()`; returns the interval the relay should check in on, and that `now()`. */
export async function recordRelayCheckIn(db: Database, input: RecordRelayCheckInInput): Promise<{ intervalS: number; now: Date }> {
  const relay = relayName(input.relay);
  const version = input.version === undefined || input.version === null || input.version.trim() === "" ? null : requiredText("version", input.version, MAX_RELAY_FIELD_LENGTH);
  const result = await db.execute<{ interval_s: number; last_seen_at: string | Date }>(sql`
    INSERT INTO relay_check_ins (relay, last_seen_at, version)
    VALUES (${relay}, now(), ${version})
    ON CONFLICT (relay) DO UPDATE SET last_seen_at = now(), version = excluded.version
    RETURNING interval_s, last_seen_at
  `);
  const row = result.rows[0];
  if (!row) throw new Error("recordRelayCheckIn: the upsert returned no row");
  return { intervalS: Number(row.interval_s), now: new Date(row.last_seen_at) };
}

export type RelayLiveness =
  | { state: "online"; lastSeenAt: Date }
  | { state: "offline"; lastSeenAt: Date }
  | { state: "never"; lastSeenAt: null };

/**
 * Online while `now - lastSeenAt` is under three check-in intervals,
 * offline since `lastSeenAt` from then on, never with no check-in. Pure;
 * `now` is the database's.
 */
export function classifyRelayStatus(row: { lastSeenAt: Date; intervalS: number } | null, now: Date): RelayLiveness {
  if (row === null) return { state: "never", lastSeenAt: null };
  const ageMs = now.getTime() - row.lastSeenAt.getTime();
  return ageMs < 3 * row.intervalS * 1000 ? { state: "online", lastSeenAt: row.lastSeenAt } : { state: "offline", lastSeenAt: row.lastSeenAt };
}

export type RelayStatus = RelayLiveness & {
  /** The relay the status is about: the named one, or the most recent to check in; null when none has. */
  relay: string | null;
  version: string | null;
  intervalS: number;
  /** The database's clock when the status was read. */
  now: Date;
  /** Open actions across every relay. */
  counts: { queued: number; claimed: number };
};

/** The relay's status (the named relay, or the most recent check-in) and the open action counts. One statement. */
export async function getRelayStatus(db: Database, options: { relay?: string } = {}): Promise<RelayStatus> {
  const relay = options.relay === undefined ? undefined : relayName(options.relay);
  const result = await db.execute<{
    now: string | Date;
    relay: string | null;
    last_seen_at: string | Date | null;
    version: string | null;
    interval_s: number | null;
    queued: string | number;
    claimed: string | number;
  }>(sql`
    SELECT now() AS now, c.relay, c.last_seen_at, c.version, c.interval_s, k.queued, k.claimed
    FROM (SELECT 1) one
    LEFT JOIN LATERAL (
      SELECT relay, last_seen_at, version, interval_s FROM relay_check_ins
      ${relay === undefined ? sql`` : sql`WHERE relay = ${relay}`}
      ORDER BY last_seen_at DESC, relay
      LIMIT 1
    ) c ON true
    CROSS JOIN (
      SELECT count(*) FILTER (WHERE state = 'queued') AS queued,
             count(*) FILTER (WHERE state = 'claimed') AS claimed
      FROM relay_actions WHERE state IN ('queued', 'claimed')
    ) k
  `);
  const row = result.rows[0];
  if (!row) throw new Error("getRelayStatus: the status query returned no row");
  const now = new Date(row.now);
  const intervalS = row.interval_s === null ? RELAY_CHECK_IN_INTERVAL_S : Number(row.interval_s);
  const liveness = classifyRelayStatus(row.last_seen_at === null ? null : { lastSeenAt: new Date(row.last_seen_at), intervalS }, now);
  return {
    ...liveness,
    relay: row.relay,
    version: row.version,
    intervalS,
    now,
    counts: { queued: Number(row.queued), claimed: Number(row.claimed) },
  };
}
