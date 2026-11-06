// The review contract (board-visual-reviews, design.md decision 1): what a
// review bead's `review` metadata and comment thread look like once they are
// on its work item. Pure — no I/O, nothing throws — so the beads importer,
// the board item read, and the server's image route share one definition.
//
// A review is a beads issue labelled exactly `review` (REVIEW_LABEL);
// `review:changes` is a separate label marking a review sent back, and does
// not by itself make an item a review. Its beads metadata key `review`
// holds `{ images, pane, socket?, summary }`: absolute screenshot paths (at
// most MAX_REVIEW_IMAGES, each under MAX_REVIEW_IMAGE_PATH_LENGTH, no
// control characters), the requester's herdr pane id or null (a letter or
// digit, then letters, digits, `:`, `_`, `.`, `-`; never a flag), the herdr
// server socket that pane id belongs to (pane ids are scoped to one herdr
// server; absolute, at most MAX_REVIEW_SOCKET_PATH_LENGTH, no control
// characters; the key is present only when recorded), and a summary fitted
// to MAX_REVIEW_SUMMARY_LENGTH. `normalizeReviewMetadata` never refuses: a
// value that breaks the contract becomes `{ invalid: true }`, so one bad
// review cannot fail a tracker's load. It is idempotent — a stored
// `{ invalid: true }` normalizes to itself — so readers can re-apply it to
// whatever the store holds. Images are only checked for being absolute here;
// whether one is under REVIEW_IMAGE_ROOT is the image route's question
// (`isInsideReviewRoot`, lexical; the route also realpaths).
//
// Size budget. A node's metadata is capped at 50,000 characters of JSON by
// the write path (DEFAULT_MAX_METADATA_LENGTH), and JSON escaping can grow
// a control character six-fold, so every cap here is on JSON length, not
// string length. A normalized review whose JSON exceeds
// MAX_REVIEW_METADATA_CHARS (16,000) is `{ invalid: true }`.
// `normalizeReviewComments` keeps the last MAX_REVIEW_COMMENTS comments,
// each text fitted to MAX_REVIEW_COMMENT_LENGTH, oldest first, then drops
// the oldest until the list's JSON fits MAX_REVIEW_COMMENTS_CHARS (24,000);
// the newest is always kept, its text cut further if it alone is over. That
// leaves ≥ 10,000 characters for the work item's own keys; beads.ts guards
// the assembled total as well. NUL, which Postgres jsonb refuses, becomes
// U+FFFD in summary and comment fields. The tracker remains authoritative
// for the full thread.
//
// Decision cards (decision-card-reviews, design.md decision 1). Beside the
// legacy keys a review may carry a card: `question` (fitted to
// MAX_REVIEW_QUESTION_LENGTH), `options` (MIN_REVIEW_OPTIONS to
// MAX_REVIEW_OPTIONS of `{ id, label, what?, risk? }`, ids unique and
// matching REVIEW_OPTION_ID_PATTERN), `recommend` (one option's id; only with
// options), `on_accept` (at most MAX_REVIEW_ON_ACCEPT_STEPS strings), and
// `attachments` (at most MAX_REVIEW_ATTACHMENTS of `{ kind: "image", path }`
// or `{ kind: "mermaid" | "diff", source }`, each with optional `caption` and
// `pair` of `before`/`after`; an image path obeys the same rule as `images`).
// A structural break — wrong type, bad or repeated id, missing label,
// dangling recommendation, unknown kind or pair, too many entries — makes the
// review `{ invalid: true }`; over-long text is fitted, never refused (the CLI
// refuses it at authoring time); NUL becomes U+FFFD in every text field.
// Absent, null, and empty card keys (a blank question or `recommend`, an
// empty options, on_accept, or attachments list) are absent in the output,
// and blank on-accept steps are dropped, so a legacy review normalizes
// exactly as it did before cards existed. The whole-review
// JSON cap applies after fitting. The CLI writes the legacy keys too
// (`summary` = question, `images` = image attachment paths), so a reader that
// predates cards still shows the question and the images. `reviewCard` is
// how every reader sees a review as a card, legacy or not.

import os from "node:os";
import path from "node:path";
import { fitText } from "./fit-text.js";

export const REVIEW_LABEL = "review";
export const REVIEW_CHANGES_LABEL = "review:changes";
export const REVIEW_METADATA_KEY = "review";
export const REVIEW_COMMENTS_KEY = "review_comments";
/** bd's `comment_count` at the last load; equal on the next load means the stored thread is carried forward unfetched. */
export const REVIEW_COMMENT_COUNT_KEY = "review_comment_count";

/** Where review screenshots live; the only directory the image route serves. Fixed, no environment variable. */
export const REVIEW_IMAGE_ROOT = path.join(os.homedir(), ".local", "share", "breakdown", "reviews");

export const MAX_REVIEW_IMAGES = 20;
export const MAX_REVIEW_IMAGE_PATH_LENGTH = 512;
export const REVIEW_PANE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,63}$/;
export const MAX_REVIEW_SOCKET_PATH_LENGTH = 512;
export const MAX_REVIEW_SUMMARY_LENGTH = 2000;
export const MAX_REVIEW_COMMENTS = 100;
export const MAX_REVIEW_COMMENT_LENGTH = 4000;
export const MAX_REVIEW_COMMENT_AUTHOR_LENGTH = 200;
export const MAX_REVIEW_COMMENT_ID_LENGTH = 200;
/** Cap on `JSON.stringify(review_comments).length`; see the module header. */
export const MAX_REVIEW_COMMENTS_CHARS = 24_000;
/** Cap on `JSON.stringify(review).length` for a normalized review; over it, the review is invalid. */
export const MAX_REVIEW_METADATA_CHARS = 16_000;

export const MAX_REVIEW_QUESTION_LENGTH = 140;
export const MIN_REVIEW_OPTIONS = 2;
export const MAX_REVIEW_OPTIONS = 6;
/** An option id: a letter or digit, then up to 15 letters, digits, `_`, `-`. */
export const REVIEW_OPTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,15}$/;
export const MAX_REVIEW_OPTION_LABEL_LENGTH = 80;
/** Cap on an option's `what` and on its `risk`. */
export const MAX_REVIEW_OPTION_TEXT_LENGTH = 300;
export const MAX_REVIEW_ON_ACCEPT_STEPS = 8;
export const MAX_REVIEW_ON_ACCEPT_STEP_LENGTH = 200;
export const MAX_REVIEW_ATTACHMENTS = 20;
export const MAX_REVIEW_ATTACHMENT_CAPTION_LENGTH = 200;
/** Cap on a mermaid or diff attachment's `source`. */
export const MAX_REVIEW_ATTACHMENT_SOURCE_LENGTH = 8000;
export const REVIEW_ATTACHMENT_KINDS = ["image", "mermaid", "diff"] as const;
export const REVIEW_ATTACHMENT_PAIRS = ["before", "after"] as const;

// eslint-disable-next-line no-control-regex
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;

/** NUL (refused by Postgres jsonb) replaced by U+FFFD. */
function withoutNul(value: string): string {
  return value.includes("\u0000") ? value.replaceAll("\u0000", "\uFFFD") : value;
}

export type ReviewAttachmentKind = (typeof REVIEW_ATTACHMENT_KINDS)[number];
export type ReviewAttachmentPair = (typeof REVIEW_ATTACHMENT_PAIRS)[number];

export interface ReviewOption {
  id: string;
  label: string;
  what?: string;
  risk?: string;
}

export interface ReviewImageAttachment {
  kind: "image";
  /** Absolute; the same rule as `ReviewMetadata.images`. */
  path: string;
  caption?: string;
  pair?: ReviewAttachmentPair;
}

export interface ReviewSourceAttachment {
  kind: "mermaid" | "diff";
  source: string;
  caption?: string;
  pair?: ReviewAttachmentPair;
}

export type ReviewAttachment = ReviewImageAttachment | ReviewSourceAttachment;

export interface ReviewMetadata {
  images: string[];
  pane: string | null;
  /** The herdr server socket the pane id belongs to; present only when recorded. */
  socket?: string;
  summary: string;
  /** Decision card keys (module header); each present only when the review carries it. */
  question?: string;
  options?: ReviewOption[];
  /** The id of one of `options`. */
  recommend?: string;
  on_accept?: string[];
  attachments?: ReviewAttachment[];
}

/** A review as a card (`reviewCard`): every key present, legacy reviews included. */
export interface ReviewCard {
  question: string;
  options: ReviewOption[];
  recommend: string | null;
  onAccept: string[];
  attachments: ReviewAttachment[];
}

/** A herdr socket path as the review contract accepts it: absolute, bounded, no control characters. Says nothing about whether it exists. */
export function isReviewSocketPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_REVIEW_SOCKET_PATH_LENGTH && !CONTROL_CHAR.test(value) && path.isAbsolute(value);
}

export interface InvalidReview {
  invalid: true;
}

export interface ReviewComment {
  id: string;
  author: string | null;
  text: string;
  /** `toISOString()` form, or null when the source time did not parse. */
  created_at: string | null;
}

const INVALID: InvalidReview = { invalid: true };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** The review contract applied to a raw `review` value; `{ invalid: true }` for anything that breaks it. Never throws. */
export function normalizeReviewMetadata(raw: unknown): ReviewMetadata | InvalidReview {
  if (!isPlainObject(raw)) return { ...INVALID };
  if (raw["invalid"] === true) return { ...INVALID };

  const rawImages = raw["images"];
  let images: string[];
  if (rawImages === undefined || rawImages === null) {
    images = [];
  } else {
    if (!Array.isArray(rawImages) || rawImages.length > MAX_REVIEW_IMAGES) return { ...INVALID };
    for (const image of rawImages) {
      if (!isReviewImagePath(image)) return { ...INVALID };
    }
    images = [...(rawImages as string[])];
  }

  const rawPane = raw["pane"];
  let pane: string | null;
  if (rawPane === undefined || rawPane === null || (typeof rawPane === "string" && rawPane.trim() === "")) {
    pane = null;
  } else {
    if (typeof rawPane !== "string") return { ...INVALID };
    const trimmed = rawPane.trim();
    if (!REVIEW_PANE_PATTERN.test(trimmed)) return { ...INVALID };
    pane = trimmed;
  }

  const rawSocket = raw["socket"];
  let socket: string | undefined;
  if (rawSocket !== undefined && rawSocket !== null && rawSocket !== "") {
    if (!isReviewSocketPath(rawSocket)) return { ...INVALID };
    socket = rawSocket;
  }

  const rawSummary = raw["summary"];
  let summary: string;
  if (rawSummary === undefined || rawSummary === null) {
    summary = "";
  } else {
    if (typeof rawSummary !== "string") return { ...INVALID };
    summary = withoutNul(fitText(rawSummary.trim(), MAX_REVIEW_SUMMARY_LENGTH) ?? "");
  }

  const card = normalizeCard(raw);
  if (card === null) return { ...INVALID };

  const review: ReviewMetadata = socket === undefined ? { images, pane, summary, ...card } : { images, pane, socket, summary, ...card };
  return JSON.stringify(review).length > MAX_REVIEW_METADATA_CHARS ? { ...INVALID } : review;
}

/** An image path as the review contract accepts it: absolute, bounded, no control characters. */
function isReviewImagePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_REVIEW_IMAGE_PATH_LENGTH && !CONTROL_CHAR.test(value) && path.isAbsolute(value);
}

const ABSENT = Symbol("absent");
type Fitted = string | typeof ABSENT | null;

/** Card text trimmed, fitted, and trimmed again (a cut can land on a space; re-normalizing must not move it), NUL replaced. */
function cardText(value: string, max: number): string {
  return withoutNul((fitText(value.trim(), max) ?? "").trimEnd());
}

/** An optional text field: absent, null, or blank → ABSENT; a non-string → null (invalid); else `cardText`. */
function optionalText(value: unknown, max: number): Fitted {
  if (value === undefined || value === null) return ABSENT;
  if (typeof value !== "string") return null;
  const text = cardText(value, max);
  return text === "" ? ABSENT : text;
}

type Card = Pick<ReviewMetadata, "question" | "options" | "recommend" | "on_accept" | "attachments">;

/** The card keys of a raw review, normalized; null when one breaks the contract. Keys absent, null, or empty are left out. */
function normalizeCard(raw: Record<string, unknown>): Card | null {
  const card: Card = {};

  const question = optionalText(raw["question"], MAX_REVIEW_QUESTION_LENGTH);
  if (question === null) return null;
  if (question !== ABSENT) card.question = question;

  const rawOptions = raw["options"];
  if (rawOptions !== undefined && rawOptions !== null && !(Array.isArray(rawOptions) && rawOptions.length === 0)) {
    if (!Array.isArray(rawOptions) || rawOptions.length < MIN_REVIEW_OPTIONS || rawOptions.length > MAX_REVIEW_OPTIONS) return null;
    const options: ReviewOption[] = [];
    const ids = new Set<string>();
    for (const rawOption of rawOptions) {
      if (!isPlainObject(rawOption)) return null;
      const id = rawOption["id"];
      if (typeof id !== "string" || !REVIEW_OPTION_ID_PATTERN.test(id) || ids.has(id)) return null;
      ids.add(id);
      const label = optionalText(rawOption["label"], MAX_REVIEW_OPTION_LABEL_LENGTH);
      const what = optionalText(rawOption["what"], MAX_REVIEW_OPTION_TEXT_LENGTH);
      const risk = optionalText(rawOption["risk"], MAX_REVIEW_OPTION_TEXT_LENGTH);
      if (label === null || label === ABSENT || what === null || risk === null) return null;
      options.push({ id, label, ...(what === ABSENT ? {} : { what }), ...(risk === ABSENT ? {} : { risk }) });
    }
    card.options = options;
  }

  const recommend = raw["recommend"];
  if (recommend !== undefined && recommend !== null && recommend !== "") {
    if (typeof recommend !== "string" || card.options === undefined || !card.options.some((o) => o.id === recommend)) return null;
    card.recommend = recommend;
  }

  const rawSteps = raw["on_accept"];
  if (rawSteps !== undefined && rawSteps !== null) {
    if (!Array.isArray(rawSteps) || rawSteps.length > MAX_REVIEW_ON_ACCEPT_STEPS) return null;
    const steps: string[] = [];
    for (const step of rawSteps) {
      if (typeof step !== "string") return null;
      const text = cardText(step, MAX_REVIEW_ON_ACCEPT_STEP_LENGTH);
      if (text !== "") steps.push(text);
    }
    if (steps.length > 0) card.on_accept = steps;
  }

  const rawAttachments = raw["attachments"];
  if (rawAttachments !== undefined && rawAttachments !== null) {
    if (!Array.isArray(rawAttachments) || rawAttachments.length > MAX_REVIEW_ATTACHMENTS) return null;
    const attachments: ReviewAttachment[] = [];
    for (const rawAttachment of rawAttachments) {
      const attachment = normalizeAttachment(rawAttachment);
      if (attachment === null) return null;
      attachments.push(attachment);
    }
    if (attachments.length > 0) card.attachments = attachments;
  }

  return card;
}

function normalizeAttachment(raw: unknown): ReviewAttachment | null {
  if (!isPlainObject(raw)) return null;
  const caption = optionalText(raw["caption"], MAX_REVIEW_ATTACHMENT_CAPTION_LENGTH);
  if (caption === null) return null;
  const rawPair = raw["pair"];
  let pair: ReviewAttachmentPair | undefined;
  if (rawPair !== undefined && rawPair !== null) {
    if (!(REVIEW_ATTACHMENT_PAIRS as readonly unknown[]).includes(rawPair)) return null;
    pair = rawPair as ReviewAttachmentPair;
  }
  const extras = { ...(caption === ABSENT ? {} : { caption }), ...(pair === undefined ? {} : { pair }) };

  const kind = raw["kind"];
  if (kind === "image") {
    const imagePath = raw["path"];
    if (!isReviewImagePath(imagePath)) return null;
    return { kind, path: imagePath, ...extras };
  }
  if (kind === "mermaid" || kind === "diff") {
    const source = raw["source"];
    if (typeof source !== "string") return null;
    return { kind, source: withoutNul(fitText(source, MAX_REVIEW_ATTACHMENT_SOURCE_LENGTH) ?? ""), ...extras };
  }
  return null;
}

/** The first line of `text`, trimmed and fitted to MAX_REVIEW_QUESTION_LENGTH; "" when there is none. */
function firstLineQuestion(text: string): string {
  return (fitText((text.split(/\r\n|\r|\n/, 1)[0] ?? "").trim(), MAX_REVIEW_QUESTION_LENGTH) ?? "").trimEnd();
}

/** `images` paths that no image attachment carries, as bare image attachments, in order. */
function unattachedImages(review: ReviewMetadata): ReviewAttachment[] {
  const attached = new Set((review.attachments ?? []).flatMap((a) => (a.kind === "image" ? [a.path] : [])));
  return review.images.filter((imagePath) => !attached.has(imagePath)).map((imagePath) => ({ kind: "image", path: imagePath }));
}

/**
 * A normalized review as a card, the one way readers see it: the question,
 * else the summary's first line fitted to MAX_REVIEW_QUESTION_LENGTH; the
 * attachments, else `images` as image attachments without caption or pair.
 * A legacy review is therefore a question-only card with its images. When a
 * review has attachments, any `images` path no image attachment carries is
 * appended as a bare image attachment, so a hand-edited review never hides a
 * screenshot the legacy keys still list. Pure.
 */
export function reviewCard(review: ReviewMetadata): ReviewCard {
  return {
    question: review.question ?? firstLineQuestion(review.summary),
    options: review.options ?? [],
    recommend: review.recommend ?? null,
    onAccept: review.on_accept ?? [],
    attachments: [...(review.attachments ?? []), ...unattachedImages(review)],
  };
}

function toIsoOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/**
 * A raw comment list (`bd comments <id> --json`, or what the store holds)
 * under the contract: rows without string `text` dropped, fields fitted,
 * oldest first (unparseable times first, then input order), last
 * MAX_REVIEW_COMMENTS, then oldest dropped until the list fits
 * MAX_REVIEW_COMMENTS_CHARS — the newest is always kept, its text cut
 * further if it alone is over. NUL becomes U+FFFD. Idempotent, so a stored
 * thread re-normalizes to itself. Non-array → [].
 */
export function normalizeReviewComments(raw: unknown): ReviewComment[] {
  if (!Array.isArray(raw)) return [];
  const comments: ReviewComment[] = [];
  for (const row of raw) {
    if (!isPlainObject(row) || typeof row["text"] !== "string") continue;
    const id = row["id"];
    const author = typeof row["author"] === "string" ? withoutNul(fitText(row["author"], MAX_REVIEW_COMMENT_AUTHOR_LENGTH) ?? "") : "";
    comments.push({
      id: id === undefined || id === null ? "" : withoutNul(fitText(String(id), MAX_REVIEW_COMMENT_ID_LENGTH) ?? ""),
      author: author === "" ? null : author,
      text: withoutNul(fitText(row["text"], MAX_REVIEW_COMMENT_LENGTH) ?? ""),
      created_at: toIsoOrNull(row["created_at"]),
    });
  }
  // Array.prototype.sort is stable, so equal times keep input order.
  comments.sort((a, b) => {
    if (a.created_at === b.created_at) return 0;
    if (a.created_at === null) return -1;
    if (b.created_at === null) return 1;
    return a.created_at < b.created_at ? -1 : 1;
  });
  let kept = comments.slice(-MAX_REVIEW_COMMENTS);
  while (kept.length > 1 && JSON.stringify(kept).length > MAX_REVIEW_COMMENTS_CHARS) {
    kept = kept.slice(1);
  }
  // The newest alone can still be over (escaping): keep the longest prefix
  // of its text that fits, by binary search. id and author are capped far
  // under budget, so an empty text always fits.
  const newest = kept[0];
  const fits = (text: string) => JSON.stringify([{ ...newest, text }]).length <= MAX_REVIEW_COMMENTS_CHARS;
  if (kept.length === 1 && newest && !fits(newest.text)) {
    let lo = 0;
    let hi = newest.text.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (fits(fitText(newest.text, mid) ?? "")) lo = mid;
      else hi = mid - 1;
    }
    kept = [{ ...newest, text: fitText(newest.text, lo) ?? "" }];
  }
  return kept;
}

/**
 * Lexical containment: true iff `candidate`, resolved, is strictly inside
 * `root` (the root itself is not). No filesystem access — a symlink inside
 * the root that points out passes here; the image route realpaths too.
 */
export function isInsideReviewRoot(candidate: string, root: string = REVIEW_IMAGE_ROOT): boolean {
  const rel = path.relative(root, path.resolve(candidate));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}
