import { describe, expect, it } from "vitest";
import {
  AXIS_REACH_DAYS,
  barSpan,
  buildAxis,
  calendarToday,
  DAY_MS,
  dayAt,
  describeProgress,
  epicDates,
  formatMonthYear,
  formatRoadmapDate,
  formatShare,
  isOverdue,
  markerAt,
  msUntilLocalMidnight,
  onAxis,
  progressShare,
  remainingSpan,
  tickUnderToday,
  todayAt,
  utcDay,
  type ProgressCounts,
  type RowDates,
} from "./roadmapLayout.js";

const day = (iso: string) => utcDay(`${iso}T00:00:00.000Z`)!;
const TODAY = day("2026-11-15"); // a Sunday
const NOW = Date.parse("2026-11-15T20:00:00.000Z");
const progress = (over: Partial<ProgressCounts>): ProgressCounts => ({ total: 0, closed: 0, inProgress: 0, deferred: 0, open: 0, ...over });
const row = (over: Partial<RowDates>): RowDates => ({ start: null, end: null, target: null, ...over });

describe("utcDay, calendarToday, and the midnight refresh", () => {
  it("floor an instant to its UTC calendar date, and read absent or unreadable dates as null", () => {
    expect(utcDay("2026-12-15T23:59:59.999Z")).toBe(Date.UTC(2026, 11, 15));
    expect(utcDay("2026-12-15T00:00:00.000Z")).toBe(Date.UTC(2026, 11, 15));
    expect(utcDay(null)).toBeNull();
    expect(utcDay("not a date")).toBeNull();
  });

  it("place the reader's own calendar date on the UTC day grid", () => {
    // Local 23:30 on Nov 15 is still the reader's Nov 15, whatever UTC says.
    expect(calendarToday(new Date(2026, 10, 15, 23, 30))).toBe(Date.UTC(2026, 10, 15));
    expect(calendarToday(new Date(2026, 10, 15, 0, 5))).toBe(Date.UTC(2026, 10, 15));
  });

  it("counts down to the reader's next local midnight", () => {
    expect(msUntilLocalMidnight(new Date(2026, 10, 15, 23, 30))).toBe(30 * 60_000);
  });
});

describe("formatRoadmapDate", () => {
  it("reads a date-only due date as its calendar date in UTC, never a day earlier", () => {
    expect(formatRoadmapDate("2026-12-15T00:00:00.000Z", TODAY)).toBe("Dec 15");
    expect(formatRoadmapDate("2026-12-15T23:59:00.000Z", TODAY)).toBe("Dec 15");
  });

  it("names the year only when it is not today's", () => {
    expect(formatRoadmapDate("2027-02-15T00:00:00.000Z", TODAY)).toBe("Feb 15, 2027");
    expect(formatMonthYear(day("2027-02-15"))).toBe("Feb 2027");
  });

  it("is null for no date", () => {
    expect(formatRoadmapDate(null, TODAY)).toBeNull();
  });
});

describe("progress", () => {
  it("shares closed over counted items, leaving deferred out", () => {
    expect(progressShare(progress({ total: 4, closed: 3, open: 1 }))).toBe(0.75);
    expect(progressShare(progress({ total: 5, closed: 2, open: 2, deferred: 1 }))).toBe(0.5);
  });

  it("has no share with no items, or every item deferred — not 0% or 100%", () => {
    expect(progressShare(progress({}))).toBeNull();
    expect(progressShare(progress({ total: 2, deferred: 2 }))).toBeNull();
  });

  it("formats as a whole percentage that never rounds to a false 0% or 100%", () => {
    expect(formatShare(0.75)).toBe("75%");
    expect(formatShare(0)).toBe("0%");
    expect(formatShare(1)).toBe("100%");
    expect(formatShare(1 / 300)).toBe("<1%");
    expect(formatShare(299 / 300)).toBe(">99%");
  });

  it("reads No items yet, All N deferred, or the share with its counts", () => {
    expect(describeProgress(progress({}))).toEqual({ kind: "empty", text: "No items yet" });
    expect(describeProgress(progress({ total: 2, deferred: 2 }))).toEqual({ kind: "deferred", text: "All 2 deferred" });
    expect(describeProgress(progress({ total: 1, deferred: 1 }))).toEqual({ kind: "deferred", text: "Its one item deferred" });
    expect(describeProgress(progress({ total: 5, closed: 2, inProgress: 1, open: 1, deferred: 1 }))).toEqual({ kind: "share", share: 0.5, text: "50%", inProgress: 1, deferred: 1 });
  });
});

describe("epicDates", () => {
  const base = { startedAt: null, firstStartedAt: null, closedAt: null, dueAt: null, milestone: null };

  it("starts at the epic's own start, else its first item's", () => {
    expect(epicDates({ ...base, startedAt: "2026-10-01T00:00:00.000Z", firstStartedAt: "2026-09-01T00:00:00.000Z" }).start).toBe("2026-10-01T00:00:00.000Z");
    expect(epicDates({ ...base, firstStartedAt: "2026-09-01T00:00:00.000Z" }).start).toBe("2026-09-01T00:00:00.000Z");
  });

  it("targets its own due date, else its milestone's", () => {
    const milestone = { dueAt: "2026-12-01T00:00:00.000Z" };
    expect(epicDates({ ...base, dueAt: "2026-11-25T00:00:00.000Z", milestone })).toMatchObject({ target: "2026-11-25T00:00:00.000Z", targetFromMilestone: false });
    expect(epicDates({ ...base, milestone })).toMatchObject({ target: "2026-12-01T00:00:00.000Z", targetFromMilestone: true });
    expect(epicDates(base)).toMatchObject({ target: null, targetFromMilestone: false });
  });
});

describe("isOverdue", () => {
  it("marks an open row whose target was yesterday", () => {
    expect(isOverdue("open", "2026-11-14T00:00:00.000Z", TODAY)).toBe(true);
    expect(isOverdue("in_progress", "2026-11-14T00:00:00.000Z", TODAY)).toBe(true);
  });

  it("does not mark one due today, one closed, or one with no target", () => {
    expect(isOverdue("open", "2026-11-15T00:00:00.000Z", TODAY)).toBe(false);
    expect(isOverdue("closed", "2026-11-01T00:00:00.000Z", TODAY)).toBe(false);
    expect(isOverdue("open", null, TODAY)).toBe(false);
  });
});

describe("buildAxis", () => {
  it("runs from the earliest start or target to the latest target or today, a week's padding each side, Monday to Monday", () => {
    const axis = buildAxis([row({ start: "2026-10-14T09:00:00.000Z", target: "2026-12-01T00:00:00.000Z" })], TODAY);
    // Oct 14 − 7 = Oct 7 (Wed) → Monday Oct 5; Dec 1 + 7 = Dec 8 (Tue) → Monday Dec 7, end Dec 14.
    expect(new Date(axis.start).toISOString().slice(0, 10)).toBe("2026-10-05");
    expect(new Date(axis.end).toISOString().slice(0, 10)).toBe("2026-12-14");
    expect(axis.weeks).toBe(10);
    expect(axis.ticks).toHaveLength(10);
    expect(axis.ticks.every((t) => new Date(t.day).getUTCDay() === 1)).toBe(true);
  });

  it("reaches today when every date is earlier", () => {
    const axis = buildAxis([row({ target: "2026-09-01T00:00:00.000Z" })], TODAY);
    expect(axis.end).toBeGreaterThan(TODAY + 7 * DAY_MS - 1);
    expect(axis.start).toBeLessThanOrEqual(day("2026-08-25"));
  });

  it("is the weeks around today with no dates at all", () => {
    const axis = buildAxis([row({})], TODAY);
    expect(axis.start).toBeLessThan(TODAY);
    expect(axis.end).toBeGreaterThan(TODAY);
    expect(axis.weeks).toBe(3);
  });

  it("is not stretched by a date more than two years away, which then lies off the axis", () => {
    const far = "2036-01-01T00:00:00.000Z";
    const axis = buildAxis([row({ target: far }), row({ target: "2026-12-01T00:00:00.000Z" })], TODAY);
    expect(axis.end).toBeLessThan(TODAY + AXIS_REACH_DAYS * DAY_MS);
    expect(axis.weeks).toBeLessThan(8);
    expect(onAxis(markerAt(axis, far)!)).toBe(false);
    expect(onAxis(markerAt(axis, "2026-12-01T00:00:00.000Z")!)).toBe(true);
  });

  it("labels a month on its first week, with the year on the first tick and on January", () => {
    const axis = buildAxis([row({ start: "2026-11-20T00:00:00.000Z", target: "2027-01-20T00:00:00.000Z" })], TODAY);
    const labels = axis.ticks.filter((t) => t.monthLabel !== null).map((t) => [new Date(t.day).toISOString().slice(0, 10), t.monthLabel]);
    expect(labels).toEqual([
      ["2026-11-02", "Nov 2026"],
      ["2026-12-07", "Dec"],
      ["2027-01-04", "Jan 2027"],
    ]);
  });

  it("names the day at a fraction of it", () => {
    const axis = buildAxis([row({})], TODAY);
    expect(dayAt(axis, 0)).toBe(axis.start);
    expect(dayAt(axis, todayAt(axis, TODAY))).toBe(TODAY);
  });
});

describe("tickUnderToday", () => {
  it("hides the label of a tick a day or so either side of today, and keeps one a week away", () => {
    const dayPx = 8;
    expect(tickUnderToday(day("2026-11-16"), TODAY, dayPx)).toBe(true);
    expect(tickUnderToday(day("2026-11-13"), TODAY, dayPx)).toBe(true);
    expect(tickUnderToday(day("2026-11-09"), TODAY, dayPx)).toBe(false);
    expect(tickUnderToday(day("2026-11-23"), TODAY, dayPx)).toBe(false);
  });
});

describe("positions", () => {
  const axis = buildAxis([row({ start: "2026-10-12T00:00:00.000Z", target: "2026-12-01T00:00:00.000Z" })], TODAY);
  const span = axis.end - axis.start;
  const at = (d: number) => (d - axis.start) / span;

  it("put a marker at the middle of its UTC day", () => {
    expect(markerAt(axis, "2026-12-01T00:00:00.000Z")).toBeCloseTo(at(day("2026-12-01") + DAY_MS / 2));
    expect(markerAt(axis, "2026-12-01T22:00:00.000Z")).toBe(markerAt(axis, "2026-12-01T00:00:00.000Z"));
    expect(markerAt(axis, null)).toBeNull();
    expect(todayAt(axis, TODAY)).toBeCloseTo(at(TODAY + DAY_MS / 2));
  });

  it("run an open epic's bar from its start day through today", () => {
    const bar = barSpan(axis, row({ start: "2026-10-12T15:00:00.000Z" }), TODAY, NOW)!;
    expect(bar.from).toBeCloseTo(at(day("2026-10-12")));
    expect(bar.to).toBeCloseTo(at(TODAY + DAY_MS));
    expect(bar.running).toBe(true);
  });

  it("end a closed epic's bar on its close day, and give a same-day bar a day's width", () => {
    const bar = barSpan(axis, row({ start: "2026-10-12T15:00:00.000Z", end: "2026-10-12T18:00:00.000Z" }), TODAY, NOW)!;
    expect(bar.to - bar.from).toBeCloseTo(DAY_MS / span);
    expect(bar.running).toBe(false);
  });

  it("never run a bar past today for work claimed this evening, west of UTC", () => {
    // The reader's Nov 15, 20:00 in UTC−8, is Nov 16 04:00 UTC; the claim an hour earlier falls on UTC Nov 16.
    const now = Date.parse("2026-11-16T04:00:00.000Z");
    const bar = barSpan(axis, row({ start: "2026-11-16T03:00:00.000Z" }), TODAY, now)!;
    expect(bar.from).toBeCloseTo(at(TODAY));
    expect(bar.to).toBeCloseTo(at(TODAY + DAY_MS));
    const closed = barSpan(axis, row({ start: "2026-11-10T00:00:00.000Z", end: "2026-11-16T03:30:00.000Z" }), TODAY, now)!;
    expect(closed.to).toBeCloseTo(at(TODAY + DAY_MS));
  });

  it("draw no bar for an epic not started", () => {
    expect(barSpan(axis, row({ target: "2026-12-01T00:00:00.000Z" }), TODAY, NOW)).toBeNull();
  });
});

describe("remainingSpan", () => {
  const axis = buildAxis([row({ start: "2026-10-12T00:00:00.000Z", target: "2026-12-01T00:00:00.000Z" })], TODAY);
  const span = axis.end - axis.start;
  const at = (d: number) => (d - axis.start) / span;

  it("runs from the end of today to a target ahead", () => {
    const r = remainingSpan(axis, "open", "2026-11-25T00:00:00.000Z", TODAY)!;
    expect(r).toMatchObject({ overdue: false });
    expect(r.from).toBeCloseTo(at(TODAY + DAY_MS));
    expect(r.to).toBeCloseTo(at(day("2026-11-25") + DAY_MS / 2));
  });

  it("runs from a passed target to today, overdue", () => {
    const r = remainingSpan(axis, "in_progress", "2026-11-10T00:00:00.000Z", TODAY)!;
    expect(r).toMatchObject({ overdue: true });
    expect(r.from).toBeCloseTo(at(day("2026-11-10") + DAY_MS / 2));
    expect(r.to).toBeCloseTo(at(TODAY + DAY_MS));
  });

  it("is none for a closed row, no target, or a target of today", () => {
    expect(remainingSpan(axis, "closed", "2026-11-25T00:00:00.000Z", TODAY)).toBeNull();
    expect(remainingSpan(axis, "open", null, TODAY)).toBeNull();
    expect(remainingSpan(axis, "open", "2026-11-15T00:00:00.000Z", TODAY)).toBeNull();
  });
});
