// The review contract (board-visual-reviews, design.md decision 1): what a
// review bead's `review` metadata and comment thread look like once they are
// on its work item. Pure — no I/O, nothing throws — so the beads importer,
// the board item read, and the server's image route share one definition.
//
// A review is a beads issue labelled exactly `review` (REVIEW_LABEL);
// `review:changes` is a separate label marking a review sent back, and does
// not by itself make an item a review. Its beads metadata key `review`
// holds `{ images, pane, summary }`: absolute screenshot paths (at most
// MAX_REVIEW_IMAGES, each under MAX_REVIEW_IMAGE_PATH_LENGTH, no control
// characters), the requester's herdr pane id or null, and a summary fitted
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
export const REVIEW_PANE_PATTERN = /^[A-Za-z0-9:_.-]{1,64}$/;
export const MAX_REVIEW_SUMMARY_LENGTH = 2000;
export const MAX_REVIEW_COMMENTS = 100;
export const MAX_REVIEW_COMMENT_LENGTH = 4000;
export const MAX_REVIEW_COMMENT_AUTHOR_LENGTH = 200;
export const MAX_REVIEW_COMMENT_ID_LENGTH = 200;
/** Cap on `JSON.stringify(review_comments).length`; see the module header. */
export const MAX_REVIEW_COMMENTS_CHARS = 24_000;
/** Cap on `JSON.stringify(review).length` for a normalized review; over it, the review is invalid. */
export const MAX_REVIEW_METADATA_CHARS = 16_000;

// eslint-disable-next-line no-control-regex
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;

/** NUL (refused by Postgres jsonb) replaced by U+FFFD. */
function withoutNul(value: string): string {
  return value.includes("\u0000") ? value.replaceAll("\u0000", "\uFFFD") : value;
}

export interface ReviewMetadata {
  images: string[];
  pane: string | null;
  summary: string;
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
      if (typeof image !== "string" || image.length === 0 || image.length > MAX_REVIEW_IMAGE_PATH_LENGTH || CONTROL_CHAR.test(image) || !path.isAbsolute(image)) {
        return { ...INVALID };
      }
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

  const rawSummary = raw["summary"];
  let summary: string;
  if (rawSummary === undefined || rawSummary === null) {
    summary = "";
  } else {
    if (typeof rawSummary !== "string") return { ...INVALID };
    summary = withoutNul(fitText(rawSummary.trim(), MAX_REVIEW_SUMMARY_LENGTH) ?? "");
  }

  const review: ReviewMetadata = { images, pane, summary };
  return JSON.stringify(review).length > MAX_REVIEW_METADATA_CHARS ? { ...INVALID } : review;
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
