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
  /** The work item it is about (inbox-follow-through); absent or null when unlinked. */
  about?: { id: string; title: string } | null;
}

export interface QueueReviewRow {
  project: string;
  externalId: string;
  /** ISO time. */
  requestedAt: string;
  /** The work item the review is a child of (split-review-decisions); absent or null when it has none. */
  parent?: { id: string; title: string } | null;
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

/** Where a row sits in a work group: the group's work item, its size, and whether the row is the group's first. */
export interface WorkGroupSlot {
  workId: string;
  title: string;
  count: number;
  first: boolean;
}

/**
 * Needs me grouped by work context (inbox-follow-through, design.md decision
 * 9): rows about the same work item, when there are two or more of them, are
 * pulled together at the first one's place, keeping their order; everything
 * else keeps its place. An inbox row's work is the item it is `about`; a
 * review row's is its parent work item (split-review-decisions, design.md
 * decision 6). Both are canonical work_item node ids, so a review and an
 * inbox item about the same work group together. Returns the reordered rows
 * and, for each grouped row's key, its slot. Pure, and order-stable for a
 * stable input.
 */
export function groupByWork<T extends { kind: string; key: string; item?: InboxRowItem; review?: QueueReviewRow }>(rows: readonly T[]): { rows: T[]; slots: Map<string, WorkGroupSlot> } {
  const workOf = (row: T): { id: string; title: string } | null =>
    row.kind === "inbox" ? (row.item?.about ?? null) : row.kind === "review" ? (row.review?.parent ?? null) : null;
  const members = new Map<string, T[]>();
  for (const row of rows) {
    const work = workOf(row);
    if (work === null) continue;
    const list = members.get(work.id);
    if (list === undefined) members.set(work.id, [row]);
    else list.push(row);
  }
  const slots = new Map<string, WorkGroupSlot>();
  const out: T[] = [];
  const emitted = new Set<string>();
  for (const row of rows) {
    const work = workOf(row);
    const group = work === null ? undefined : members.get(work.id);
    if (work === null || group === undefined || group.length < 2) {
      out.push(row);
      continue;
    }
    if (emitted.has(work.id)) continue;
    emitted.add(work.id);
    group.forEach((member, i) => {
      out.push(member);
      slots.set(member.key, { workId: work.id, title: work.title, count: group.length, first: i === 0 });
    });
  }
  return { rows: out, slots };
}
