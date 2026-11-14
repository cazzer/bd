// Tests for lib/hangarStatus.ts (hangar-queue tasks.md 2.7): the pill's
// wording for each liveness state, today versus an earlier day, and the
// tooltip's lines. Dates are built in local time, so the expectations hold
// in any zone.

import { describe, expect, it } from "vitest";
import { hangarPillCounts, hangarPillHidden, hangarPillLabel, hangarPillTitle, type HangarStatusView } from "./hangarStatus.js";

const NOW = new Date(2026, 10, 14, 11, 0, 0);
const base: HangarStatusView = { status: "online", hangar: "hangar-desktop", version: "0.4.1", lastSeenAt: new Date(2026, 10, 14, 10, 59, 30).toISOString(), queued: 2, claimed: 0, running: 1 };

describe("hangarPillLabel", () => {
  it("reads online without a time", () => {
    expect(hangarPillLabel(base, NOW)).toBe("hangar online");
  });

  it("reads offline since the time alone when the last check-in was today", () => {
    expect(hangarPillLabel({ ...base, status: "offline", lastSeenAt: new Date(2026, 10, 14, 9, 0, 0).toISOString() }, NOW)).toBe("hangar offline since 09:00");
  });

  it("adds the date when the last check-in was an earlier day, and the year when it was an earlier year", () => {
    expect(hangarPillLabel({ ...base, status: "offline", lastSeenAt: new Date(2026, 10, 12, 9, 0, 0).toISOString() }, NOW)).toBe("hangar offline since Nov 12, 09:00");
    expect(hangarPillLabel({ ...base, status: "offline", lastSeenAt: new Date(2025, 11, 31, 23, 5, 0).toISOString() }, NOW)).toBe("hangar offline since Dec 31, 2025, 23:05");
  });

  it("reads never checked in, also for an offline status with no readable time", () => {
    expect(hangarPillLabel({ ...base, status: "never", hangar: null, version: null, lastSeenAt: null }, NOW)).toBe("hangar never checked in");
    expect(hangarPillLabel({ ...base, status: "offline", lastSeenAt: "garbage" }, NOW)).toBe("hangar never checked in");
  });
});

describe("hangarPillTitle", () => {
  it("names the hangar and version, the last check-in to the second, and the counts", () => {
    expect(hangarPillTitle(base, NOW)).toBe("hangar-desktop 0.4.1\nLast check-in 10:59:30\n2 queued · 0 claimed · 1 running");
    expect(hangarPillTitle({ ...base, version: null, lastSeenAt: new Date(2026, 10, 12, 9, 0, 5).toISOString() }, NOW)).toBe("hangar-desktop\nLast check-in Nov 12, 09:00:05\n2 queued · 0 claimed · 1 running");
  });

  it("says no hangar has checked in when none has", () => {
    expect(hangarPillTitle({ ...base, status: "never", hangar: null, version: null, lastSeenAt: null, queued: 3, running: 0 }, NOW)).toBe("No hangar has checked in\n3 queued · 0 claimed · 0 running");
  });
});

describe("hangarPillCounts", () => {
  it("lists the non-zero open counts in order, and nothing when all are zero", () => {
    expect(hangarPillCounts(base)).toBe("2 queued, 1 running");
    expect(hangarPillCounts({ ...base, queued: 1, claimed: 1, running: 1 })).toBe("1 queued, 1 claimed, 1 running");
    expect(hangarPillCounts({ ...base, queued: 0, claimed: 0, running: 0 })).toBeNull();
  });
});

describe("hangarPillHidden", () => {
  it("hides only a never-checked-in status with nothing open", () => {
    const never = { ...base, status: "never" as const, hangar: null, version: null, lastSeenAt: null, queued: 0, claimed: 0, running: 0 };
    expect(hangarPillHidden(never)).toBe(true);
    expect(hangarPillHidden({ ...never, queued: 1 })).toBe(false);
    expect(hangarPillHidden({ ...base, status: "offline", queued: 0, claimed: 0, running: 0 })).toBe(false);
    expect(hangarPillHidden({ ...base, queued: 0, claimed: 0, running: 0 })).toBe(false);
  });
});
