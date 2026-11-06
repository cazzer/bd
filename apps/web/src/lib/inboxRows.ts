// The inbox's Needs me list (unify-review-queues, design.md decision 4):
// the pending top-level inbox items and the open board reviews the shell's
// review queue already reads, in one list — priority, then oldest first —
// narrowed by a source filter. Pure, so the order and the filter are tested
// without a DOM.
//
// A review has no priority of its own; it ranks as P1, because an agent is
// blocked on it while it waits.

export const REVIEW_SOURCE = "review";
export const REVIEW_PRIORITY = 1;

export interface InboxRowItem {
  id: string;
  status: string;
  parentId: string | null;
  priority: number;
  source: string;
  /** ISO time. */
  receivedAt: string;
}

export interface QueueReviewRow {
  project: string;
  externalId: string;
  /** ISO time. */
  requestedAt: string;
}

export type NeedsMeRow<I extends InboxRowItem, R extends QueueReviewRow> =
  | { kind: "inbox"; key: string; priority: number; at: string; source: string; item: I }
  | { kind: "review"; key: string; priority: number; at: string; source: typeof REVIEW_SOURCE; review: R };

/** A review's address in the inbox (`?item=`): `<project>/<bead>`. An inbox item's is its uuid, which never holds a slash. */
export function reviewKey(review: QueueReviewRow): string {
  return `${review.project}/${review.externalId}`;
}

export function needsMeRows<I extends InboxRowItem, R extends QueueReviewRow>(items: readonly I[], reviews: readonly R[]): NeedsMeRow<I, R>[] {
  const rows: NeedsMeRow<I, R>[] = [];
  for (const item of items) {
    if (item.parentId === null && item.status === "pending") rows.push({ kind: "inbox", key: item.id, priority: item.priority, at: item.receivedAt, source: item.source, item });
  }
  for (const review of reviews) rows.push({ kind: "review", key: reviewKey(review), priority: REVIEW_PRIORITY, at: review.requestedAt, source: REVIEW_SOURCE, review });
  return rows.sort((a, b) => a.priority - b.priority || Date.parse(a.at) - Date.parse(b.at) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** The rows of one source; all of them for `null`. */
export function filterBySource<T extends { source: string }>(rows: readonly T[], source: string | null): T[] {
  return source === null ? [...rows] : rows.filter((r) => r.source === source);
}

/** The sources present, reviews first, then by name: the filter's chips. */
export function sourcesOf(rows: readonly { source: string }[]): string[] {
  const set = new Set(rows.map((r) => r.source));
  const rest = [...set].filter((s) => s !== REVIEW_SOURCE).sort();
  return set.has(REVIEW_SOURCE) ? [REVIEW_SOURCE, ...rest] : rest;
}
