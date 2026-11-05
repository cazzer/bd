// The pending review queue (review-queue change, design.md decision 1;
// review-queue spec, "Pending reviews form a queue"): every review an agent
// is waiting on, across every registered beads project, oldest request
// first, in ONE SQL statement.
//
// Pending means: a canonical `work_item` (via resolved_nodes, so a
// merged-away duplicate is never listed — its survivor is, when the
// survivor itself is pending) of a registered project (`registered`, the
// board's own CTE from board.ts), labelled `review` exactly, not labelled
// `review:changes` (a sent-back review is the agent's turn, not the
// person's), and not closed (a missing status reads open, like
// `readWorkItemFields`). The project and the `review` label are one
// containment per registered key — `{"project": k, "labels": ["review"]}` —
// which nodes_metadata_gin_idx (jsonb_path_ops) serves, and which, like the
// board's review flag, matches only a labels ARRAY holding the exact string.
//
// Order is the request time, then id. The request time is `occurred_at` (the
// bead's creation instant, written by the loader in the fixed-width
// `toISOString()` form, so text order is time order) when it has that form,
// else the row's `created_at` rendered in the same form — so a raw-written
// or pre-contract value can neither fail the statement (no cast) nor sort
// out of place. `count(*) OVER ()` is computed before the LIMIT, so `total`
// is every pending review and `truncated` is `total > reviews.length`; no
// limit + 1 probe row is needed.
//
// The summary line and image count are read off the stored `review` object
// re-normalized here (reviews.ts, idempotent), so the queue and the drawer
// share one contract: the summary's first line, cut to
// MAX_REVIEW_SUMMARY_LINE_LENGTH, and the number of images. A review that
// breaks the contract (`{ invalid: true }`) or is absent reads as no summary
// and zero images; the item stays in the queue.

import { sql } from "drizzle-orm";
import type { Database } from "@breakdown/db";
import { registeredProjectsCte } from "./board.js";
import { InvalidLookupOptionError, LookupFailedError } from "./errors.js";
import { fitText } from "./fit-text.js";
import { normalizeReviewMetadata, REVIEW_CHANGES_LABEL, REVIEW_LABEL, REVIEW_METADATA_KEY } from "./reviews.js";
import { asPgError, formatPgInfo } from "./sql-helpers.js";
import { WORK_ITEM_NODE_TYPE } from "./work-items.js";

/** Most pending reviews one read returns (and the default); `total` still counts every one. */
export const MAX_PENDING_REVIEWS = 100;
/** Longest summary line a queue row carries. */
export const MAX_REVIEW_SUMMARY_LINE_LENGTH = 200;

/** The `toISOString()` form `occurred_at` is stored in (event-time.ts). */
const CANONICAL_INSTANT_PATTERN = "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$";

export interface PendingReviewsOptions {
  /** Reviews to return, 1..MAX_PENDING_REVIEWS; defaults to MAX_PENDING_REVIEWS. */
  limit?: number;
}

export interface PendingReview {
  /** Canonical node id of the work item. */
  id: string;
  /** The project key (`metadata.project`). */
  project: string;
  /** The bead id (the work item's external id, as the board addresses it). */
  externalId: string;
  title: string;
  /** First line of the review summary, at most MAX_REVIEW_SUMMARY_LINE_LENGTH; null when there is none or the review is invalid. */
  summaryLine: string | null;
  /** Images attached to the review; 0 when there are none or the review is invalid. */
  imageCount: number;
  /** When the review was requested: `occurred_at`, else when the row was first written. */
  requestedAt: Date;
}

export interface PendingReviews {
  /** Oldest request first, then node id. */
  reviews: PendingReview[];
  /** Every pending review, including any past the limit. */
  total: number;
  /** True when `total` exceeds the reviews returned. */
  truncated: boolean;
}

type RawPendingRow = {
  id: string;
  project: string;
  external_id: string;
  title: string;
  review: unknown;
  requested_at: string;
  total: string | number;
};

/** The first line of a review summary, fitted; null for an empty one. */
function summaryLineOf(summary: string): string | null {
  const first = (summary.split(/\r\n|\r|\n/, 1)[0] ?? "").trim();
  return first === "" ? null : (fitText(first, MAX_REVIEW_SUMMARY_LINE_LENGTH) ?? null);
}

/**
 * The pending review queue (module header). One statement, one round trip;
 * creates, changes, and deletes nothing. Throws `InvalidLookupOptionError`
 * for a bad limit and `LookupFailedError` for a database failure.
 */
export async function listPendingReviews(db: Database, options: PendingReviewsOptions = {}): Promise<PendingReviews> {
  const limit = options.limit ?? MAX_PENDING_REVIEWS;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PENDING_REVIEWS) {
    throw new InvalidLookupOptionError("limit", limit, `must be an integer from 1 to ${MAX_PENDING_REVIEWS}`);
  }
  let result: { rows: RawPendingRow[] };
  try {
    result = await db.execute<RawPendingRow>(sql`
WITH
${registeredProjectsCte()}
SELECT n.id, n.metadata->>'project' AS project, n.external_id, n.title,
       n.metadata->(${REVIEW_METADATA_KEY}::text) AS review,
       CASE WHEN n.metadata->>'occurred_at' ~ ${CANONICAL_INSTANT_PATTERN}
            THEN n.metadata->>'occurred_at'
            ELSE to_char(n.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END AS requested_at,
       count(*) OVER () AS total
FROM resolved_nodes n
WHERE n.node_type = ${WORK_ITEM_NODE_TYPE}
  AND n.metadata @> ANY (ARRAY(SELECT jsonb_build_object('project', r.key, 'labels', ${JSON.stringify([REVIEW_LABEL])}::jsonb) FROM registered r))
  AND NOT n.metadata @> ${JSON.stringify({ labels: [REVIEW_CHANGES_LABEL] })}::jsonb
  AND COALESCE(n.metadata->>'status', 'open') <> 'closed'
ORDER BY requested_at, n.id
LIMIT ${limit}::int
`);
  } catch (err) {
    throw new LookupFailedError(`listPendingReviews query failed${formatPgInfo(asPgError(err))}`, "listPendingReviews", { cause: err });
  }
  const reviews = result.rows.map((r): PendingReview => {
    const review = r.review === null || r.review === undefined ? null : normalizeReviewMetadata(r.review);
    const valid = review !== null && !("invalid" in review) ? review : null;
    return {
      id: r.id,
      project: r.project,
      externalId: r.external_id,
      title: r.title,
      summaryLine: valid === null ? null : summaryLineOf(valid.summary),
      imageCount: valid === null ? 0 : valid.images.length,
      requestedAt: new Date(r.requested_at),
    };
  });
  const total = result.rows.length === 0 ? 0 : Number(result.rows[0]!.total);
  return { reviews, total, truncated: total > reviews.length };
}
