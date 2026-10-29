// The review contract (board-visual-reviews, design.md decision 1): what a
// review bead's `review` metadata and comment thread look like once they are
// on its work item. Pure — no I/O, nothing throws — so the beads importer,
// the board item read, and the server's image route share one definition.
//
// A review is a beads issue labelled exactly `review` (REVIEW_LABEL);
// `review:changes` is a separate label marking a review sent back, and does
// not by itself make an item a review. Its beads metadata key `review`
// holds `{ images, pane, summary }`: absolute screenshot paths (at most
// MAX_REVIEW_IMAGES, each under MAX_REVIEW_IMAGE_PATH_LENGTH, no NUL), the
// requester's herdr pane id or null, and a summary fitted to
// MAX_REVIEW_SUMMARY_LENGTH. `normalizeReviewMetadata` never refuses: a
// value that breaks the contract becomes `{ invalid: true }`, so one bad
// review cannot fail a tracker's load. It is idempotent — a stored
// `{ invalid: true }` normalizes to itself — so readers can re-apply it to
// whatever the store holds. Images are only checked for being absolute here;
// whether one is under REVIEW_IMAGE_ROOT is the image route's question
// (`isInsideReviewRoot`, lexical; the route also realpaths).
//
// Comment budget. A node's serialized metadata is capped at 50,000
// characters by the write path (DEFAULT_MAX_METADATA_LENGTH), and a review's
// comment thread is the one part of it that grows without bound in the
// tracker. `normalizeReviewComments` keeps the last MAX_REVIEW_COMMENTS
// comments, each text fitted to MAX_REVIEW_COMMENT_LENGTH, oldest first, and
// then drops the oldest until the JSON of the list fits
// MAX_REVIEW_COMMENTS_CHARS (24,000) — leaving room for the review object
// (≈ 12k at its caps) and the work item's own keys. The newest comment is
// always kept. The tracker remains authoritative for the full thread.

import os from "node:os";
import path from "node:path";
import { fitText } from "./fit-text.js";

export const REVIEW_LABEL = "review";
export const REVIEW_CHANGES_LABEL = "review:changes";
export const REVIEW_METADATA_KEY = "review";
export const REVIEW_COMMENTS_KEY = "review_comments";

/** Where review screenshots live; the only directory the image route serves. Fixed, no environment variable. */
export const REVIEW_IMAGE_ROOT = path.join(os.homedir(), ".local", "share", "breakdown", "reviews");

export const MAX_REVIEW_IMAGES = 20;
export const MAX_REVIEW_IMAGE_PATH_LENGTH = 512;
export const REVIEW_PANE_PATTERN = /^[A-Za-z0-9:_.-]{1,64}$/;
export const MAX_REVIEW_SUMMARY_LENGTH = 2000;
export const MAX_REVIEW_COMMENTS = 100;
export const MAX_REVIEW_COMMENT_LENGTH = 4000;
export const MAX_REVIEW_COMMENT_AUTHOR_LENGTH = 200;
/** Cap on `JSON.stringify(review_comments).length`; see the module header. */
export const MAX_REVIEW_COMMENTS_CHARS = 24_000;

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
      if (typeof image !== "string" || image.length === 0 || image.length > MAX_REVIEW_IMAGE_PATH_LENGTH || image.includes("\u0000") || !path.isAbsolute(image)) {
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
    summary = fitText(rawSummary.trim(), MAX_REVIEW_SUMMARY_LENGTH) ?? "";
  }

  return { images, pane, summary };
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
 * MAX_REVIEW_COMMENTS_CHARS — the newest is always kept. Non-array → [].
 */
export function normalizeReviewComments(raw: unknown): ReviewComment[] {
  if (!Array.isArray(raw)) return [];
  const comments: ReviewComment[] = [];
  for (const row of raw) {
    if (!isPlainObject(row) || typeof row["text"] !== "string") continue;
    const id = row["id"];
    const author = typeof row["author"] === "string" ? (fitText(row["author"], MAX_REVIEW_COMMENT_AUTHOR_LENGTH) ?? "") : "";
    comments.push({
      id: id === undefined || id === null ? "" : String(id),
      author: author === "" ? null : author,
      text: fitText(row["text"], MAX_REVIEW_COMMENT_LENGTH) ?? "",
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
