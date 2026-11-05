// Pure helpers behind the review queue's pill and popover (review-queue,
// design.md decisions 3-4): how a request's age reads, what each row and
// the pill say to a screen reader, the truncation note, arrow-key movement
// through the rows, where the popover sits under its pill, and where focus
// goes when the shell's drawer closes.
// Structural types only, so nothing from the server reaches the bundle.

import type { LiveState } from "./liveStream.js";

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

/** The pill's accessible name: the count and the live state ("3 reviews waiting, live"). */
export function pillLabel(total: number, loaded: boolean, live: LiveState): string {
  const state = live === "connecting" ? "connecting" : live;
  if (!loaded) return `Review queue not read yet, ${state}`;
  if (total === 0) return `No reviews waiting, ${state}`;
  return `${total} review${total === 1 ? "" : "s"} waiting, ${state}`;
}

/** "Showing 100 of 120" when the queue holds more than the read returned; null otherwise. */
export function truncationNote(shown: number, total: number, truncated: boolean): string | null {
  if (!truncated || total <= shown) return null;
  return `Showing ${shown} of ${total}`;
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
