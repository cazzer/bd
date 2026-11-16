// Pure helpers behind the review queue's pill and popover (review-queue,
// design.md decisions 3-4): how a request's age reads, what each row and
// the pill say to a screen reader, the order and staleness lines, what the
// status region announces, arrow-key movement
// through the rows, where the popover sits under its pill, and where focus
// goes when the shell's drawer closes, and where its footer links go.
// Structural types only, so nothing from the server reaches the bundle.

import type { LiveState } from "./liveStream.js";
import type { BoardRoute, InboxRoute } from "./route.js";

/** Where the popover's "Open the board" goes before projects are carried: the plain board. */
export const BOARD_HOME: BoardRoute = { view: "board", viewId: null, projects: [], item: null };
/** Where its "Go to inbox" goes before projects are carried: the inbox on Needs me (its first tab). */
export const INBOX_HOME: InboxRoute = { view: "inbox", item: null, projects: [] };

/** The slice of a queue row these helpers read (`PendingReviewDto`). */
export interface QueueRow {
  id: string;
  project: string;
  externalId: string;
  title: string;
  summaryLine: string | null;
  imageCount: number;
  requestedAt: string;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * How long ago a review was requested, at the popover's width: "now" under
 * a minute, then whole minutes ("4m"), hours ("2h"), days ("3d"), rounded
 * down. A time in the future (clock skew) reads as "now"; an unreadable one
 * as the empty string.
 */
export function formatAge(requestedAt: string, now: number): string {
  const at = Date.parse(requestedAt);
  if (Number.isNaN(at)) return "";
  const elapsed = now - at;
  if (elapsed < MINUTE_MS) return "now";
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)}m`;
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)}h`;
  return `${Math.floor(elapsed / DAY_MS)}d`;
}

/** The age spelled out for a screen reader ("4 minutes ago"). */
export function spokenAge(requestedAt: string, now: number): string {
  const age = formatAge(requestedAt, now);
  if (age === "") return "";
  if (age === "now") return "just now";
  const n = Number(age.slice(0, -1));
  const unit = age.endsWith("m") ? "minute" : age.endsWith("h") ? "hour" : "day";
  return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
}

export function formatImageCount(n: number): string {
  if (n <= 0) return "No screenshots";
  return `${n} screenshot${n === 1 ? "" : "s"}`;
}

/** A row's accessible name: title first (what a person scans for), then where it is from and how old. */
export function rowLabel(row: QueueRow, now: number): string {
  const parts = [row.title.trim() || "(untitled)", `${row.project} ${row.externalId}`, formatImageCount(row.imageCount).toLowerCase()];
  const age = spokenAge(row.requestedAt, now);
  if (age !== "") parts.push(`requested ${age}`);
  return parts.join(", ");
}

const LIVE_TEXT: Readonly<Record<LiveState, string>> = { live: "Live", connecting: "Connecting…", offline: "Offline" };

/** The word beside the status light. */
export function liveText(live: LiveState): string {
  return LIVE_TEXT[live];
}

/** The pill's count badge: "3 reviews", "1 review", "0 reviews", or "…" before the first read lands. */
export function countText(total: number, loaded: boolean): string {
  if (!loaded) return "…";
  return `${total} review${total === 1 ? "" : "s"}`;
}

/** The waiting count as words: "3 reviews waiting", "1 review waiting", "No reviews waiting". */
export function waitingText(total: number): string {
  if (total === 0) return "No reviews waiting";
  return `${total} review${total === 1 ? "" : "s"} waiting`;
}

/** The live state as the pill's accessible name begins: "Live", "Connecting", "Offline". */
export function liveLabel(live: LiveState): string {
  return live === "live" ? "Live" : live === "connecting" ? "Connecting" : "Offline";
}

/** The review count for a screen reader: "2 reviews pending", "1 review pending", "no reviews pending", or "review queue not read yet". */
export function reviewCountLabel(total: number, loaded: boolean): string {
  if (!loaded) return "review queue not read yet";
  if (total === 0) return "no reviews pending";
  return `${total} review${total === 1 ? "" : "s"} pending`;
}

/** The inbox count for a screen reader: "3 inbox items need you", "1 inbox item needs you". */
export function inboxCountLabel(count: number): string {
  return count === 1 ? "1 inbox item needs you" : `${count} inbox items need you`;
}

/**
 * The review control's name, in the order it reads: the live state, the
 * reviews, then the inbox items when there are any to count ("Live, 2
 * reviews pending, 3 inbox items need you"). A null inbox count (not read,
 * or the read failed) and a zero say nothing about the inbox.
 */
export function pillLabel(total: number, loaded: boolean, live: LiveState, inbox: number | null = null): string {
  const parts = [liveLabel(live), reviewCountLabel(total, loaded)];
  if (inbox !== null && inbox > 0) parts.push(inboxCountLabel(inbox));
  return parts.join(", ");
}

/** The popover's "Go to inbox" link text: with the inbox count when there is one ("Go to inbox · 3 need you"). */
export function inboxLinkText(inbox: number | null): string {
  return inbox !== null && inbox > 0 ? `Go to inbox · ${inbox} need you` : "Go to inbox";
}

/** The popover's empty state: no reviews, and the inbox items waiting when the count is known and above 0. */
export function emptyQueueText(loaded: boolean, inbox: number | null): string {
  if (!loaded) return "Reading the queue…";
  if (inbox === null || inbox <= 0) return "No reviews waiting";
  return `No reviews waiting — ${inboxCountLabel(inbox)}`;
}

/** The order line under the popover's header: "Oldest first", or "Oldest 100 of 120" when the read was cut short. */
export function orderNote(shown: number, total: number, truncated: boolean): string {
  if (!truncated || total <= shown) return "Oldest first";
  return `Oldest ${shown} of ${total}`;
}

/** The popover's staleness line while the stream is not live; null while it is. */
export function staleNote(live: LiveState): string | null {
  if (live === "live") return null;
  if (live === "connecting") return "Reconnecting…";
  return "Live updates offline — this list may be out of date.";
}

/** How long a live state must hold before the status region speaks of it. */
export const LIVE_ANNOUNCE_HOLD_MS = 3000;

/**
 * What the status region says when the stream settles in `next` (held for
 * LIVE_ANNOUNCE_HOLD_MS), given the state it last settled in: only a lasting
 * change between live and offline is spoken. The first settled state (page
 * load) and anything about connecting are not.
 */
export function liveAnnouncement(previous: LiveState | null, next: LiveState): string | null {
  if (previous === null || next === "connecting" || previous === next) return null;
  if (next === "offline") return "Live updates offline";
  return previous === "offline" ? "Live updates back on" : null;
}

/** What the status region says when the count changes after the first read; null for the first read or no change. */
export function countAnnouncement(previous: number | null, total: number): string | null {
  if (previous === null || previous === total) return null;
  return waitingText(total);
}

/** The row an arrow key moves to from `index` among `length` rows (no wrap); null for a key that does not move. */
export function moveActive(index: number, key: string, length: number): number | null {
  if (length <= 0) return null;
  switch (key) {
    case "ArrowDown":
      return Math.min(index + 1, length - 1);
    case "ArrowUp":
      return Math.max(index - 1, 0);
    case "Home":
      return 0;
    case "End":
      return length - 1;
    default:
      return null;
  }
}

/**
 * Where focus goes when the shell's drawer closes (review-queue spec,
 * "Reviews are decided from the queue"): back to the row that opened it
 * while that review is still queued, else to the pill.
 */
export function focusReturnTarget(pickedId: string, rows: ReadonlyArray<{ id: string }>): { kind: "row"; id: string } | { kind: "pill" } {
  return rows.some((r) => r.id === pickedId) ? { kind: "row", id: pickedId } : { kind: "pill" };
}

/**
 * The row to keep active when the list changes under the popover: the same
 * review when it is still there, else the one now at its old position (the
 * next one down), else the last; -1 for an empty list.
 */
export function reconcileActive(activeId: string | null, previousIndex: number, rows: ReadonlyArray<{ id: string }>): number {
  if (rows.length === 0) return -1;
  if (activeId !== null) {
    const found = rows.findIndex((r) => r.id === activeId);
    if (found >= 0) return found;
  }
  return Math.min(Math.max(previousIndex, 0), rows.length - 1);
}

/** The popover's width: 400 px, or the viewport less a 12 px gutter each side when that is narrower. */
export const POPOVER_WIDTH_PX = 400;
export const POPOVER_GUTTER_PX = 12;

/**
 * Where the popover sits for a pill at `rect`: 8 px under it, right edges
 * aligned, kept at least a gutter inside both edges of the viewport (a pill
 * that wrapped toward the middle of a phone header must not push it off the
 * left).
 */
export function popoverPlacement(rect: { bottom: number; right: number }, viewportWidth: number): { top: number; right: number; width: number } {
  const width = Math.min(POPOVER_WIDTH_PX, viewportWidth - 2 * POPOVER_GUTTER_PX);
  const right = Math.min(Math.max(POPOVER_GUTTER_PX, viewportWidth - rect.right), viewportWidth - POPOVER_GUTTER_PX - width);
  return { top: rect.bottom + 8, right, width };
}
