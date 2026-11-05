// Tests for lib/reviewQueueRow.ts (review-queue, tasks.md 5.5): ages, row
// and pill labels, the truncation note, arrow movement, and where focus
// returns when the shell's drawer closes.

import { describe, expect, it } from "vitest";
import {
  countText,
  focusReturnTarget,
  formatAge,
  formatImageCount,
  liveText,
  moveActive,
  pillLabel,
  popoverPlacement,
  reconcileActive,
  rowLabel,
  spokenAge,
  truncationNote,
  type QueueRow,
} from "./reviewQueueRow.js";

const NOW = Date.parse("2026-11-05T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("formatAge", () => {
  it("reads under a minute as now, then whole minutes, hours, days, rounded down", () => {
    expect(formatAge(ago(0), NOW)).toBe("now");
    expect(formatAge(ago(59_999), NOW)).toBe("now");
    expect(formatAge(ago(MIN), NOW)).toBe("1m");
    expect(formatAge(ago(4 * MIN + 59_000), NOW)).toBe("4m");
    expect(formatAge(ago(HOUR - 1), NOW)).toBe("59m");
    expect(formatAge(ago(HOUR), NOW)).toBe("1h");
    expect(formatAge(ago(2 * HOUR + 30 * MIN), NOW)).toBe("2h");
    expect(formatAge(ago(DAY - 1), NOW)).toBe("23h");
    expect(formatAge(ago(DAY), NOW)).toBe("1d");
    expect(formatAge(ago(45 * DAY), NOW)).toBe("45d");
  });

  it("reads a future instant (clock skew) as now and an unreadable one as empty", () => {
    expect(formatAge(new Date(NOW + 5 * MIN).toISOString(), NOW)).toBe("now");
    expect(formatAge("not a date", NOW)).toBe("");
  });
});

describe("spokenAge", () => {
  it("spells the age out with singular and plural units", () => {
    expect(spokenAge(ago(10_000), NOW)).toBe("just now");
    expect(spokenAge(ago(MIN), NOW)).toBe("1 minute ago");
    expect(spokenAge(ago(4 * MIN), NOW)).toBe("4 minutes ago");
    expect(spokenAge(ago(HOUR), NOW)).toBe("1 hour ago");
    expect(spokenAge(ago(3 * DAY), NOW)).toBe("3 days ago");
    expect(spokenAge("nope", NOW)).toBe("");
  });
});

describe("formatImageCount", () => {
  it("says none, one, or many", () => {
    expect(formatImageCount(0)).toBe("No screenshots");
    expect(formatImageCount(1)).toBe("1 screenshot");
    expect(formatImageCount(8)).toBe("8 screenshots");
  });
});

describe("rowLabel", () => {
  const row: QueueRow = { id: "n1", project: "tides", externalId: "tides-zec.20.1", title: "Keep the labels clear", summaryLine: "Seasons tour", imageCount: 8, requestedAt: ago(4 * MIN) };

  it("leads with the title, then project and bead id, screenshots, and age", () => {
    expect(rowLabel(row, NOW)).toBe("Keep the labels clear, tides tides-zec.20.1, 8 screenshots, requested 4 minutes ago");
  });

  it("names an untitled review and drops an unreadable age", () => {
    expect(rowLabel({ ...row, title: "  ", imageCount: 0, requestedAt: "?" }, NOW)).toBe("(untitled), tides tides-zec.20.1, no screenshots");
  });
});

describe("pill text", () => {
  it("names each live state", () => {
    expect(liveText("live")).toBe("Live");
    expect(liveText("connecting")).toBe("Connecting…");
    expect(liveText("offline")).toBe("Offline");
  });

  it("counts reviews, with a placeholder before the first read", () => {
    expect(countText(3, true)).toBe("3 reviews");
    expect(countText(1, true)).toBe("1 review");
    expect(countText(0, true)).toBe("0 reviews");
    expect(countText(0, false)).toBe("…");
  });

  it("carries the count and the live state in the accessible name; zero reads as an empty queue", () => {
    expect(pillLabel(3, true, "live")).toBe("3 reviews waiting, live");
    expect(pillLabel(1, true, "connecting")).toBe("1 review waiting, connecting");
    expect(pillLabel(0, true, "offline")).toBe("No reviews waiting, offline");
    expect(pillLabel(0, false, "connecting")).toBe("Review queue not read yet, connecting");
  });
});

describe("truncationNote", () => {
  it("says how many are shown of how many only when the read was cut short", () => {
    expect(truncationNote(100, 120, true)).toBe("Showing 100 of 120");
    expect(truncationNote(3, 3, false)).toBeNull();
    expect(truncationNote(100, 100, true)).toBeNull();
  });
});

describe("moveActive", () => {
  it("moves down and up without wrapping, and Home/End jump to the ends", () => {
    expect(moveActive(0, "ArrowDown", 3)).toBe(1);
    expect(moveActive(2, "ArrowDown", 3)).toBe(2);
    expect(moveActive(1, "ArrowUp", 3)).toBe(0);
    expect(moveActive(0, "ArrowUp", 3)).toBe(0);
    expect(moveActive(1, "Home", 3)).toBe(0);
    expect(moveActive(0, "End", 3)).toBe(2);
  });

  it("ignores other keys and an empty list", () => {
    expect(moveActive(0, "Enter", 3)).toBeNull();
    expect(moveActive(0, "ArrowDown", 0)).toBeNull();
  });
});

describe("focusReturnTarget", () => {
  const rows = [{ id: "a" }, { id: "b" }];

  it("returns to the row while the review is still queued", () => {
    expect(focusReturnTarget("b", rows)).toEqual({ kind: "row", id: "b" });
  });

  it("returns to the pill once the review has left the queue", () => {
    expect(focusReturnTarget("c", rows)).toEqual({ kind: "pill" });
    expect(focusReturnTarget("a", [])).toEqual({ kind: "pill" });
  });
});

describe("reconcileActive", () => {
  const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("follows the active review when it moved", () => {
    expect(reconcileActive("c", 0, rows)).toBe(2);
  });

  it("takes the row now at the old position when the active review left, else the last", () => {
    expect(reconcileActive("x", 1, rows)).toBe(1);
    expect(reconcileActive("x", 5, rows)).toBe(2);
    expect(reconcileActive(null, -1, rows)).toBe(0);
  });

  it("is -1 for an empty list", () => {
    expect(reconcileActive("a", 0, [])).toBe(-1);
  });
});

describe("popoverPlacement", () => {
  it("sits 8 px under the pill with right edges aligned", () => {
    expect(popoverPlacement({ bottom: 48, right: 1424 }, 1440)).toEqual({ top: 56, right: 16, width: 400 });
  });

  it("keeps a 12 px gutter at the right edge", () => {
    expect(popoverPlacement({ bottom: 40, right: 1436 }, 1440).right).toBe(12);
  });

  it("narrows to the viewport and never runs off the left on a phone", () => {
    const placed = popoverPlacement({ bottom: 90, right: 200 }, 390);
    expect(placed.width).toBe(366);
    expect(placed.right).toBe(12);
    expect(390 - placed.right - placed.width).toBeGreaterThanOrEqual(12);
  });

  it("slides left of a pill near the middle only as far as the left gutter allows", () => {
    const placed = popoverPlacement({ bottom: 90, right: 700 }, 1440);
    expect(placed.right).toBe(740);
    expect(1440 - placed.right - placed.width).toBe(300);
    expect(popoverPlacement({ bottom: 90, right: 300 }, 1440).right).toBe(1440 - 12 - 400);
  });
});
