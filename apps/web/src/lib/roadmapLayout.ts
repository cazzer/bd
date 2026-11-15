// The roadmap's timeline geometry (roadmap-milestones, design.md decision 7;
// work-roadmap spec, "The roadmap lays milestones and epics on a timeline"):
// the shared axis, its week ticks, where each bar, remaining segment, and
// marker sits along it, what is overdue, how a date and a progress count
// read. Pure — "today" and "now" are passed in — so every rule here is
// unit-tested without a clock or a browser.
//
// Everything is in whole UTC calendar days. A stored date is an instant, but
// the roadmap shows calendar dates in UTC, so a date-only due date
// (`2026-12-15T00:00:00.000Z`) is Dec 15 in every zone and never shifts a
// day. "Today" is the reader's own calendar date, placed on the same UTC day
// grid (`calendarToday`), so a milestone due "Nov 15" is not overdue on the
// reader's Nov 15 and is from their Nov 16, whatever their zone. West of UTC
// in the evening, an instant that has already happened can fall on the UTC
// day after the reader's today; a bar never runs past today for that
// (`barSpan` clamps it), since nothing that has happened lies in the future.
//
// Positions are fractions of the axis (0 at its left edge, 1 at its right),
// for the view to turn into percentages. A day is a cell: a bar covers its
// start day through its end day inclusive, and a marker (target, due date,
// today) sits at the middle of its day.

/** One UTC day, in ms. */
export const DAY_MS = 86_400_000;
/** One week, in ms: the axis's tick spacing. */
export const WEEK_MS = 7 * DAY_MS;
/** How far the axis runs past its earliest and latest date, each side. */
export const AXIS_PAD_DAYS = 7;
/** Dates further than this from today do not widen the axis (a typo'd year must not shrink every week to a sliver); their rows still label them. */
export const AXIS_REACH_DAYS = 2 * 365;

/** Counts of an epic's or milestone's items by status group (packages/core/src/roadmap.ts `RoadmapProgress`). */
export interface ProgressCounts {
  total: number;
  closed: number;
  inProgress: number;
  deferred: number;
  open: number;
}

/** The UTC midnight (ms) of an instant's UTC calendar date; null for an absent or unreadable date. */
export function utcDay(iso: string | null | undefined): number | null {
  if (iso === null || iso === undefined) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

/** The reader's calendar date (in their own zone), as the UTC midnight of that date: "today" on the axis. */
export function calendarToday(now: Date): number {
  return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
}

/** Milliseconds until the reader's next local midnight, when "today" changes. */
export function msUntilLocalMidnight(now: Date): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return next.getTime() - now.getTime();
}

const MONTH_DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const MONTH_DAY_YEAR = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const MONTH = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" });
const MONTH_YEAR = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" });

/**
 * A stored date as a calendar date in UTC: "Dec 15", with the year when it
 * is not `today`'s year ("Feb 15, 2027"). Null for an absent or unreadable
 * date.
 */
export function formatRoadmapDate(iso: string | null | undefined, today: number): string | null {
  const day = utcDay(iso);
  if (day === null) return null;
  const sameYear = new Date(day).getUTCFullYear() === new Date(today).getUTCFullYear();
  return (sameYear ? MONTH_DAY : MONTH_DAY_YEAR).format(day);
}

/** A UTC day's month and year ("Nov 2026"): the timeline's sticky month label. */
export function formatMonthYear(day: number): string {
  return MONTH_YEAR.format(day);
}

/** The share of counted items that are closed, 0..1: closed / (total − deferred). Null when nothing is counted (no items, or every item deferred). */
export function progressShare(progress: ProgressCounts): number | null {
  const counted = progress.total - progress.deferred;
  return counted > 0 ? progress.closed / counted : null;
}

/** A share as a whole percentage ("75%"); a share below 1% that is not 0 reads "<1%", one above 99% that is not 1 reads ">99%", so neither rounds to a false 0% or 100%. */
export function formatShare(share: number): string {
  if (share > 0 && share < 0.01) return "<1%";
  if (share < 1 && share > 0.99) return ">99%";
  return `${Math.round(share * 100)}%`;
}

/** How a row's progress reads: nothing yet, everything deferred (no share), or a share with its in-progress and deferred counts. */
export type ProgressReading =
  | { kind: "empty"; text: string }
  | { kind: "deferred"; text: string }
  | { kind: "share"; share: number; text: string; inProgress: number; deferred: number };

export function describeProgress(progress: ProgressCounts): ProgressReading {
  if (progress.total === 0) return { kind: "empty", text: "No items yet" };
  const share = progressShare(progress);
  if (share === null) return { kind: "deferred", text: progress.deferred === 1 ? "Its one item deferred" : `All ${progress.deferred} deferred` };
  return { kind: "share", share, text: formatShare(share), inProgress: progress.inProgress, deferred: progress.deferred };
}

/** The dates that place one row on the axis. */
export interface RowDates {
  /** Bar start: the epic's own `startedAt`, else its first item's. Null for a milestone or an epic not started. */
  start: string | null;
  /** Bar end: `closedAt`; null while open (the bar runs to today). */
  end: string | null;
  /** Target / due date; null when it has none. */
  target: string | null;
}

/** An epic's dates: start = its own `startedAt` ?? its first item's; target = its own `dueAt` ?? its milestone's. */
export function epicDates(epic: {
  startedAt: string | null;
  firstStartedAt: string | null;
  closedAt: string | null;
  dueAt: string | null;
  milestone: { dueAt: string | null } | null;
}): RowDates & { targetFromMilestone: boolean } {
  const own = utcDay(epic.dueAt) !== null;
  return {
    start: utcDay(epic.startedAt) !== null ? epic.startedAt : epic.firstStartedAt,
    end: epic.closedAt,
    target: own ? epic.dueAt : (epic.milestone?.dueAt ?? null),
    targetFromMilestone: !own && utcDay(epic.milestone?.dueAt) !== null,
  };
}

/** Open (not closed) and its target day is before today. */
export function isOverdue(status: string, target: string | null, today: number): boolean {
  const day = utcDay(target);
  return status !== "closed" && day !== null && day < today;
}

export interface AxisTick {
  /** UTC midnight of the tick's Monday. */
  day: number;
  /** Fraction of the axis. */
  at: number;
  /** The month's name on the first tick of a month (and on the axis's first tick); null otherwise. Carries the year on January and on the first tick. */
  monthLabel: string | null;
}

export interface Axis {
  /** UTC midnight of the axis's first day (a Monday). */
  start: number;
  /** UTC midnight just past the axis's last day (a Monday): `end − start` is a whole number of weeks. */
  end: number;
  weeks: number;
  ticks: AxisTick[];
}

/** The Monday on or before a UTC day. */
function mondayOnOrBefore(day: number): number {
  const weekday = (new Date(day).getUTCDay() + 6) % 7; // Monday 0 … Sunday 6
  return day - weekday * DAY_MS;
}

/**
 * The shared axis: from the earliest bar start or target to the latest
 * target, bar end, or today, padded AXIS_PAD_DAYS each side and widened to
 * whole weeks (Monday to Monday). Dates more than AXIS_REACH_DAYS from today
 * are left out of the sizing. With no dates at all it is the weeks around
 * today, so the today line always shows.
 */
export function buildAxis(rows: readonly RowDates[], today: number): Axis {
  let min = today;
  let max = today;
  const reach = AXIS_REACH_DAYS * DAY_MS;
  for (const row of rows) {
    for (const day of [utcDay(row.start), utcDay(row.end), utcDay(row.target)]) {
      if (day === null || Math.abs(day - today) > reach) continue;
      if (day < min) min = day;
      if (day > max) max = day;
    }
  }
  const start = mondayOnOrBefore(min - AXIS_PAD_DAYS * DAY_MS);
  const end = mondayOnOrBefore(max + AXIS_PAD_DAYS * DAY_MS) + WEEK_MS;
  const weeks = Math.round((end - start) / WEEK_MS);
  const ticks: AxisTick[] = [];
  for (let i = 0; i < weeks; i++) {
    const day = start + i * WEEK_MS;
    const date = new Date(day);
    const firstOfMonth = date.getUTCDate() <= 7;
    const withYear = i === 0 || date.getUTCMonth() === 0;
    ticks.push({ day, at: i / weeks, monthLabel: i === 0 || firstOfMonth ? (withYear ? MONTH_YEAR : MONTH).format(day) : null });
  }
  return { start, end, weeks, ticks };
}

/** A UTC day's left edge as a fraction of the axis. */
function edge(axis: Axis, day: number): number {
  return (day - axis.start) / (axis.end - axis.start);
}

/** True when a fraction lies on the axis (a date beyond its reach does not). */
export function onAxis(at: number): boolean {
  return at >= 0 && at <= 1;
}

/** Where a marker for a date sits (the middle of its day), or null for no date. */
export function markerAt(axis: Axis, iso: string | null): number | null {
  const day = utcDay(iso);
  return day === null ? null : edge(axis, day + DAY_MS / 2);
}

/** Where today's line sits. */
export function todayAt(axis: Axis, today: number): number {
  return edge(axis, today + DAY_MS / 2);
}

/** The UTC day at a fraction of the axis (for the sticky month label at the visible left edge). */
export function dayAt(axis: Axis, at: number): number {
  return Math.floor((axis.start + at * (axis.end - axis.start)) / DAY_MS) * DAY_MS;
}

/**
 * Whether a week tick's day-of-month label would sit under the Today pill:
 * the label runs `labelPx` right of its tick, the pill `pillHalfPx` either
 * side of today's middle, and a day is `dayPx` wide.
 */
export function tickUnderToday(tickDay: number, today: number, dayPx: number, labelPx = 18, pillHalfPx = 24): boolean {
  const tickX = ((tickDay - today) / DAY_MS) * dayPx;
  const todayX = dayPx / 2;
  return tickX + labelPx > todayX - pillHalfPx && tickX < todayX + pillHalfPx;
}

/** The day an instant places a bar edge on: its UTC day, but never past today once it has happened (see the module header). */
function barDay(iso: string | null, today: number, now: number): number | null {
  const day = utcDay(iso);
  if (day === null) return null;
  return Date.parse(iso!) <= now ? Math.min(day, today) : day;
}

export interface BarSpan {
  /** Left edge, fraction of the axis. */
  from: number;
  /** Right edge, fraction of the axis; always > from. */
  to: number;
  /** True while open: the bar runs to today. */
  running: boolean;
}

/** An epic's worked bar: its start day through its end day (or today while open), inclusive. Null when it has not started — no bar. */
export function barSpan(axis: Axis, dates: RowDates, today: number, now: number): BarSpan | null {
  const start = barDay(dates.start, today, now);
  if (start === null) return null;
  const closed = barDay(dates.end, today, now);
  const last = Math.max(start, closed ?? today);
  return { from: edge(axis, start), to: edge(axis, last + DAY_MS), running: closed === null };
}

export interface RemainingSpan {
  from: number;
  to: number;
  /** True once the target has passed: the span runs from the target to today. */
  overdue: boolean;
}

/**
 * An open row's remaining span, between today and its target: from the end
 * of today to the target's marker while the target is ahead, from the
 * target's marker to the end of today once it has passed (overdue). None
 * for a closed row, one with no target, or one due today.
 */
export function remainingSpan(axis: Axis, status: string, target: string | null, today: number): RemainingSpan | null {
  const day = utcDay(target);
  if (status === "closed" || day === null || day === today) return null;
  const targetAt = edge(axis, day + DAY_MS / 2);
  const todayEnd = edge(axis, today + DAY_MS);
  return day > today ? { from: todayEnd, to: targetAt, overdue: false } : { from: targetAt, to: todayEnd, overdue: true };
}
