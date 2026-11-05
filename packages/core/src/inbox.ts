// The inbox (review queue for things that need a person): every item an
// agent has triaged out of email, Asana, Slack, Notion, Google Docs,
// GitHub, Fathom, or a live session, waiting on the person's decision.
//
// An inbox item is an ordinary node of type `inbox_item`, written by an
// agent through `brain_write` (the ingest skill, .claude/skills/inbox-ingest)
// under source system `inbox`, keyed on the canonical artifact the signal is
// about (`asana:task/<gid>`, `gmail:thread/<id>`, `github:<owner>/<repo>#<n>`).
// That key is the dedupe: an email notification and a Notion comment about
// the same page upsert the same node, and the agent folds both into `links`.
//
// `content` is markdown the person reads: what happened, then the proposed
// action (the draft reply, the ticket body, the review comments). Metadata
// obeys the contract below, enforced by `normalizeInboxItemMetadata` at every
// writer (the MCP write tool, `decideInboxItem`), never by the database, so
// `node_type` stays open text.
//
// Status is whose turn it is:
//   pending   — the person's: decide accept / changes / dismiss
//   changes   — the agent's: revise per the latest feedback, then set pending
//   accepted  — the executor's: carry out the proposed action, then set done
//   dismissed — closed by the person, nothing to do
//   done      — closed: the action ran (or the source resolved on its own)
//
// A batch (one Fathom recap → many candidates) is a parent inbox item with
// its candidates linked `child_of` it, the containment relation every other
// hierarchy in the store uses. The queue lists top-level items; a parent's
// candidates come with it.
//
// The app makes no model call: deciding is a pure Postgres write that
// records the decision and flips the status. Carrying out an accepted action
// is a Claude session's job (.claude/skills/inbox-execute), reading accepted
// items through `brain_list`.

import { sql } from "drizzle-orm";
import type { Database } from "@breakdown/db";
import {
  InboxDecisionConflictError,
  InvalidInboxItemError,
  InvalidLookupIdError,
  InvalidLookupOptionError,
  LookupFailedError,
  NodeNotFoundError,
  NodeUpsertFailedError,
  NotAnInboxItemError,
} from "./errors.js";
import { normalizeOccurredAt } from "./event-time.js";
import { closeIngestRun, openIngestRun } from "./ingest-runs.js";
import {
  DEFAULT_MAX_CONTENT_LENGTH,
  DEFAULT_MAX_METADATA_LENGTH,
  DEFAULT_MAX_TITLE_LENGTH,
  type UpsertNodeRow,
  unsafeBuildUpsertNodesQuery,
  unsafePrepareNodes,
  unsafeWrapNodeWriteError,
} from "./nodes.js";
import { asPgError, formatPgInfo, sqlArray } from "./sql-helpers.js";

// --- Contract ---------------------------------------------------------------

export const INBOX_ITEM_NODE_TYPE = "inbox_item";
export const INBOX_SOURCE_SYSTEM = "inbox";
export const INBOX_STATUSES = ["pending", "changes", "accepted", "dismissed", "done"] as const;
export type InboxStatus = (typeof INBOX_STATUSES)[number];
export const OPEN_INBOX_STATUSES: readonly InboxStatus[] = ["pending", "changes", "accepted"];
export const INBOX_DECISIONS = ["accept", "changes", "dismiss"] as const;
export type InboxDecision = (typeof INBOX_DECISIONS)[number];

export const MAX_INBOX_LINKS = 20;
export const MAX_INBOX_FEEDBACK = 50;
export const MAX_INBOX_FEEDBACK_LENGTH = 4000;
export const MAX_INBOX_SHORT_TEXT = 200;
export const MAX_INBOX_URL_LENGTH = 2000;

export interface InboxLink {
  label: string;
  url: string;
}

export interface InboxFeedback {
  decision: InboxDecision;
  message: string;
  /** `toISOString()` form. */
  at: string;
}

export interface InboxItemFields {
  status: InboxStatus;
  /** Where the signal came from: gmail, asana, slack, notion, gdocs, github, fathom, session, … */
  source: string;
  /** The primary link to the artifact, when there is one. */
  url: string | null;
  /** Who it is from or who raised it. */
  from: string | null;
  /** The proposed action's kind: reply, create_task, comment, review, update, decide, ignore, none, … */
  action: string;
  /** 0 (urgent) … 4 (whenever); default 2. */
  priority: number;
  /** Optional triage verdict for a batch candidate (already_tracked, not_actionable, not_mine, knowledge, new_action). */
  verdict: string | null;
  /** Every signal folded into this item. */
  links: InboxLink[];
  /** The person's decisions, oldest first. */
  feedback: InboxFeedback[];
}

const CONTROL_CHAR = /[\u0000-\u0008\u000b-\u001f\u007f]/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shortText(raw: unknown, field: string, itemLabel: string | undefined, options: { required?: boolean; max?: number } = {}): string | null {
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) {
    if (options.required) throw new InvalidInboxItemError(field, raw, "is required", itemLabel);
    return null;
  }
  const max = options.max ?? MAX_INBOX_SHORT_TEXT;
  if (typeof raw !== "string" || CONTROL_CHAR.test(raw) || raw.trim().length > max) {
    throw new InvalidInboxItemError(field, raw, `must be a string of at most ${max} characters without control characters`, itemLabel);
  }
  return raw.trim();
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

function url(raw: unknown, field: string, itemLabel: string | undefined): string | null {
  const text = shortText(raw, field, itemLabel, { max: MAX_INBOX_URL_LENGTH });
  if (text !== null && !isHttpUrl(text)) throw new InvalidInboxItemError(field, raw, "must be an http(s) URL", itemLabel);
  return text;
}

/**
 * The inbox contract over a raw metadata document. Known keys are
 * validated and written canonically; unknown keys pass through untouched
 * (an agent may keep its own bookkeeping, e.g. `source_ids`). Throws
 * `InvalidInboxItemError` naming the field. Idempotent.
 */
export function normalizeInboxItemMetadata(raw: Record<string, unknown> | undefined, options: { itemLabel?: string } = {}): Record<string, unknown> {
  const { itemLabel } = options;
  const metadata: Record<string, unknown> = { ...(raw ?? {}) };

  const status = metadata["status"] ?? "pending";
  if (typeof status !== "string" || !(INBOX_STATUSES as readonly string[]).includes(status)) {
    throw new InvalidInboxItemError("status", status, `must be one of ${INBOX_STATUSES.join(", ")}`, itemLabel);
  }
  metadata["status"] = status;
  metadata["source"] = shortText(metadata["source"], "source", itemLabel, { required: true, max: 64 })!.toLowerCase();
  metadata["action"] = (shortText(metadata["action"], "action", itemLabel, { max: 64 }) ?? "none").toLowerCase();

  for (const key of ["url"] as const) {
    const value = url(metadata[key], key, itemLabel);
    if (value === null) delete metadata[key];
    else metadata[key] = value;
  }
  for (const key of ["from", "verdict"] as const) {
    const value = shortText(metadata[key], key, itemLabel);
    if (value === null) delete metadata[key];
    else metadata[key] = value;
  }

  const priority = metadata["priority"] ?? 2;
  if (typeof priority !== "number" || !Number.isInteger(priority) || priority < 0 || priority > 4) {
    throw new InvalidInboxItemError("priority", priority, "must be an integer from 0 to 4", itemLabel);
  }
  metadata["priority"] = priority;

  const rawLinks = metadata["links"] ?? [];
  if (!Array.isArray(rawLinks) || rawLinks.length > MAX_INBOX_LINKS) {
    throw new InvalidInboxItemError("links", rawLinks, `must be an array of at most ${MAX_INBOX_LINKS} {label, url} objects`, itemLabel);
  }
  metadata["links"] = rawLinks.map((link, i): InboxLink => {
    if (!isPlainObject(link)) throw new InvalidInboxItemError(`links[${i}]`, link, "must be a {label, url} object", itemLabel);
    return {
      label: shortText(link["label"], `links[${i}].label`, itemLabel, { required: true })!,
      url: url(link["url"], `links[${i}].url`, itemLabel) ?? (() => {
        throw new InvalidInboxItemError(`links[${i}].url`, link["url"], "is required", itemLabel);
      })(),
    };
  });

  const rawFeedback = metadata["feedback"] ?? [];
  if (!Array.isArray(rawFeedback)) {
    throw new InvalidInboxItemError("feedback", rawFeedback, "must be an array", itemLabel);
  }
  metadata["feedback"] = rawFeedback.slice(-MAX_INBOX_FEEDBACK).map((entry, i): InboxFeedback => {
    if (!isPlainObject(entry)) throw new InvalidInboxItemError(`feedback[${i}]`, entry, "must be a {decision, message, at} object", itemLabel);
    const decision = entry["decision"];
    if (typeof decision !== "string" || !(INBOX_DECISIONS as readonly string[]).includes(decision)) {
      throw new InvalidInboxItemError(`feedback[${i}].decision`, decision, `must be one of ${INBOX_DECISIONS.join(", ")}`, itemLabel);
    }
    const message = entry["message"] ?? "";
    if (typeof message !== "string" || message.length > MAX_INBOX_FEEDBACK_LENGTH) {
      throw new InvalidInboxItemError(`feedback[${i}].message`, message, `must be a string of at most ${MAX_INBOX_FEEDBACK_LENGTH} characters`, itemLabel);
    }
    const at = typeof entry["at"] === "string" ? new Date(entry["at"]) : null;
    if (at === null || Number.isNaN(at.getTime())) {
      throw new InvalidInboxItemError(`feedback[${i}].at`, entry["at"], "must be an ISO-8601 timestamp", itemLabel);
    }
    return { decision: decision as InboxDecision, message, at: at.toISOString() };
  });

  return metadata;
}

/** The contract's fields read off already-normalized metadata. */
export function readInboxItemFields(metadata: Record<string, unknown>): InboxItemFields {
  return {
    status: metadata["status"] as InboxStatus,
    source: metadata["source"] as string,
    url: (metadata["url"] as string | undefined) ?? null,
    from: (metadata["from"] as string | undefined) ?? null,
    action: metadata["action"] as string,
    priority: metadata["priority"] as number,
    verdict: (metadata["verdict"] as string | undefined) ?? null,
    links: metadata["links"] as InboxLink[],
    feedback: metadata["feedback"] as InboxFeedback[],
  };
}

// --- The queue ----------------------------------------------------------------

export const MAX_INBOX_ITEMS = 500;

export interface InboxItem extends InboxItemFields {
  id: string;
  externalId: string;
  title: string;
  content: string;
  /** `occurred_at` when present, else when the row was first written. */
  receivedAt: Date;
  updatedAt: Date;
  /** The batch this item is a candidate of, when it is one. */
  parentId: string | null;
}

export interface ListInboxOptions {
  /** Statuses to include; defaults to the open ones (pending, changes, accepted). */
  statuses?: readonly InboxStatus[];
  limit?: number;
}

export interface InboxList {
  /** Priority, then oldest first. Candidates of a batch are included and carry `parentId`. */
  items: InboxItem[];
  total: number;
  truncated: boolean;
}

type RawInboxRow = {
  id: string;
  external_id: string;
  title: string;
  content: string;
  metadata: Record<string, unknown>;
  received_at: string;
  updated_at: string;
  parent_id: string | null;
  total: string | number;
};

/** The inbox in one statement. Rows whose metadata breaks the contract are skipped, not fatal. */
export async function listInbox(db: Database, options: ListInboxOptions = {}): Promise<InboxList> {
  const limit = options.limit ?? MAX_INBOX_ITEMS;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_INBOX_ITEMS) {
    throw new InvalidLookupOptionError("limit", limit, `must be an integer from 1 to ${MAX_INBOX_ITEMS}`);
  }
  const statuses = options.statuses ?? OPEN_INBOX_STATUSES;
  for (const s of statuses) {
    if (!(INBOX_STATUSES as readonly string[]).includes(s)) {
      throw new InvalidLookupOptionError("statuses", statuses, `must hold only ${INBOX_STATUSES.join(", ")}`);
    }
  }
  if (statuses.length === 0) return { items: [], total: 0, truncated: false };

  let result: { rows: RawInboxRow[] };
  try {
    result = await db.execute<RawInboxRow>(sql`
SELECT n.id, n.external_id, n.title, n.content, n.metadata,
       to_char(COALESCE(
         CASE WHEN n.metadata->>'occurred_at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]{12}Z$'
              THEN (n.metadata->>'occurred_at')::timestamptz END,
         n.created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS received_at,
       to_char(n.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at,
       (SELECT p.id FROM edges e
          JOIN resolved_nodes p ON p.id = COALESCE((SELECT merged_into FROM nodes WHERE id = e.dst_id), e.dst_id)
         WHERE e.edge_type = 'child_of' AND e.src_id = n.id AND p.node_type = ${INBOX_ITEM_NODE_TYPE}
         LIMIT 1) AS parent_id,
       count(*) OVER () AS total
FROM resolved_nodes n
WHERE n.node_type = ${INBOX_ITEM_NODE_TYPE}
  AND COALESCE(n.metadata->>'status', 'pending') = ANY (${sqlArray(statuses, "text")})
ORDER BY CASE WHEN jsonb_typeof(n.metadata->'priority') = 'number' THEN (n.metadata->>'priority')::int ELSE 2 END,
         received_at, n.id
LIMIT ${limit}::int
`);
  } catch (err) {
    throw new LookupFailedError(`listInbox query failed${formatPgInfo(asPgError(err))}`, "listInbox", { cause: err });
  }

  const items: InboxItem[] = [];
  for (const r of result.rows) {
    let fields: InboxItemFields;
    try {
      fields = readInboxItemFields(normalizeInboxItemMetadata(r.metadata));
    } catch {
      continue;
    }
    items.push({
      ...fields,
      id: r.id,
      externalId: r.external_id,
      title: r.title,
      content: r.content,
      receivedAt: new Date(r.received_at),
      updatedAt: new Date(r.updated_at),
      parentId: r.parent_id,
    });
  }
  const total = result.rows.length === 0 ? 0 : Number(result.rows[0]!.total);
  return { items, total, truncated: total > result.rows.length };
}

// --- Deciding -----------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DecideInboxItemInput {
  decision: InboxDecision;
  /** Required for `changes`; optional otherwise. */
  message?: string;
  /** The decision's timestamp; defaults to now (tests pin it). */
  now?: Date;
}

export interface DecideInboxItemResult {
  id: string;
  ingestRunId: string;
  before: InboxStatus;
  after: InboxStatus;
}

const NEXT_STATUS: Record<InboxDecision, InboxStatus> = { accept: "accepted", changes: "changes", dismiss: "dismissed" };

/**
 * Records the person's decision on an inbox item and moves it to the next
 * turn: accept → accepted, changes → changes, dismiss → dismissed. Only a
 * `pending` item takes accept or changes; dismiss is taken from any open
 * status (the person can drop something an agent is still working on).
 * Row-locked, written through the upsert path under a `human` ingest run,
 * so the revision trigger keeps the history. Pure Postgres.
 */
export async function decideInboxItem(db: Database, id: string, input: DecideInboxItemInput): Promise<DecideInboxItemResult> {
  const requestedId = typeof id === "string" ? id.trim() : "";
  if (!UUID_RE.test(requestedId)) throw new InvalidLookupIdError(id, "must be a valid uuid");
  if (!(INBOX_DECISIONS as readonly string[]).includes(input.decision)) {
    throw new InvalidInboxItemError("decision", input.decision, `must be one of ${INBOX_DECISIONS.join(", ")}`);
  }
  const message = (input.message ?? "").trim();
  if (input.decision === "changes" && message === "") {
    throw new InvalidInboxItemError("message", input.message, "is required when requesting changes — say what needs to change");
  }
  if (message.length > MAX_INBOX_FEEDBACK_LENGTH) {
    throw new InvalidInboxItemError("message", `${message.slice(0, 40)}…`, `must be at most ${MAX_INBOX_FEEDBACK_LENGTH} characters`);
  }

  const run = await openIngestRun(db, "human", { actor: "human" });
  try {
    return await db.transaction(async (tx) => {
      let locked: { rows: { id: string; node_type: string; source_system: string; external_id: string; title: string; content: string; metadata: Record<string, unknown> }[] };
      try {
        locked = await tx.execute(sql`
          SELECT id, node_type, source_system, external_id, title, content, metadata
          FROM nodes WHERE id = (SELECT COALESCE(merged_into, id) FROM nodes WHERE id = ${requestedId}::uuid)
          FOR UPDATE
        `);
      } catch (err) {
        throw new LookupFailedError(`decideInboxItem lock failed${formatPgInfo(asPgError(err))}`, "decideInboxItem", { cause: err });
      }
      const existing = locked.rows[0];
      if (!existing) throw new NodeNotFoundError(requestedId);
      if (existing.node_type !== INBOX_ITEM_NODE_TYPE) throw new NotAnInboxItemError(existing.id, existing.node_type);

      const current = normalizeInboxItemMetadata(normalizeOccurredAt(existing.metadata));
      const before = current["status"] as InboxStatus;
      const allowed = input.decision === "dismiss" ? OPEN_INBOX_STATUSES.includes(before) : before === "pending";
      if (!allowed) throw new InboxDecisionConflictError(existing.id, before);

      const after = NEXT_STATUS[input.decision];
      const feedback = [...(current["feedback"] as InboxFeedback[]), { decision: input.decision, message, at: (input.now ?? new Date()).toISOString() }];
      const { needs_you: _handedBack, ...rest } = current;
      const metadata = normalizeInboxItemMetadata({ ...rest, status: after, feedback });

      const prepared = unsafePrepareNodes(
        [{ nodeType: existing.node_type, sourceSystem: existing.source_system, externalId: existing.external_id, title: existing.title, content: existing.content, metadata }],
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
      if (!row) throw new NodeUpsertFailedError(`decideInboxItem: upsert returned no row for node ${existing.id}`, 0, 0);
      return { id: row.id, ingestRunId: run.id, before, after };
    });
  } finally {
    await closeIngestRun(db, run);
  }
}

// --- Re-ingest safety -----------------------------------------------------------

/** Statuses a re-ingest's `pending` never overrides: the person or executor already moved them on. */
const SETTLED_BY_PERSON: readonly InboxStatus[] = ["accepted", "dismissed", "done"];

/**
 * The person's decisions survive an agent's re-write of the same item.
 * `feedback` is the person's: the stored history is kept whenever the
 * incoming one is shorter (an agent that did not carry it forward cannot
 * drop it). A stored accepted/dismissed/done status is not reset by an
 * incoming `pending` — re-ingesting a signal the person already decided
 * must not put it back in front of them. Any other incoming status (the
 * agent moving changes → pending after a revision, accepted → done after
 * executing) is the agent's to set. Pure; both inputs normalized.
 */
export function carryForwardInboxDecisions(incoming: Record<string, unknown>, stored: Record<string, unknown> | null): Record<string, unknown> {
  if (stored === null) return incoming;
  const merged = { ...incoming };
  const storedFeedback = (stored["feedback"] as InboxFeedback[] | undefined) ?? [];
  if (((incoming["feedback"] as InboxFeedback[] | undefined) ?? []).length < storedFeedback.length) merged["feedback"] = storedFeedback;
  // An executor that cannot carry out an accepted item hands it back by
  // setting `needs_you` (why); that is the one way pending overrides accepted.
  const handBack = stored["status"] === "accepted" && typeof incoming["needs_you"] === "string" && incoming["needs_you"].trim() !== "";
  if (incoming["status"] === "pending" && SETTLED_BY_PERSON.includes(stored["status"] as InboxStatus) && !handBack) merged["status"] = stored["status"];
  return merged;
}

/** Stored metadata of the inbox items these (source system, external id) pairs name, keyed `${sourceSystem}\u0000${externalId}`; contract-breaking rows are skipped. */
export async function loadStoredInboxMetadata(db: Database, pairs: readonly { sourceSystem: string; externalId: string }[]): Promise<Map<string, Record<string, unknown>>> {
  const map = new Map<string, Record<string, unknown>>();
  if (pairs.length === 0) return map;
  let result: { rows: { source_system: string; external_id: string; metadata: Record<string, unknown> }[] };
  try {
    result = await db.execute(sql`
SELECT n.source_system, n.external_id, n.metadata FROM nodes n
WHERE n.node_type = ${INBOX_ITEM_NODE_TYPE}
  AND (n.source_system, n.external_id) IN (${sql.join(
    pairs.map((p) => sql`(${p.sourceSystem}, ${p.externalId})`),
    sql.raw(", "),
  )})`);
  } catch (err) {
    throw new LookupFailedError(`loadStoredInboxMetadata query failed${formatPgInfo(asPgError(err))}`, "listInbox", { cause: err });
  }
  for (const r of result.rows) {
    try {
      map.set(`${r.source_system}\u0000${r.external_id}`, normalizeInboxItemMetadata(r.metadata));
    } catch {
      // A stored row past the contract carries nothing forward.
    }
  }
  return map;
}
