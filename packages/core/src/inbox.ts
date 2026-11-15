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
// A remote worker's item (filed with a hangar session token) carries
// `session`, the hangar session node's id, taken from the token by the
// server and never from a request body: no writer but `requestInboxItem`'s
// server-supplied argument sets it, and a re-write carries the stored one
// forward. A person's decision, release, or hand-off on such an item is
// appended to that session's messages (hangar.ts `appendHangarMessage`) in
// the transaction that records it, instead of being typed into a herdr
// pane (hangar-queue decisions 6 and 9). Only while the session is live: once
// it has ended (stopped, failed, merged away, or gone), nobody reads its
// messages. An accept or a send-back is then refused
// (`InboxItemSessionEndedError`, nothing written): an item with neither a
// pane nor a session falls to local routing (bin/inbox-watch, inbox-execute),
// and a remote worker's proposal must not silently become a local execution
// with the person's credentials. Dismiss, release, and hand-off still work;
// they append nothing and clear `session`, so the item is local from then on
// — the person's explicit choice (a released item's later accept is an
// ordinary local accept).
// A session-bound caller writes only its own session's items, through
// `requestInboxItem` or brain_write (`assertSessionMayWriteInboxItems`).
//
// An outcome request (hangar-release change) asks the person to accept or
// table an ended hangar session: `requestHangarOutcome` files it with a card
// offering `accept` and `table`, bound by `hangar_outcome` = { session_id,
// requested }. Like `session`, only that path sets the binding: every other
// writer's is dropped and the stored one kept (carryForwardInboxDecisions),
// so no agent can turn an ordinary item into one, or repoint one at another
// session. A click on one deletes a session's disk, so its card is the
// server's: the key prefix `hangar-outcome:` under `inbox` is reserved
// (`ReservedInboxItemError` from brain_write and `requestInboxItem`, and for
// any stored item carrying a binding), `requestHangarOutcome` always writes
// the canonical card with the agent's note quoted below the server-written
// facts, a stored binding pins the card through any re-write, and an accept
// is refused unless the stored options are still the canonical pair
// (`InboxCardChangedError`). No decision, release, hand-off, or completion
// lands on a merged-away id: each refuses one whose id folds to another node
// (`InboxCardChangedError`, with `mergedInto`), so a merge can never carry a
// click on one card onto another — and brain_merge refuses outcome requests
// outright (merge.ts). The person's accept with an option sets the
// session's outcome in the decision's own transaction, attributed to them (hangar.ts
// `unsafeSetHangarSessionOutcomeInTx`), and closes the item `done`: there is
// nothing left for an executor. A refusal (the session cannot take an
// outcome now) fails the decision and writes nothing. A dismiss leaves the
// outcome unset.
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
  ReservedInboxItemError,
  InboxCardChangedError,
  InboxDecisionConflictError,
  InboxItemNotThisSessionError,
  InboxItemSessionEndedError,
  InvalidInboxItemError,
  InvalidLookupIdError,
  InvalidLookupOptionError,
  LookupFailedError,
  NodeNotFoundError,
  NodeUpsertFailedError,
  NotAnInboxItemError,
} from "./errors.js";
import { normalizeOccurredAt } from "./event-time.js";
import { fitText } from "./fit-text.js";
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
import {
  appendHangarMessage,
  getSessionTakingOutcome,
  HANGAR_OUTCOMES,
  HANGAR_SESSION_NODE_TYPE,
  HANGAR_SOURCE_SYSTEM,
  unsafeSetHangarSessionOutcomeInTx,
  type HangarOutcome,
} from "./hangar.js";
import { unsafeRouteInboxDecisionInTx } from "./hangar-decisions.js";
import type { IngestRunHandle } from "./ingest-runs.js";
import { asPgError, formatPgInfo, sqlArray, type Tx } from "./sql-helpers.js";

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

/** An outcome request's binding (module header): the session it is about, and the outcome the agent asked for. */
export interface InboxHangarOutcome {
  sessionId: string;
  requested: HangarOutcome;
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
  /** The hangar session that filed the item (module header); its decisions go to that session's messages, not a pane. */
  hangarSession: string | null;
  /** Set on an outcome request: the person's accept sets that session's outcome (module header). */
  hangarOutcome: InboxHangarOutcome | null;
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

/** The metadata key binding an outcome request to its session (module header). */
export const HANGAR_OUTCOME_KEY = "hangar_outcome";

/** The external-id prefix, under source system `inbox`, that only `requestHangarOutcome` writes (module header). */
export const HANGAR_OUTCOME_KEY_PREFIX = "hangar-outcome:";

/** An outcome request's question; part of the canonical card. */
export const HANGAR_OUTCOME_QUESTION = "Accept or table this hangar session?";

const DISK_DELETED = "Its disk is deleted: anything on it that was not pushed is lost.";

/** An outcome request's options, in order, exactly as stored (module header); an accept is refused on any other set. */
export const HANGAR_OUTCOME_OPTIONS: readonly ReviewOption[] = [
  { id: "accept", label: "Accept", what: "The work is done or kept. Hangar releases the session: it removes the container and deletes the disk at its next check-in.", risk: DISK_DELETED },
  { id: "table", label: "Table", what: "Set the work aside. Hangar releases the session: it removes the container and deletes the disk at its next check-in.", risk: DISK_DELETED },
];

/** How much of an agent-written repo an outcome request's title, content, and banner show. */
export const MAX_SHOWN_HANGAR_REPO = 80;

/**
 * An agent-written repo as an outcome request shows it: capped at
 * `MAX_SHOWN_HANGAR_REPO` (an ellipsis marks the cut) and JSON-quoted, so
 * where it ends is unmistakable and nothing in it reads as the server's.
 */
export function quoteHangarRepo(repo: string): string {
  return JSON.stringify(repo.length > MAX_SHOWN_HANGAR_REPO ? `${fitText(repo, MAX_SHOWN_HANGAR_REPO - 1)}…` : repo);
}

/** `text` as a markdown code span, fenced past any backtick run inside it, so it renders literally. */
function markdownCodeSpan(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

const OUTCOME_OF_OPTION: Readonly<Record<string, HangarOutcome>> = { accept: "accepted", table: "tabled" };

/** Whether a key is reserved for outcome requests: source system `inbox`, external id under `HANGAR_OUTCOME_KEY_PREFIX`, matched as the upsert stores them (trimmed). */
export function isHangarOutcomeKey(sourceSystem: string, externalId: string): boolean {
  return sourceSystem.trim() === INBOX_SOURCE_SYSTEM && externalId.trim().startsWith(HANGAR_OUTCOME_KEY_PREFIX);
}

/**
 * For a generic writer (brain_write, `requestInboxItem`): refuses, before
 * anything is written, any item (whatever its node type) at a key reserved
 * for outcome requests. Throws `ReservedInboxItemError` naming the first.
 */
export function assertNoHangarOutcomeKeys(items: readonly { sourceSystem: string; externalId: string; label?: string }[]): void {
  for (const item of items) {
    if (isHangarOutcomeKey(item.sourceSystem, item.externalId)) {
      throw new ReservedInboxItemError(item.label ?? `(${item.sourceSystem.trim()}/${item.externalId.trim()})`, `keys starting "${HANGAR_OUTCOME_KEY_PREFIX}" are reserved for outcome requests (a driver releases its session with brain_hangar_outcome)`);
    }
  }
}

/** For a generic writer: refuses a stored item (normalized metadata) that carries an outcome request binding, whatever its key. */
export function assertNotHangarOutcomeItem(label: string, stored: Record<string, unknown> | null | undefined): void {
  if (stored != null && stored[HANGAR_OUTCOME_KEY] !== undefined) {
    throw new ReservedInboxItemError(label, "it is an outcome request, which no writer changes");
  }
}

/** Whether stored options are exactly `HANGAR_OUTCOME_OPTIONS` (ids, labels, and text, in order). */
function isCanonicalOutcomeCard(options: readonly ReviewOption[]): boolean {
  const fields = (o: ReviewOption) => [o.id, o.label, o.what ?? null, o.risk ?? null];
  return JSON.stringify(options.map(fields)) === JSON.stringify(HANGAR_OUTCOME_OPTIONS.map(fields));
}

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
  const session = metadata["session"];
  if (session === undefined || session === null || session === "") delete metadata["session"];
  else if (typeof session !== "string" || !UUID_RE.test(session)) throw new InvalidInboxItemError("session", session, "must be a hangar session id (a uuid)", itemLabel);
  else metadata["session"] = session.toLowerCase();
  const binding = metadata[HANGAR_OUTCOME_KEY];
  if (binding === undefined || binding === null) delete metadata[HANGAR_OUTCOME_KEY];
  else {
    const sessionId = isPlainObject(binding) ? binding["session_id"] : undefined;
    const requested = isPlainObject(binding) ? binding["requested"] : undefined;
    if (typeof sessionId !== "string" || !UUID_RE.test(sessionId) || typeof requested !== "string" || !(HANGAR_OUTCOMES as readonly string[]).includes(requested)) {
      throw new InvalidInboxItemError(HANGAR_OUTCOME_KEY, binding, `must be { session_id: a hangar session id, requested: one of ${HANGAR_OUTCOMES.join(", ")} }`, itemLabel);
    }
    metadata[HANGAR_OUTCOME_KEY] = { session_id: sessionId.toLowerCase(), requested };
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

/** The outcome request binding off normalized metadata, or null. */
function readHangarOutcome(metadata: Record<string, unknown>): InboxHangarOutcome | null {
  const binding = metadata[HANGAR_OUTCOME_KEY];
  if (!isPlainObject(binding)) return null;
  return { sessionId: binding["session_id"] as string, requested: binding["requested"] as HangarOutcome };
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
    hangarSession: typeof metadata["session"] === "string" ? metadata["session"] : null,
    hangarOutcome: readHangarOutcome(metadata),
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

/** Like human-writes.ts's options: the ingest run's actor, default "human". The web router passes the admitted token client, never browser input. */
export interface InboxWriteOptions {
  actor?: string;
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
  /** The hangar session the decision was sent to as a message (module header), or null for a local item. */
  session: string | null;
  /**
   * The hangar session that filed the item, when it had ended by the time of
   * a dismiss or release (module header): nothing was sent, and the item's
   * `session` was cleared. Null otherwise (an accept or send-back on such an
   * item is refused instead).
   */
  endedSession: string | null;
  /** The session outcome an accept of an outcome request set (module header); null for any other decision or item. */
  sessionOutcome: { sessionId: string; outcome: HangarOutcome; changed: boolean } | null;
}

/** The kind of a hangar message carrying a person's decision on a session's inbox item. */
export const INBOX_DECISION_MESSAGE_KIND = "inbox_decision";

/**
 * What the session that queued the item is told: the decision, the note,
 * and the one command that closes the loop. Typed into a local session's
 * herdr pane, or carried as `text` in a remote session's message.
 */
export function inboxNotifyText(result: Pick<DecideInboxItemResult, "id" | "title" | "after">, message: string, option?: string): string {
  const note = message.trim() === "" ? "" : ` Note: ${message.trim()}`;
  switch (result.after) {
    case "accepted":
      return `[inbox] Accepted${option === undefined ? "" : ` option ${option}`}: "${result.title}".${note} Carry it out now, then run: inbox done ${result.id} "<what you did, with link>"`;
    case "changes":
      // inbox-follow-through, design.md decision 3: triage the note, don't just revise.
      return `[inbox] Sent to agent on "${result.title}":${note} Triage it into one outcome. Close: the note says done, handled, not yours, or no action → run: inbox done ${result.id} "Closed on the note: <why>". Act: the note fully specifies it and what goes out is the reviewed draft with only the edits it names → do it, then run: inbox done ${result.id} "<what you did, with link>". Otherwise (new text under the person's name they haven't read, or you're unsure) → revise and re-queue with the same --key (inbox request), saying what changed in the first line.`;
    case "done":
      return `[inbox] Accepted${option === undefined ? "" : ` option ${option}`}: "${result.title}".${note} It is done already; nothing to carry out.`;
    case "pending":
      return `[inbox] Released: "${result.title}" is in front of the person as written, without your reading of it.${note} Wait for their decision.`;
    default:
      return `[inbox] Dismissed: "${result.title}".${note} Drop it; nothing to send.`;
  }
}

/** The message body a remote session receives for a decision, release, or hand-off on its item. */
function decisionMessageBody(item: { id: string; title: string }, decision: InboxFeedbackKind, outcome: InboxStatus, message: string, option: string | undefined, text: string): Record<string, unknown> {
  return { item_id: item.id, title: item.title, decision, outcome, ...(option === undefined ? {} : { option }), message, text };
}

async function sendToSession(tx: Tx, session: string, body: Record<string, unknown>): Promise<void> {
  await appendHangarMessage(tx, { sessionId: session, kind: INBOX_DECISION_MESSAGE_KIND, body });
}

/**
 * Whether hangar session `session` still reads its messages: a canonical
 * session the hangar queue wrote, neither stopped nor failed. A merged-away
 * or missing node counts as ended. Takes a share lock, so a racing stop
 * waits for the decision's transaction, and the message lands before the
 * session's token dies.
 */
async function hangarSessionLive(tx: Tx, session: string): Promise<boolean> {
  const result = await tx.execute<{ state: string | null; merged_into: string | null }>(sql`
    SELECT metadata->>'state' AS state, merged_into FROM nodes
    WHERE id = ${session}::uuid AND node_type = ${HANGAR_SESSION_NODE_TYPE} AND source_system = ${HANGAR_SOURCE_SYSTEM}
    FOR SHARE
  `);
  const row = result.rows[0];
  return row !== undefined && row.merged_into === null && row.state !== "stopped" && row.state !== "failed";
}

/** The item's hangar session, split by whether it is still live (`hangarSessionLive`). */
async function itemSession(tx: Tx, metadata: Record<string, unknown>): Promise<{ live: string | null; ended: string | null }> {
  const session = typeof metadata["session"] === "string" ? metadata["session"] : null;
  if (session === null) return { live: null, ended: null };
  return (await hangarSessionLive(tx, session)) ? { live: session, ended: null } : { live: null, ended: session };
}

/**
 * Records the person's decision on an inbox item and moves it to the next
 * turn: accept → accepted, changes → changes, dismiss → dismissed. Only a
 * `pending` item takes accept or changes; dismiss is taken from any open
 * status (the person can drop something an agent is still working on) and
 * from undigested. An accept of an item whose card has options must name
 * one the stored card offers (`InboxCardChangedError` otherwise: an agent
 * rewrote the card after it was opened); the feedback entry records it.
 * An accept or send-back on an item whose hangar session has ended is
 * refused (`InboxItemSessionEndedError`, module header).
 * Row-locked, written through the upsert path under a `human` ingest run,
 * so the revision trigger keeps the history. Pure Postgres.
 */
export async function decideInboxItem(db: Database, id: string, input: DecideInboxItemInput, options: InboxWriteOptions = {}): Promise<DecideInboxItemResult> {
  if (!(INBOX_DECISIONS as readonly string[]).includes(input.decision)) {
    throw new InvalidInboxItemError("decision", input.decision, `must be one of ${INBOX_DECISIONS.join(", ")}`);
  }
  if (input.option !== undefined && input.decision !== "accept") {
    throw new InvalidInboxItemError("option", input.option, "is taken only with accept");
  }
  return writeInboxFeedback(db, id, input.decision, input, options);
}

/**
 * Moves an undigested item to pending as it is, on the person's say-so (the
 * agent could not open its artifact, and the person will decide anyway),
 * recording a `release` feedback entry. Refuses any other status.
 */
export async function releaseInboxItem(db: Database, id: string, input: { message?: string; now?: Date } = {}, options: InboxWriteOptions = {}): Promise<DecideInboxItemResult> {
  return writeInboxFeedback(db, id, "release", input, options);
}

const NEXT_AFTER: Record<InboxDecision | "release", InboxStatus> = { ...{ accept: "accepted", changes: "changes", dismiss: "dismissed" }, release: "pending" };

async function writeInboxFeedback(
  db: Database,
  id: string,
  kind: InboxDecision | "release",
  input: { message?: string; option?: string; now?: Date },
  options: InboxWriteOptions,
): Promise<DecideInboxItemResult> {
  const requestedId = typeof id === "string" ? id.trim() : "";
  if (!UUID_RE.test(requestedId)) throw new InvalidLookupIdError(id, "must be a valid uuid");
  const message = (input.message ?? "").trim();
  if (kind === "changes" && message === "") {
    throw new InvalidInboxItemError("message", input.message, "is required when requesting changes — say what needs to change");
  }
  if (message.length > MAX_INBOX_FEEDBACK_LENGTH) {
    throw new InvalidInboxItemError("message", `${message.slice(0, 40)}…`, `must be at most ${MAX_INBOX_FEEDBACK_LENGTH} characters`);
  }

  const actor = options.actor ?? "human";
  // An accept of an outcome request also writes the session, under its own
  // `hangar` run naming the person (hangar.ts module header); the binding is
  // read unlocked here so the run opens before the transaction, and checked
  // again under the lock.
  let outcomeRun: IngestRunHandle | null = null;
  const run = await openIngestRun(db, "human", { actor });
  try {
    if (kind === "accept" && (await hasHangarOutcomeBinding(db, requestedId))) outcomeRun = await openIngestRun(db, HANGAR_SOURCE_SYSTEM, { actor });
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
      // The person decided the card they read; a merge since may have folded
      // it onto another they never saw (module header).
      if (existing.id !== requestedId.toLowerCase()) throw new InboxCardChangedError(requestedId, input.option ?? null, existing.id);
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

      let after = NEXT_AFTER[kind];
      const binding = readHangarOutcome(current);
      let sessionOutcome: DecideInboxItemResult["sessionOutcome"] = null;
      if (binding !== null && kind === "accept") {
        // The outcome comes from the option id alone, and only off the
        // canonical card: relabelled options are a card the person was not
        // shown by the server (module header).
        if (!isCanonicalOutcomeCard((current["options"] as ReviewOption[] | undefined) ?? [])) throw new InboxCardChangedError(existing.id, input.option ?? null);
        const outcome = input.option === undefined ? undefined : OUTCOME_OF_OPTION[input.option];
        if (outcome === undefined) throw new InvalidInboxItemError("option", input.option, "must be accept or table on a hangar outcome request");
        if (outcomeRun === null) throw new InboxCardChangedError(existing.id, input.option ?? null);
        const set = await unsafeSetHangarSessionOutcomeInTx(tx, outcomeRun, { id: binding.sessionId, outcome, actor });
        sessionOutcome = { sessionId: set.session.id, outcome, changed: set.changed };
        // The outcome is the whole action: nothing is left for an executor.
        after = "done";
      }
      const entry: InboxFeedback = { decision: kind, message, at: (input.now ?? new Date()).toISOString(), ...(input.option === undefined ? {} : { option: input.option }) };
      const feedback = [...(current["feedback"] as InboxFeedback[]), entry];
      const { live: session, ended: endedSession } = await itemSession(tx, current);
      // An ended session reads nothing more; only the person's explicit
      // dismiss or release makes its item local (module header).
      if (endedSession !== null && (kind === "accept" || kind === "changes")) throw new InboxItemSessionEndedError(existing.id, endedSession);
      // An escalated hangar decision that fell back to this item
      // (hangar-escalation.ts): the decision is answered as well, matched on
      // this item's id, and the session carries it on from its own message,
      // so nothing is left here for an executor.
      if (session !== null && kind !== "release") {
        const routed = await unsafeRouteInboxDecisionInTx(tx, { itemId: existing.id, sessionId: session, decision: kind, ...(input.option === undefined ? {} : { option: input.option }), message, by: actor });
        if (routed && kind !== "dismiss") after = "done";
      }
      // A decision answers the agent's hand-back (`needs_you`) and its re-queue note (`revision`).
      const { needs_you: _handedBack, revision: _answered, ...rest } = current;
      if (endedSession !== null) delete rest["session"];
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
      if (session !== null) {
        const item = { id: row.id, title: existing.title };
        await sendToSession(tx, session, decisionMessageBody(item, kind, after, message, input.option, inboxNotifyText({ ...item, after }, message, input.option)));
      }
      return { id: row.id, ingestRunId: run.id, before, after, title: existing.title, pane, socket, session, endedSession, sessionOutcome };
    });
  } finally {
    try {
      if (outcomeRun !== null) await closeIngestRun(db, outcomeRun);
    } finally {
      await closeIngestRun(db, run);
    }
  }
}

/** Whether the item `id` names (folded through merges) carries an outcome request binding. Unlocked. */
async function hasHangarOutcomeBinding(db: Database, id: string): Promise<boolean> {
  const result = await db.execute<{ bound: boolean }>(sql`
    SELECT (metadata ? ${HANGAR_OUTCOME_KEY}) AS bound FROM nodes
    WHERE id = (SELECT COALESCE(merged_into, id) FROM nodes WHERE id = ${id}::uuid) AND node_type = ${INBOX_ITEM_NODE_TYPE}
  `);
  return result.rows[0]?.bound === true;
}

// --- Re-ingest safety -----------------------------------------------------------

/** Statuses a re-ingest's `pending` never overrides: the person or executor already moved them on. */
const SETTLED_BY_PERSON: readonly InboxStatus[] = ["accepted", "dismissed", "done"];

/**
 * Statuses only the person's own paths move an item into — a decision
 * (`decideInboxItem`: accepted, changes, dismissed) or a hand-off
 * (`handOffInboxItem`: session). No agent write sets one: an agent that
 * could would approve its own proposed action (hangar-queue, security
 * review). Leaving one is the agent's (changes → pending or done,
 * accepted → done, or back to pending with `needs_you`).
 */
export const PERSON_DECIDED_INBOX_STATUSES: readonly InboxStatus[] = ["accepted", "changes", "dismissed", "session"];

/**
 * The person's decisions survive an agent's re-write of the same item, and
 * no agent write can make one. `feedback` is the person's: an agent's
 * incoming feedback is ignored and the stored history kept (a new item
 * starts with none). A new item is `pending` (or `undigested`, below)
 * whatever status it was sent with. On a stored item, an incoming status
 * among `PERSON_DECIDED_INBOX_STATUSES` that differs from the stored one is
 * ignored, and a stored accepted/dismissed/done status is not reset by an
 * incoming `pending` — re-ingesting a signal the person already decided
 * must not put it back in front of them. Any other incoming status (the
 * agent moving changes → pending after a revision, accepted → done after
 * executing) is the agent's to set. `session` and `hangar_outcome` are
 * never the writer's to set (module header): an incoming one is dropped and
 * the stored one kept; `requestInboxItem` stamps a session-bound caller's
 * session, and `requestHangarOutcome` its binding, afterwards. A stored
 * binding also pins the card (question, options, recommend, on_accept) to
 * the stored one, as defense in depth behind the reserved key: only
 * `requestHangarOutcome` rewrites it, after this. Pure; both inputs
 * normalized.
 */
export function carryForwardInboxDecisions(incoming: Record<string, unknown>, stored: Record<string, unknown> | null): Record<string, unknown> {
  const { session: _notTheWriters, [HANGAR_OUTCOME_KEY]: _notTheirsEither, feedback: _notTheAgents, ...written } = incoming;
  if (stored === null) return withDigestion({ ...written, status: "pending", feedback: [] });
  const merged: Record<string, unknown> = {
    ...written,
    feedback: (stored["feedback"] as InboxFeedback[] | undefined) ?? [],
    ...(typeof stored["session"] === "string" ? { session: stored["session"] } : {}),
    ...(stored[HANGAR_OUTCOME_KEY] !== undefined ? { [HANGAR_OUTCOME_KEY]: stored[HANGAR_OUTCOME_KEY] } : {}),
  };
  if (stored[HANGAR_OUTCOME_KEY] !== undefined) {
    for (const key of CARD_KEYS) {
      if (stored[key] === undefined) delete merged[key];
      else merged[key] = stored[key];
    }
  }
  if (PERSON_DECIDED_INBOX_STATUSES.includes(incoming["status"] as InboxStatus) && incoming["status"] !== stored["status"]) merged["status"] = stored["status"];
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
  /**
   * The hangar session the admitting token is bound to — server-supplied,
   * never from the body (module header). When set, the item records it and
   * drops any `pane`/`socket`, so decisions go to the session's messages.
   */
  session?: string;
}

export interface RequestInboxItemResult {
  id: string;
  action: string;
  ingestRunId: string;
  status: InboxStatus;
  /** The hangar session the item's decisions go to, or null for a local item. */
  session: string | null;
}

type StoredInboxRow = { id: string; node_type: string; metadata: Record<string, unknown> };

/** The node the request's key names (any type, merged or not), with its metadata under the contract or null when it is not an inbox item or breaks the contract. */
async function readRequestTarget(db: Database | Tx, externalId: string, lock: boolean): Promise<{ row: StoredInboxRow | null; stored: Record<string, unknown> | null }> {
  let result: { rows: StoredInboxRow[] };
  try {
    result = await db.execute<StoredInboxRow>(sql`
      SELECT id, node_type, metadata FROM nodes WHERE source_system = ${INBOX_SOURCE_SYSTEM} AND external_id = ${externalId}
      ${lock ? sql`FOR UPDATE` : sql``}
    `);
  } catch (err) {
    throw new LookupFailedError(`requestInboxItem lookup failed${formatPgInfo(asPgError(err))}`, "requestInboxItem", { cause: err });
  }
  const row = result.rows[0] ?? null;
  if (row === null || row.node_type !== INBOX_ITEM_NODE_TYPE) return { row, stored: null };
  try {
    return { row, stored: normalizeInboxItemMetadata(normalizeOccurredAt(row.metadata)) };
  } catch {
    return { row, stored: null };
  }
}

/**
 * A session-bound caller writes only a new key or an item its own session
 * filed: a stored item with another session, or with none (a local pane's,
 * a person's, an ingest's), or a node that is not a readable inbox item, is
 * refused.
 */
function assertSessionMayResend(target: { row: StoredInboxRow | null; stored: Record<string, unknown> | null }, session: string | undefined): void {
  if (session === undefined || target.row === null) return;
  if (target.stored === null || target.stored["session"] !== session) throw new InboxItemNotThisSessionError(target.row.id, session, "re-send");
}

/**
 * Without a binding (a generic request), a stored item carrying one is
 * refused. With one (`requestHangarOutcome`), the key must be new or hold
 * an item already bound to the same session: anything else at it was not
 * written by this path, and taking it over would carry its fields forward.
 */
function assertBindingMayWrite(target: { row: StoredInboxRow | null; stored: Record<string, unknown> | null }, binding: { session_id: string } | undefined, itemLabel: string): void {
  if (binding === undefined) {
    assertNotHangarOutcomeItem(itemLabel, target.stored);
    return;
  }
  if (target.row === null) return;
  const stored = target.stored === null ? null : readHangarOutcome(target.stored);
  if (stored === null || stored.sessionId !== binding.session_id) {
    throw new ReservedInboxItemError(itemLabel, "the key is held by an item that is not this session's outcome request; nothing was filed");
  }
}

/** A node's natural key as the upsert stores it (trimmed), for matching a pre-read against what the upsert returns. */
function nodeKey(sourceSystem: string, externalId: string): string {
  return `${sourceSystem.trim()}\u0000${externalId.trim()}`;
}

/**
 * brain_write's counterpart of `assertSessionMayResend`, for a session-bound
 * caller (hangar-queue decision 9): every item that is an inbox item, or
 * whose key names a stored one, must be a new key or an item `session`
 * filed. One statement for the batch, run before any ingest run opens;
 * throws `InboxItemNotThisSessionError` naming the first offender, so the
 * batch writes nothing. Keys are matched as the upsert stores them
 * (trimmed). Returns the keys no row held, for
 * `assertSessionCreatedAbsentKeys` to check inside the write's transaction:
 * this read takes no lock, so another writer can insert one of them before
 * the upsert does.
 */
export async function assertSessionMayWriteInboxItems(
  db: Database,
  session: string,
  items: readonly { nodeType: string; sourceSystem: string; externalId: string }[],
): Promise<ReadonlySet<string>> {
  const absent = new Set<string>();
  if (items.length === 0) return absent;
  const own = session.toLowerCase();
  let result: { rows: { id: string; node_type: string; source_system: string; external_id: string; metadata: Record<string, unknown> }[] };
  try {
    result = await db.execute(sql`
      SELECT id, node_type, source_system, external_id, metadata FROM nodes
      WHERE (source_system, external_id) IN (${sql.join(
        items.map((i) => sql`(${i.sourceSystem.trim()}, ${i.externalId.trim()})`),
        sql.raw(", "),
      )})`);
  } catch (err) {
    throw new LookupFailedError(`assertSessionMayWriteInboxItems query failed${formatPgInfo(asPgError(err))}`, "requestInboxItem", { cause: err });
  }
  const stored = new Map(result.rows.map((r) => [nodeKey(r.source_system, r.external_id), r]));
  for (const item of items) {
    const key = nodeKey(item.sourceSystem, item.externalId);
    const row = stored.get(key);
    if (row === undefined) {
      absent.add(key);
      continue;
    }
    if (item.nodeType.trim() !== INBOX_ITEM_NODE_TYPE && row.node_type !== INBOX_ITEM_NODE_TYPE) continue;
    let metadata: Record<string, unknown> | null = null;
    if (row.node_type === INBOX_ITEM_NODE_TYPE) {
      try {
        metadata = normalizeInboxItemMetadata(normalizeOccurredAt(row.metadata));
      } catch {
        // A stored row past the contract is no session's to re-send.
      }
    }
    if (metadata === null || metadata["session"] !== own) throw new InboxItemNotThisSessionError(row.id, own, "re-send");
  }
  return absent;
}

/**
 * The in-transaction half of `assertSessionMayWriteInboxItems`, mirroring
 * `requestInboxItem`'s `action !== "created"` check: a key the pre-read found
 * absent must come back `created`. Anything else means another writer
 * inserted it in between and the upsert just overwrote that row, so this
 * throws `InboxItemNotThisSessionError` for it; run as the upsert's
 * `beforeCommit`, the throw rolls the whole batch back.
 */
export function assertSessionCreatedAbsentKeys(
  session: string,
  absent: ReadonlySet<string>,
  rows: readonly { id: string; sourceSystem: string; externalId: string; action: string }[],
): void {
  for (const row of rows) {
    if (row.action !== "created" && absent.has(nodeKey(row.sourceSystem, row.externalId))) throw new InboxItemNotThisSessionError(row.id, session.toLowerCase(), "re-send");
  }
}

/**
 * Queues (or refreshes) one inbox item for a caller without MCP — a live
 * Claude session in another directory, through `bin/inbox request`. Same
 * contract and same re-ingest protection as brain_write (the body's
 * `feedback` and `session` are ignored, and its status never makes a
 * decision: `carryForwardInboxDecisions`); attributed to an `agent` ingest
 * run so the write is identifiable and revertible. A session-bound caller
 * (`session`) may re-send only its own session's items
 * (`InboxItemNotThisSessionError` otherwise, before any run opens and again
 * under the row lock, so a racing writer cannot slip one in); the stored
 * row is locked for the read-modify-write. A key reserved for outcome
 * requests, or a stored item carrying a binding, is refused
 * (`ReservedInboxItemError`, module header) before anything is written.
 */
export async function requestInboxItem(db: Database, input: RequestInboxItemInput): Promise<RequestInboxItemResult> {
  return fileInboxItem(db, input, undefined);
}

/** `requestInboxItem`, binding the item to an outcome request when `binding` is given (only `requestHangarOutcome` gives one). */
async function fileInboxItem(db: Database, input: RequestInboxItemInput, binding: { session_id: string; requested: HangarOutcome } | undefined): Promise<RequestInboxItemResult> {
  const itemLabel = `(${INBOX_SOURCE_SYSTEM}/${input.externalId})`;
  // A body's `session` is ignored, valid or not: only the server names one.
  // Its `feedback` likewise: only the person's decisions write it; and its
  // `hangar_outcome`: only requestHangarOutcome binds one.
  const { session: _fromBody, feedback: _notTheAgents, [HANGAR_OUTCOME_KEY]: _notABinding, ...bodyMetadata } = input.metadata;
  if (binding === undefined) assertNoHangarOutcomeKeys([{ sourceSystem: INBOX_SOURCE_SYSTEM, externalId: input.externalId, label: itemLabel }]);
  const incoming = normalizeInboxItemMetadata(normalizeOccurredAt(bodyMetadata, { itemLabel }), { itemLabel });
  const session = input.session?.toLowerCase();
  const pre = await readRequestTarget(db, input.externalId, false);
  assertSessionMayResend(pre, session);
  assertBindingMayWrite(pre, binding, itemLabel);

  const run = await openIngestRun(db, "agent", { actor: input.actor ?? "inbox-cli" });
  try {
    return await db.transaction(async (tx) => {
      const target = await readRequestTarget(tx, input.externalId, true);
      assertSessionMayResend(target, session);
      assertBindingMayWrite(target, binding, itemLabel);
      let metadata = carryForwardInboxDecisions(incoming, target.stored);
      if (session !== undefined) {
        const { pane: _pane, socket: _socket, ...rest } = metadata;
        metadata = normalizeInboxItemMetadata({ ...rest, session }, { itemLabel });
      }
      if (binding !== undefined) {
        // A bound item never reaches a session or a pane, and always carries
        // the canonical card `requestHangarOutcome` built (module header).
        const { session: _session, pane: _pane, socket: _socket, ...rest } = metadata;
        const card = Object.fromEntries(CARD_KEYS.flatMap((key) => (incoming[key] === undefined ? [] : [[key, incoming[key]]])));
        for (const key of CARD_KEYS) delete rest[key];
        metadata = normalizeInboxItemMetadata({ ...rest, ...card, [HANGAR_OUTCOME_KEY]: binding }, { itemLabel });
      }
      const node = { nodeType: INBOX_ITEM_NODE_TYPE, sourceSystem: INBOX_SOURCE_SYSTEM, externalId: input.externalId, title: input.title, content: input.content, metadata };
      const prepared = unsafePrepareNodes([node], DEFAULT_MAX_CONTENT_LENGTH, DEFAULT_MAX_METADATA_LENGTH, DEFAULT_MAX_TITLE_LENGTH);
      let written: { rows: UpsertNodeRow[] };
      try {
        written = await tx.execute<UpsertNodeRow>(unsafeBuildUpsertNodesQuery(prepared, run.id));
      } catch (err) {
        throw unsafeWrapNodeWriteError(err, prepared);
      }
      const row = written.rows[0];
      if (!row) throw new NodeUpsertFailedError(`requestInboxItem: upsert returned no row for ${input.externalId}`, 0, 0);
      // No row was there to lock, but one is now: another writer inserted the
      // key between the read and this upsert, which just overwrote it. Roll
      // back rather than take that item.
      if (session !== undefined && target.row === null && row.action !== "created") throw new InboxItemNotThisSessionError(row.id, session, "re-send");
      if (binding !== undefined && target.row === null && row.action !== "created") throw new ReservedInboxItemError(itemLabel, "another writer took the key while this request was filed; nothing was filed");
      return { id: row.id, action: row.action, ingestRunId: run.id, status: metadata["status"] as InboxStatus, session: typeof metadata["session"] === "string" ? metadata["session"] : null };
    });
  } finally {
    await closeIngestRun(db, run);
  }
}

export const MAX_HANGAR_OUTCOME_NOTE_LENGTH = 2000;

export interface RequestHangarOutcomeInput {
  sessionId: string;
  /** The outcome the agent asks for: one of `HANGAR_OUTCOMES`. */
  outcome: string;
  /** Why, for the person (1–`MAX_HANGAR_OUTCOME_NOTE_LENGTH` characters). */
  note: string;
  /** The asking client; recorded on the ingest run. */
  actor?: string;
}

export interface RequestHangarOutcomeResult extends RequestInboxItemResult {
  sessionId: string;
  requested: HangarOutcome;
}

/**
 * An agent asks the person to accept or table an ended hangar session
 * (module header): files, or refreshes, the inbox item keyed
 * `hangar-outcome:<session id>`, with the canonical card
 * (`HANGAR_OUTCOME_OPTIONS`, the requested one recommended), a server-written
 * title and content with the agent's note quoted last ("Requested by
 * <actor>:"), and the `hangar_outcome` binding. The key must be new or hold
 * this session's own request (`ReservedInboxItemError` otherwise); a bound
 * item never carries `session`, `pane`, or `socket`. Sets no
 * outcome. Refuses a session that cannot take one now (not ended, or already
 * released: `HangarOutcomeRefusedError`) before anything is written. One
 * item per session: a repeat request while it is pending updates it; once
 * the person has decided or dismissed it, the stored status stands
 * (carryForwardInboxDecisions) and is returned. Never for a session-bound
 * caller: the MCP tool is refused to session tokens.
 */
export async function requestHangarOutcome(db: Database, input: RequestHangarOutcomeInput): Promise<RequestHangarOutcomeResult> {
  if (typeof input.outcome !== "string" || !(HANGAR_OUTCOMES as readonly string[]).includes(input.outcome)) {
    throw new InvalidInboxItemError("outcome", input.outcome, `must be one of ${HANGAR_OUTCOMES.join(", ")}`);
  }
  const requested = input.outcome as HangarOutcome;
  const note = typeof input.note === "string" ? input.note.trim() : "";
  if (note === "" || note.length > MAX_HANGAR_OUTCOME_NOTE_LENGTH || CONTROL_CHAR.test(note)) {
    throw new InvalidInboxItemError("note", input.note, `must say why, in 1 to ${MAX_HANGAR_OUTCOME_NOTE_LENGTH} characters without control characters (other than newline and tab)`);
  }
  const session = await getSessionTakingOutcome(db, input.sessionId);
  const option = requested === "accepted" ? "accept" : "table";
  const actor = input.actor ?? "agent";
  const shortId = session.id.slice(0, 8);
  // The server's facts come first and the agent's note last, quoted line by
  // line, so nothing the agent wrote can read as the server's (module header).
  const lines = [
    `**Accept or Table releases this hangar session: hangar removes its container and deletes its disk at its next check-in.** You can change your choice until then.`,
    "",
    `- Session: \`${session.id}\` (${session.state}, ${session.flavor})`,
    `- Repo: ${markdownCodeSpan(quoteHangarRepo(session.repo))}`,
    ...(session.failureReason === null ? [] : [`- Failure reason: ${session.failureReason}`]),
    ...(session.outcome === null ? [] : [`- Current outcome: ${session.outcome}`]),
    `- Asked for: ${option}`,
    "",
    "---",
    "",
    `Requested by ${actor}:`,
    "",
    ...note.split("\n").map((line) => (line.trim() === "" ? ">" : `> ${line}`)),
  ];
  const result = await fileInboxItem(
    db,
    {
      externalId: `${HANGAR_OUTCOME_KEY_PREFIX}${session.id}`,
      title: fitText(`${option === "accept" ? "Accept" : "Table"} hangar session ${shortId} (repo ${quoteHangarRepo(session.repo)})`, DEFAULT_MAX_TITLE_LENGTH) as string,
      content: fitText(lines.join("\n"), DEFAULT_MAX_CONTENT_LENGTH) as string,
      metadata: {
        source: HANGAR_SOURCE_SYSTEM,
        action: "hangar_outcome",
        question: HANGAR_OUTCOME_QUESTION,
        options: HANGAR_OUTCOME_OPTIONS.map((o) => ({ ...o })),
        recommend: option,
      },
      actor,
    },
    { session_id: session.id, requested },
  );
  return { ...result, sessionId: session.id, requested };
}

/**
 * The executor's last step: an accepted item (or one worked in an
 * interactive session) becomes done, with a
 * `**Done:**` line put at the top of its content. Refuses anything not
 * accepted. Row-locked; attributed to an `agent` ingest run. With
 * `session` (a session-bound caller's), only an item that session filed
 * may be completed (`InboxItemNotThisSessionError` otherwise).
 */
export async function completeInboxItem(db: Database, id: string, note: string, options: { actor?: string; session?: string } = {}): Promise<{ id: string; ingestRunId: string }> {
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
      if (existing.id !== requestedId.toLowerCase()) throw new InboxCardChangedError(requestedId, null, existing.id);
      if (existing.node_type !== INBOX_ITEM_NODE_TYPE) throw new NotAnInboxItemError(existing.id, existing.node_type);
      const current = normalizeInboxItemMetadata(normalizeOccurredAt(existing.metadata));
      if (options.session !== undefined && current["session"] !== options.session.toLowerCase()) throw new InboxItemNotThisSessionError(existing.id, options.session);
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
 * prompted back to that pane like any session item. An item a hangar
 * session filed tells that session it was taken over (a message, in the
 * same transaction, unless the session has ended) and drops `session`, so
 * later decisions go to the local pane. Row-locked, under a `human` ingest
 * run. Pure Postgres.
 */
export async function handOffInboxItem(
  db: Database,
  id: string,
  input: HandOffInboxItemInput,
  options: InboxWriteOptions = {},
): Promise<{ id: string; ingestRunId: string; before: InboxStatus; session: string | null }> {
  const requestedId = typeof id === "string" ? id.trim() : "";
  if (!UUID_RE.test(requestedId)) throw new InvalidLookupIdError(id, "must be a valid uuid");
  for (const [field, value] of [["pane", input.pane], ["socket", input.socket], ["tab", input.tab]] as const) {
    if (typeof value !== "string" || value.trim() === "" || value.length > 512 || CONTROL_CHAR.test(value)) {
      throw new InvalidInboxItemError(field, value, "is required, without control characters");
    }
  }
  const run = await openIngestRun(db, "human", { actor: options.actor ?? "human" });
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
      if (existing.id !== requestedId.toLowerCase()) throw new InboxCardChangedError(requestedId, null, existing.id);
      if (existing.node_type !== INBOX_ITEM_NODE_TYPE) throw new NotAnInboxItemError(existing.id, existing.node_type);
      const current = normalizeInboxItemMetadata(normalizeOccurredAt(existing.metadata));
      const before = current["status"] as InboxStatus;
      if (!INBOX_HANDOFF_STATUSES.includes(before)) throw new InboxDecisionConflictError(existing.id, before);
      const feedback = [...(current["feedback"] as InboxFeedback[]), { decision: "session", message: `opened in herdr tab ${input.tab}`, at: (input.now ?? new Date()).toISOString() }];
      const { live: session } = await itemSession(tx, current);
      const { needs_you: _handedBack, session: _remote, ...rest } = current;
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
      if (session !== null) {
        const text = `[inbox] "${existing.title}" was taken over in a local session; stop work on it. Don't run inbox done for it.`;
        await sendToSession(tx, session, decisionMessageBody({ id: row.id, title: existing.title }, "session", "session", "", undefined, text));
      }
      return { id: row.id, ingestRunId: run.id, before, session };
    });
  } finally {
    await closeIngestRun(db, run);
  }
}
