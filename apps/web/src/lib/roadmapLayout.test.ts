import { describe, expect, it } from "vitest";
import {
  barSpan,
  buildAxis,
  calendarToday,
  DAY_MS,
  epicDates,
  formatRoadmapDate,
  formatShare,
  isOverdue,
  markerAt,
  progressShare,
  todayAt,
  utcDay,
  type ProgressCounts,
  type RowDates,
} from "./roadmapLayout.js";

const day = (iso: string) => utcDay(`${iso}T00:00:00.000Z`)!;
const TODAY = day("2026-11-15"); // a Sunday
const progress = (over: Partial<ProgressCounts>): ProgressCounts => ({ total: 0, closed: 0, inProgress: 0, deferred: 0, open: 0, ...over });
const row = (over: Partial<RowDates>): RowDates => ({ start: null, end: null, target: null, ...over });

describe("utcDay and calendarToday", () => {
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
});

describe("formatRoadmapDate", () => {
  it("reads a date-only due date as its calendar date in UTC, never a day earlier", () => {
    expect(formatRoadmapDate("2026-12-15T00:00:00.000Z", TODAY)).toBe("Dec 15");
    expect(formatRoadmapDate("2026-12-15T23:59:00.000Z", TODAY)).toBe("Dec 15");
  });

  it("names the year only when it is not today's", () => {
    expect(formatRoadmapDate("2027-02-15T00:00:00.000Z", TODAY)).toBe("Feb 15, 2027");
  });

  it("is null for no date", () => {
    expect(formatRoadmapDate(null, TODAY)).toBeNull();
  });
});

describe("progressShare", () => {
  it("is closed over counted items, leaving deferred out", () => {
    expect(progressShare(progress({ total: 4, closed: 3, open: 1 }))).toBe(0.75);
    expect(progressShare(progress({ total: 5, closed: 2, open: 2, deferred: 1 }))).toBe(0.5);
  });

  it("is none with no items, or every item deferred — not 0% or 100%", () => {
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

  it("labels a month on its first week, with the year on the first tick and on January", () => {
    const axis = buildAxis([row({ start: "2026-11-20T00:00:00.000Z", target: "2027-01-20T00:00:00.000Z" })], TODAY);
    const labels = axis.ticks.filter((t) => t.monthLabel !== null).map((t) => [new Date(t.day).toISOString().slice(0, 10), t.monthLabel]);
    expect(labels).toEqual([
      ["2026-11-02", "Nov 2026"],
      ["2026-12-07", "Dec"],
      ["2027-01-04", "Jan 2027"],
    ]);
  });
});

describe("positions", () => {
  const axis = buildAxis([row({ start: "2026-10-12T00:00:00.000Z", target: "2026-12-01T00:00:00.000Z" })], TODAY);
  const span = axis.end - axis.start;

  it("put a marker at the middle of its UTC day", () => {
    expect(markerAt(axis, "2026-12-01T00:00:00.000Z")).toBeCloseTo((day("2026-12-01") + DAY_MS / 2 - axis.start) / span);
    expect(markerAt(axis, "2026-12-01T22:00:00.000Z")).toBe(markerAt(axis, "2026-12-01T00:00:00.000Z"));
    expect(markerAt(axis, null)).toBeNull();
    expect(todayAt(axis, TODAY)).toBeCloseTo((TODAY + DAY_MS / 2 - axis.start) / span);
  });

  it("run an open epic's bar from its start day through today", () => {
    const bar = barSpan(axis, row({ start: "2026-10-12T15:00:00.000Z" }), TODAY)!;
    expect(bar.from).toBeCloseTo((day("2026-10-12") - axis.start) / span);
    expect(bar.to).toBeCloseTo((TODAY + DAY_MS - axis.start) / span);
    expect(bar.running).toBe(true);
  });

  it("end a closed epic's bar on its close day, and give a same-day bar a day's width", () => {
    const bar = barSpan(axis, row({ start: "2026-10-12T15:00:00.000Z", end: "2026-10-12T18:00:00.000Z" }), TODAY)!;
    expect(bar.to - bar.from).toBeCloseTo(DAY_MS / span);
    expect(bar.running).toBe(false);
  });

  it("draw no bar for an epic not started", () => {
    expect(barSpan(axis, row({ target: "2026-12-01T00:00:00.000Z" }), TODAY)).toBeNull();
  });
});
