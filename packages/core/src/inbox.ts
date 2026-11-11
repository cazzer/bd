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
//   changes   — the agent's: triage the latest note into close (done),
//               act (carry it out, done), or re-queue (pending, with a
//               `revision` line) — inbox-follow-through, design.md decision 3
//   accepted  — the executor's: carry out the proposed action, then set done
//   session   — handed to an interactive Claude session the person opened on
//               it (herdr tab); the session re-queues a draft as pending, or
//               closes it done itself
//   undigested — held back from the person: the item has a primary `url`
//               its agent did not declare reading (`read`); the next ingest
//               pass digests it, or the person releases or dismisses it
//               (unify-review-queues, inbox-digestion)
//   dismissed — closed by the person, nothing to do
//   done      — closed: the action ran (or the source resolved on its own)
//
// A batch (one Fathom recap → many candidates) is a parent inbox item with
// its candidates linked `child_of` it, the containment relation every other
// hierarchy in the store uses. The queue lists top-level items; a parent's
// candidates come with it.
//
// An item may carry a decision card (`question`, `options`, `recommend`,
// `on_accept`) under the review card's rules (reviews.ts
// `normalizeDecisionCard`); accepting a card with options names one, and
// the feedback entry records it. `read` lists what the agent opened, each
// `{ ref, depth: full | skimmed }`; it is declared, not verified — the app
// cannot judge a reading — but an item whose `url` it does not cover is
// written `undigested` instead of `pending` (carryForwardInboxDecisions).
//
// The app makes no model call: deciding is a pure Postgres write that
// records the decision and flips the status. Carrying out an accepted action
// is a Claude session's job (.claude/skills/inbox-execute), reading accepted
// items through `brain_list`.

import { sql } from "drizzle-orm";
import { ABOUT_EDGE_TYPE } from "./work-context.js";
import { WORK_ITEM_NODE_TYPE } from "./work-items.js";
import type { Database } from "@breakdown/db";
import {
  InboxCardChangedError,
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
import { normalizeDecisionCard, REVIEW_OPTION_ID_PATTERN, type ReviewOption } from "./reviews.js";
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
export const INBOX_STATUSES = ["pending", "changes", "accepted", "session", "undigested", "dismissed", "done"] as const;
export type InboxStatus = (typeof INBOX_STATUSES)[number];
export const OPEN_INBOX_STATUSES: readonly InboxStatus[] = ["pending", "changes", "accepted", "session"];
export const INBOX_DECISIONS = ["accept", "changes", "dismiss"] as const;
export type InboxDecision = (typeof INBOX_DECISIONS)[number];
/** What a feedback entry can record: the person's decisions, handing the item to an interactive session, and releasing an undigested item by hand. */
export const INBOX_FEEDBACK_KINDS = [...INBOX_DECISIONS, "session", "release"] as const;
export type InboxFeedbackKind = (typeof INBOX_FEEDBACK_KINDS)[number];
/** Statuses an item can be handed to an interactive session from (session again: the earlier one was closed). */
export const INBOX_HANDOFF_STATUSES: readonly InboxStatus[] = ["pending", "changes", "session", "undigested"];
/** Statuses the person can dismiss from: every open one, and an item held undigested. */
export const INBOX_DISMISSABLE_STATUSES: readonly InboxStatus[] = [...OPEN_INBOX_STATUSES, "undigested"];

export const MAX_INBOX_LINKS = 20;
export const MAX_INBOX_FEEDBACK = 50;
export const MAX_INBOX_FEEDBACK_LENGTH = 4000;
export const MAX_INBOX_SHORT_TEXT = 200;
export const MAX_INBOX_URL_LENGTH = 2000;
export const MAX_INBOX_READ = 20;
export const MAX_INBOX_READ_REF_LENGTH = 500;
/** `revision`: the agent's one line on what it changed when it re-queues an item the person sent back. */
export const MAX_INBOX_REVISION_LENGTH = 200;
/** `close_reason`: why an agent closed an item on the person's note (usually the note itself). */
export const MAX_INBOX_CLOSE_REASON_LENGTH = 500;
export const INBOX_READ_DEPTHS = ["full", "skimmed"] as const;
export type InboxReadDepth = (typeof INBOX_READ_DEPTHS)[number];

/** One artifact the agent declares it opened before writing the item. */
export interface InboxRead {
  /** A URL or a canonical key. */
  ref: string;
  depth: InboxReadDepth;
}

export interface InboxLink {
  label: string;
  url: string;
}

export interface InboxFeedback {
  decision: InboxFeedbackKind;
  message: string;
  /** `toISOString()` form. */
  at: string;
  /** The card option an accept chose; present only then. */
  option?: string;
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
  /** The herdr tab of the interactive session the item was handed to, while it is (or was) in one. */
  sessionTab: string | null;
  /** The herdr pane of the live session that owns the item (queued it, or was opened on it); such items are that session's to carry out. */
  pane: string | null;
  /** The decision card's question; null when the item carries none (it reads as its title). */
  question: string | null;
  options: ReviewOption[];
  recommend: string | null;
  onAccept: string[];
  /** What the agent declared it opened. */
  read: InboxRead[];
  /** The agent's one line on what changed when it re-queued the item after the person's note; cleared by the next decision. */
  revision: string | null;
  /** Why an agent closed the item on the person's note. */
  closeReason: string | null;
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
  for (const [key, max] of [["revision", MAX_INBOX_REVISION_LENGTH], ["close_reason", MAX_INBOX_CLOSE_REASON_LENGTH]] as const) {
    const value = shortText(metadata[key], key, itemLabel, { max });
    if (key === "revision" && value !== null && /[\n\t]/.test(value)) {
      throw new InvalidInboxItemError(key, metadata[key], "must be one line", itemLabel);
    }
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

  normalizeInboxCard(metadata, itemLabel);

  const rawRead = metadata["read"] ?? [];
  if (!Array.isArray(rawRead) || rawRead.length > MAX_INBOX_READ) {
    throw new InvalidInboxItemError("read", rawRead, `must be an array of at most ${MAX_INBOX_READ} {ref, depth} objects`, itemLabel);
  }
  metadata["read"] = rawRead.map((entry, i): InboxRead => {
    if (!isPlainObject(entry)) throw new InvalidInboxItemError(`read[${i}]`, entry, "must be a {ref, depth} object", itemLabel);
    const depth = entry["depth"];
    if (typeof depth !== "string" || !(INBOX_READ_DEPTHS as readonly string[]).includes(depth)) {
      throw new InvalidInboxItemError(`read[${i}].depth`, depth, `must be one of ${INBOX_READ_DEPTHS.join(", ")}`, itemLabel);
    }
    return { ref: shortText(entry["ref"], `read[${i}].ref`, itemLabel, { required: true, max: MAX_INBOX_READ_REF_LENGTH })!, depth: depth as InboxReadDepth };
  });

  const rawFeedback = metadata["feedback"] ?? [];
  if (!Array.isArray(rawFeedback)) {
    throw new InvalidInboxItemError("feedback", rawFeedback, "must be an array", itemLabel);
  }
  metadata["feedback"] = rawFeedback.slice(-MAX_INBOX_FEEDBACK).map((entry, i): InboxFeedback => {
    if (!isPlainObject(entry)) throw new InvalidInboxItemError(`feedback[${i}]`, entry, "must be a {decision, message, at} object", itemLabel);
    const decision = entry["decision"];
    if (typeof decision !== "string" || !(INBOX_FEEDBACK_KINDS as readonly string[]).includes(decision)) {
      throw new InvalidInboxItemError(`feedback[${i}].decision`, decision, `must be one of ${INBOX_FEEDBACK_KINDS.join(", ")}`, itemLabel);
    }
    const message = entry["message"] ?? "";
    if (typeof message !== "string" || message.length > MAX_INBOX_FEEDBACK_LENGTH) {
      throw new InvalidInboxItemError(`feedback[${i}].message`, message, `must be a string of at most ${MAX_INBOX_FEEDBACK_LENGTH} characters`, itemLabel);
    }
    const at = typeof entry["at"] === "string" ? new Date(entry["at"]) : null;
    if (at === null || Number.isNaN(at.getTime())) {
      throw new InvalidInboxItemError(`feedback[${i}].at`, entry["at"], "must be an ISO-8601 timestamp", itemLabel);
    }
    const option = entry["option"];
    if (option !== undefined && option !== null && (typeof option !== "string" || !REVIEW_OPTION_ID_PATTERN.test(option))) {
      throw new InvalidInboxItemError(`feedback[${i}].option`, option, `must be an option id matching ${REVIEW_OPTION_ID_PATTERN}`, itemLabel);
    }
    const base = { decision: decision as InboxFeedbackKind, message, at: at.toISOString() };
    return typeof option === "string" ? { ...base, option } : base;
  });

  return metadata;
}

const CARD_KEYS = ["question", "options", "recommend", "on_accept"] as const;

const CARD_KEY_REASON: Record<(typeof CARD_KEYS)[number], string> = {
  question: "must be a string",
  options: `must be 2 to 6 {id, label, what?, risk?} objects with unique ids matching ${REVIEW_OPTION_ID_PATTERN}`,
  recommend: "must be the id of one of the item's options",
  on_accept: "must be a list of at most 8 strings",
};

/** The card keys, through the review card's normalizer (in place); refused naming the first key that breaks it. Attachments are not an inbox card's. */
function normalizeInboxCard(metadata: Record<string, unknown>, itemLabel: string | undefined): void {
  const raw: Record<string, unknown> = {};
  for (const key of CARD_KEYS) if (metadata[key] !== undefined) raw[key] = metadata[key];
  const card = normalizeDecisionCard(raw);
  if (card === null) {
    const field = (["question", "options", "on_accept"] as const).find((k) => normalizeDecisionCard({ [k]: raw[k] }) === null) ?? "recommend";
    throw new InvalidInboxItemError(field, raw[field], CARD_KEY_REASON[field], itemLabel);
  }
  for (const key of CARD_KEYS) {
    if (card[key] === undefined) delete metadata[key];
    else metadata[key] = card[key];
  }
}

function withoutTrailingSlash(u: string): string {
  return u.endsWith("/") ? u.slice(0, -1) : u;
}

/**
 * Whether the item's declared reads cover its primary `url`: a `ref` equal
 * to it, or under it (a PR's `/files`, a doc's `#heading`, a `?tab=`). An
 * item without a `url` has nothing to cover. Normalized metadata.
 */
export function inboxItemDigested(metadata: Record<string, unknown>): boolean {
  const primary = metadata["url"];
  if (typeof primary !== "string") return true;
  const base = withoutTrailingSlash(primary);
  const read = (metadata["read"] as InboxRead[] | undefined) ?? [];
  // The url's resource without a position in it (`?timestamp=99`, `#heading`):
  // reading the whole resource covers any position within it, so a Fathom
  // candidate linking a moment of a call is covered by reading the call.
  const resource = withoutTrailingSlash(base.split(/[?#]/, 1)[0]!);
  return read.some((r) => {
    const ref = withoutTrailingSlash(r.ref);
    return ref === base || ref.startsWith(`${base}/`) || ref.startsWith(`${base}#`) || ref.startsWith(`${base}?`) || ref === resource;
  });
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
    sessionTab: typeof metadata["session_tab"] === "string" ? metadata["session_tab"] : null,
    pane: typeof metadata["pane"] === "string" ? metadata["pane"] : null,
    question: (metadata["question"] as string | undefined) ?? null,
    options: (metadata["options"] as ReviewOption[] | undefined) ?? [],
    recommend: (metadata["recommend"] as string | undefined) ?? null,
    onAccept: (metadata["on_accept"] as string[] | undefined) ?? [],
    read: (metadata["read"] as InboxRead[] | undefined) ?? [],
    revision: (metadata["revision"] as string | undefined) ?? null,
    closeReason: (metadata["close_reason"] as string | undefined) ?? null,
  };
}

// --- The queue ----------------------------------------------------------------

export const MAX_INBOX_ITEMS = 500;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  /** The work item this item is about (its heaviest `about` edge, folded through merges); null when unlinked. */
  about: InboxWorkContext | null;
}

/** The work an inbox item is a decision about (inbox-follow-through, work-context.ts). */
export interface InboxWorkContext {
  id: string;
  title: string;
  project: string | null;
}

export interface ListInboxOptions {
  /** Statuses to include; defaults to the open ones (pending, changes, accepted). */
  statuses?: readonly InboxStatus[];
  /** Only these item ids (any status in `statuses`). */
  ids?: readonly string[];
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
  about: { id: string; title: string; project: string | null } | null;
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
  if (options.ids !== undefined) {
    for (const id of options.ids) if (!UUID_RE.test(id)) throw new InvalidLookupIdError(id, "must be a valid uuid");
    if (options.ids.length === 0) return { items: [], total: 0, truncated: false };
  }
  const idFilter = options.ids === undefined ? sql`` : sql`AND n.id = ANY (${sqlArray(options.ids, "uuid")})`;

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
       (SELECT json_build_object('id', w.id, 'title', w.title, 'project', w.metadata->>'project') FROM edges e
          JOIN resolved_nodes w ON w.id = COALESCE((SELECT merged_into FROM nodes WHERE id = e.dst_id), e.dst_id)
         WHERE e.edge_type = ${ABOUT_EDGE_TYPE} AND e.src_id = n.id AND w.node_type = ${WORK_ITEM_NODE_TYPE}
         ORDER BY e.weight DESC, w.id
         LIMIT 1) AS about,
       count(*) OVER () AS total
FROM resolved_nodes n
WHERE n.node_type = ${INBOX_ITEM_NODE_TYPE}
  AND COALESCE(n.metadata->>'status', 'pending') = ANY (${sqlArray(statuses, "text")})
  ${idFilter}
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
      about: r.about === null ? null : { id: r.about.id, title: r.about.title, project: r.about.project ?? null },
    });
  }
  const total = result.rows.length === 0 ? 0 : Number(result.rows[0]!.total);
  return { items, total, truncated: total > result.rows.length };
}

// --- Work context ---------------------------------------------------------------

/**
 * The person's "not this": removes every `about` edge out of an inbox item
 * (whoever asserted it), leaving its status, feedback, and content as they
 * are. Returns how many edges were removed; 0 when the item had none.
 * Refuses an id that is not an inbox item. Edge removal writes no node, so
 * no revision is recorded; the ingest re-links on its next pass only if it
 * matches again, which the card then shows.
 */
export async function unlinkInboxWorkContext(db: Database, id: string): Promise<{ id: string; removed: number }> {
  const requestedId = typeof id === "string" ? id.trim() : "";
  if (!UUID_RE.test(requestedId)) throw new InvalidLookupIdError(id, "must be a valid uuid");
  const found = await db.execute<{ id: string; node_type: string }>(sql`
    SELECT id, node_type FROM nodes WHERE id = (SELECT COALESCE(merged_into, id) FROM nodes WHERE id = ${requestedId}::uuid)
  `);
  const row = found.rows[0];
  if (!row) throw new NodeNotFoundError(requestedId);
  if (row.node_type !== INBOX_ITEM_NODE_TYPE) throw new NotAnInboxItemError(row.id, row.node_type);
  const removed = await db.execute<{ id: string }>(sql`
    DELETE FROM edges WHERE src_id IN (SELECT id FROM nodes WHERE id = ${row.id}::uuid OR merged_into = ${row.id}::uuid) AND edge_type = ${ABOUT_EDGE_TYPE} RETURNING id
  `);
  return { id: row.id, removed: removed.rows.length };
}

// --- Deciding -----------------------------------------------------------------

export interface DecideInboxItemInput {
  decision: InboxDecision;
  /** Required for `changes`; optional otherwise. */
  message?: string;
  /** For an accept: the card option chosen. Required when the stored card has options; refused when it does not offer it. */
  option?: string;
  /** The decision's timestamp; defaults to now (tests pin it). */
  now?: Date;
}

export interface DecideInboxItemResult {
  id: string;
  ingestRunId: string;
  before: InboxStatus;
  after: InboxStatus;
  title: string;
  /** The herdr pane (and server socket) of the live session that queued the item, when it recorded one. */
  pane: string | null;
  socket: string | null;
}

/**
 * Records the person's decision on an inbox item and moves it to the next
 * turn: accept → accepted, changes → changes, dismiss → dismissed. Only a
 * `pending` item takes accept or changes; dismiss is taken from any open
 * status (the person can drop something an agent is still working on) and
 * from undigested. An accept of an item whose card has options must name
 * one the stored card offers (`InboxCardChangedError` otherwise: an agent
 * rewrote the card after it was opened); the feedback entry records it.
 * Row-locked, written through the upsert path under a `human` ingest run,
 * so the revision trigger keeps the history. Pure Postgres.
 */
export async function decideInboxItem(db: Database, id: string, input: DecideInboxItemInput): Promise<DecideInboxItemResult> {
  if (!(INBOX_DECISIONS as readonly string[]).includes(input.decision)) {
    throw new InvalidInboxItemError("decision", input.decision, `must be one of ${INBOX_DECISIONS.join(", ")}`);
  }
  if (input.option !== undefined && input.decision !== "accept") {
    throw new InvalidInboxItemError("option", input.option, "is taken only with accept");
  }
  return writeInboxFeedback(db, id, input.decision, input);
}

/**
 * Moves an undigested item to pending as it is, on the person's say-so (the
 * agent could not open its artifact, and the person will decide anyway),
 * recording a `release` feedback entry. Refuses any other status.
 */
export async function releaseInboxItem(db: Database, id: string, input: { message?: string; now?: Date } = {}): Promise<DecideInboxItemResult> {
  return writeInboxFeedback(db, id, "release", input);
}

const NEXT_AFTER: Record<InboxDecision | "release", InboxStatus> = { ...{ accept: "accepted", changes: "changes", dismiss: "dismissed" }, release: "pending" };

async function writeInboxFeedback(db: Database, id: string, kind: InboxDecision | "release", input: { message?: string; option?: string; now?: Date }): Promise<DecideInboxItemResult> {
  const requestedId = typeof id === "string" ? id.trim() : "";
  if (!UUID_RE.test(requestedId)) throw new InvalidLookupIdError(id, "must be a valid uuid");
  const message = (input.message ?? "").trim();
  if (kind === "changes" && message === "") {
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
      const allowed = kind === "dismiss" ? INBOX_DISMISSABLE_STATUSES.includes(before) : kind === "release" ? before === "undigested" : before === "pending";
      if (!allowed) throw new InboxDecisionConflictError(existing.id, before);
      if (kind === "accept") {
        const offered = (current["options"] as ReviewOption[] | undefined) ?? [];
        if (input.option === undefined ? offered.length > 0 : !offered.some((o) => o.id === input.option)) {
          throw new InboxCardChangedError(existing.id, input.option ?? null);
        }
      }

      const after = NEXT_AFTER[kind];
      const entry: InboxFeedback = { decision: kind, message, at: (input.now ?? new Date()).toISOString(), ...(input.option === undefined ? {} : { option: input.option }) };
      const feedback = [...(current["feedback"] as InboxFeedback[]), entry];
      // A decision answers the agent's hand-back (`needs_you`) and its re-queue note (`revision`).
      const { needs_you: _handedBack, revision: _answered, ...rest } = current;
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
      const pane = typeof current["pane"] === "string" ? current["pane"] : null;
      const socket = typeof current["socket"] === "string" ? current["socket"] : null;
      return { id: row.id, ingestRunId: run.id, before, after, title: existing.title, pane, socket };
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
  if (stored === null) return withDigestion({ ...incoming });
  const merged = { ...incoming };
  const storedFeedback = (stored["feedback"] as InboxFeedback[] | undefined) ?? [];
  if (((incoming["feedback"] as InboxFeedback[] | undefined) ?? []).length < storedFeedback.length) merged["feedback"] = storedFeedback;
  // An executor that cannot carry out an accepted item hands it back by
  // setting `needs_you` (why); that is the one way pending overrides accepted.
  const handBack = stored["status"] === "accepted" && typeof incoming["needs_you"] === "string" && incoming["needs_you"].trim() !== "";
  if (incoming["status"] === "pending" && SETTLED_BY_PERSON.includes(stored["status"] as InboxStatus) && !handBack) merged["status"] = stored["status"];
  // An item handed to an interactive session stays with it: a re-ingest
  // does not pull it back, only the session itself (same pane) re-queuing
  // its draft does. Its session tab is kept either way.
  if (stored["status"] === "session") {
    const fromSession = typeof stored["pane"] === "string" && incoming["pane"] === stored["pane"];
    if (incoming["status"] === "pending" && !fromSession) {
      merged["status"] = "session";
      for (const key of ["pane", "socket"]) if (stored[key] !== undefined) merged[key] = stored[key];
    }
    if (merged["session_tab"] === undefined && stored["session_tab"] !== undefined) merged["session_tab"] = stored["session_tab"];
  }
  // A new item, or one still held, is pending only once digested; a stored
  // item the person already has (pending, or further on) is never pulled
  // back to undigested by a re-write.
  return stored["status"] === "undigested" ? withDigestion(merged) : merged;
}

/** pending ↔ undigested by whether the declared reads cover the item's `url`; any other status as written. */
function withDigestion(metadata: Record<string, unknown>): Record<string, unknown> {
  if (metadata["status"] === "pending" || metadata["status"] === "undigested") metadata["status"] = inboxItemDigested(metadata) ? "pending" : "undigested";
  return metadata;
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

// --- Session requests and completion ---------------------------------------------

export interface RequestInboxItemInput {
  /** The canonical key; `session:<slug>` for a decision a live session wants queued. */
  externalId: string;
  title: string;
  /** Markdown the person reads: what happened, the proposed action, the draft. */
  content: string;
  /** Contract metadata (source, action, url, from, priority, links, pane, socket, …). */
  metadata: Record<string, unknown>;
  /** Recorded on the ingest run, e.g. "inbox-cli". */
  actor?: string;
}

/**
 * Queues (or refreshes) one inbox item for a caller without MCP — a live
 * Claude session in another directory, through `bin/inbox request`. Same
 * contract and same re-ingest protection as brain_write; attributed to an
 * `agent` ingest run so the write is identifiable and revertible.
 */
export async function requestInboxItem(db: Database, input: RequestInboxItemInput): Promise<{ id: string; action: string; ingestRunId: string; status: InboxStatus }> {
  const itemLabel = `(${INBOX_SOURCE_SYSTEM}/${input.externalId})`;
  const incoming = normalizeInboxItemMetadata(normalizeOccurredAt(input.metadata, { itemLabel }), { itemLabel });
  const stored = await loadStoredInboxMetadata(db, [{ sourceSystem: INBOX_SOURCE_SYSTEM, externalId: input.externalId }]);
  const metadata = carryForwardInboxDecisions(incoming, stored.get(`${INBOX_SOURCE_SYSTEM}\u0000${input.externalId}`) ?? null);
  const node = { nodeType: INBOX_ITEM_NODE_TYPE, sourceSystem: INBOX_SOURCE_SYSTEM, externalId: input.externalId, title: input.title, content: input.content, metadata };
  const prepared = unsafePrepareNodes([node], DEFAULT_MAX_CONTENT_LENGTH, DEFAULT_MAX_METADATA_LENGTH, DEFAULT_MAX_TITLE_LENGTH);

  const run = await openIngestRun(db, "agent", { actor: input.actor ?? "inbox-cli" });
  try {
    let written: { rows: UpsertNodeRow[] };
    try {
      written = await db.execute<UpsertNodeRow>(unsafeBuildUpsertNodesQuery(prepared, run.id));
    } catch (err) {
      throw unsafeWrapNodeWriteError(err, prepared);
    }
    const row = written.rows[0];
    if (!row) throw new NodeUpsertFailedError(`requestInboxItem: upsert returned no row for ${input.externalId}`, 0, 0);
    return { id: row.id, action: row.action, ingestRunId: run.id, status: metadata["status"] as InboxStatus };
  } finally {
    await closeIngestRun(db, run);
  }
}

/**
 * The executor's last step: an accepted item (or one worked in an
 * interactive session) becomes done, with a
 * `**Done:**` line put at the top of its content. Refuses anything not
 * accepted. Row-locked; attributed to an `agent` ingest run.
 */
export async function completeInboxItem(db: Database, id: string, note: string, options: { actor?: string } = {}): Promise<{ id: string; ingestRunId: string }> {
  const requestedId = typeof id === "string" ? id.trim() : "";
  if (!UUID_RE.test(requestedId)) throw new InvalidLookupIdError(id, "must be a valid uuid");
  const trimmed = note.trim();
  if (trimmed === "" || trimmed.length > MAX_INBOX_FEEDBACK_LENGTH) {
    throw new InvalidInboxItemError("note", note, `must say what was done, in at most ${MAX_INBOX_FEEDBACK_LENGTH} characters`);
  }
  const run = await openIngestRun(db, "agent", { actor: options.actor ?? "inbox-cli" });
  try {
    return await db.transaction(async (tx) => {
      const locked = await tx.execute<{ id: string; node_type: string; source_system: string; external_id: string; title: string; content: string; metadata: Record<string, unknown> }>(sql`
        SELECT id, node_type, source_system, external_id, title, content, metadata
        FROM nodes WHERE id = (SELECT COALESCE(merged_into, id) FROM nodes WHERE id = ${requestedId}::uuid)
        FOR UPDATE
      `);
      const existing = locked.rows[0];
      if (!existing) throw new NodeNotFoundError(requestedId);
      if (existing.node_type !== INBOX_ITEM_NODE_TYPE) throw new NotAnInboxItemError(existing.id, existing.node_type);
      const current = normalizeInboxItemMetadata(normalizeOccurredAt(existing.metadata));
      // accepted: the executor did it. session: the person did it in the session they opened.
      if (current["status"] !== "accepted" && current["status"] !== "session") throw new InboxDecisionConflictError(existing.id, current["status"] as string);
      const { needs_you: _ignored, ...rest } = current;
      const prepared = unsafePrepareNodes(
        [
          {
            nodeType: existing.node_type,
            sourceSystem: existing.source_system,
            externalId: existing.external_id,
            title: existing.title,
            content: `**Done:** ${trimmed}\n\n${existing.content}`,
            metadata: normalizeInboxItemMetadata({ ...rest, status: "done" }),
          },
        ],
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
      if (!row) throw new NodeUpsertFailedError(`completeInboxItem: upsert returned no row for node ${existing.id}`, 0, 0);
      return { id: row.id, ingestRunId: run.id };
    });
  } finally {
    await closeIngestRun(db, run);
  }
}

// --- Handing an item to an interactive session ------------------------------------

export interface HandOffInboxItemInput {
  /** The herdr pane the interactive session runs in, its server socket, and its tab. */
  pane: string;
  socket: string;
  tab: string;
  now?: Date;
}

/**
 * Records that the person opened an interactive Claude session on the item
 * (the server already started it): status `session`, the session's pane,
 * socket, and tab, and a `session` feedback entry. Allowed from pending,
 * changes, or session (re-opening after the earlier session was closed).
 * The session takes it from there: re-queuing a draft with `inbox request`
 * from the same pane returns it to pending, and the person's decision is
 * prompted back to that pane like any session item. Row-locked, under a
 * `human` ingest run. Pure Postgres.
 */
export async function handOffInboxItem(db: Database, id: string, input: HandOffInboxItemInput): Promise<{ id: string; ingestRunId: string; before: InboxStatus }> {
  const requestedId = typeof id === "string" ? id.trim() : "";
  if (!UUID_RE.test(requestedId)) throw new InvalidLookupIdError(id, "must be a valid uuid");
  for (const [field, value] of [["pane", input.pane], ["socket", input.socket], ["tab", input.tab]] as const) {
    if (typeof value !== "string" || value.trim() === "" || value.length > 512 || CONTROL_CHAR.test(value)) {
      throw new InvalidInboxItemError(field, value, "is required, without control characters");
    }
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
        throw new LookupFailedError(`handOffInboxItem lock failed${formatPgInfo(asPgError(err))}`, "decideInboxItem", { cause: err });
      }
      const existing = locked.rows[0];
      if (!existing) throw new NodeNotFoundError(requestedId);
      if (existing.node_type !== INBOX_ITEM_NODE_TYPE) throw new NotAnInboxItemError(existing.id, existing.node_type);
      const current = normalizeInboxItemMetadata(normalizeOccurredAt(existing.metadata));
      const before = current["status"] as InboxStatus;
      if (!INBOX_HANDOFF_STATUSES.includes(before)) throw new InboxDecisionConflictError(existing.id, before);
      const feedback = [...(current["feedback"] as InboxFeedback[]), { decision: "session", message: `opened in herdr tab ${input.tab}`, at: (input.now ?? new Date()).toISOString() }];
      const { needs_you: _handedBack, ...rest } = current;
      const metadata = normalizeInboxItemMetadata({ ...rest, status: "session", pane: input.pane, socket: input.socket, session_tab: input.tab, feedback });
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
      if (!row) throw new NodeUpsertFailedError(`handOffInboxItem: upsert returned no row for node ${existing.id}`, 0, 0);
      return { id: row.id, ingestRunId: run.id, before };
    });
  } finally {
    await closeIngestRun(db, run);
  }
}
