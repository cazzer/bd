// Tests for lib/hangarStatus.ts (hangar-queue tasks.md 2.7): the pill's
// wording for each liveness state, today versus an earlier day, and the
// tooltip's lines, its capacity lines among them (hangar-capacity); and the
// awaiting-review helpers: a work item's route and a disk's size. Dates are
// built in local time, so the expectations hold in any zone.

import { describe, expect, it } from "vitest";
import { awaitingWorkItemRoute, formatDiskBytes, hangarPillCapacity, hangarPillCounts, hangarPillHidden, hangarPillLabel, hangarPillTitle, type HangarStatusView } from "./hangarStatus.js";
import { formatRoute } from "./route.js";

const NOW = new Date(2026, 10, 14, 11, 0, 0);
const base: HangarStatusView = { status: "online", hangar: "hangar-desktop", version: "0.4.1", lastSeenAt: new Date(2026, 10, 14, 10, 59, 30).toISOString(), intervalS: 30, now: NOW.toISOString(), queued: 2, claimed: 0, running: 1, capacity: null, capacityAt: null };

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
    expect(hangarPillTitle(base, NOW)).toBe("hangar-desktop 0.4.1\nLast check-in 10:59:30\nNo capacity reported\n2 queued · 0 claimed · 1 running");
    expect(hangarPillTitle({ ...base, status: "offline", version: null, lastSeenAt: new Date(2026, 10, 12, 9, 0, 5).toISOString() }, NOW)).toBe("hangar-desktop\nLast check-in Nov 12, 09:00:05\n2 queued · 0 claimed · 1 running");
  });

  it("adds the free slots, each blocked flavor's reason, and when the capacity was reported", () => {
    const capacityAt = new Date(2026, 10, 14, 10, 59, 0).toISOString();
    const capacity = { slots: { headless: 2, "display-godot": 0, "display-browser": 1 }, blocked: { "display-godot": "disk: need 8192 MB, free 1200 MB" } };
    expect(hangarPillTitle({ ...base, capacity, capacityAt }, NOW)).toBe(
      "hangar-desktop 0.4.1\nLast check-in 10:59:30\nSlots: headless 2, display-browser 1\ndisplay-godot blocked: disk: need 8192 MB, free 1200 MB\nCapacity reported 10:59:00\n2 queued · 0 claimed · 1 running",
    );
    expect(hangarPillTitle({ ...base, capacity: { slots: { headless: 0 } }, capacityAt }, NOW)).toBe("hangar-desktop 0.4.1\nLast check-in 10:59:30\nNo free slots\nCapacity reported 10:59:00\n2 queued · 0 claimed · 1 running");
    expect(hangarPillTitle({ ...base, capacity: {}, capacityAt: null }, NOW)).toBe("hangar-desktop 0.4.1\nLast check-in 10:59:30\nNo slots reported\n2 queued · 0 claimed · 1 running");
  });

  it("heads an offline hangar's capacity as the last one reported", () => {
    const lastSeenAt = new Date(2026, 10, 14, 9, 0, 0).toISOString();
    expect(hangarPillTitle({ ...base, status: "offline", lastSeenAt, capacity: { slots: { headless: 1 } }, capacityAt: lastSeenAt }, NOW)).toBe(
      "hangar-desktop 0.4.1\nLast check-in 09:00:00\nLast reported capacity:\nSlots: headless 1\nCapacity reported 09:00:00\n2 queued · 0 claimed · 1 running",
    );
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

describe("hangarPillCapacity", () => {
  const fresh = new Date(NOW.getTime() - 20_000).toISOString();

  it("says disk full when an online hangar has no slot and every block is on disk, else no slots", () => {
    expect(hangarPillCapacity({ ...base, capacity: { slots: { headless: 0 }, blocked: { headless: "disk: need 8192 MB", "display-browser": " disk: full" } }, capacityAt: fresh })).toBe("disk full");
    expect(hangarPillCapacity({ ...base, capacity: { slots: { headless: 0 }, blocked: { headless: "disk: full", "display-browser": "ram: full" } }, capacityAt: fresh })).toBe("no slots");
    expect(hangarPillCapacity({ ...base, capacity: { slots: { headless: 0 } }, capacityAt: fresh })).toBe("no slots");
    expect(hangarPillCapacity({ ...base, capacity: {}, capacityAt: fresh })).toBe("no slots");
  });

  it("says nothing with a free slot, offline, without capacity, or when the capacity is stale", () => {
    const full = { slots: { headless: 0 }, blocked: { headless: "disk: full" } };
    expect(hangarPillCapacity({ ...base, capacity: { ...full, slots: { headless: 0, "display-browser": 1 } }, capacityAt: fresh })).toBeNull();
    expect(hangarPillCapacity({ ...base, status: "offline", capacity: full, capacityAt: fresh })).toBeNull();
    expect(hangarPillCapacity({ ...base, capacity: null, capacityAt: null })).toBeNull();
    expect(hangarPillCapacity({ ...base, capacity: full, capacityAt: new Date(NOW.getTime() - 90_000).toISOString() })).toBeNull();
    expect(hangarPillCapacity({ ...base, capacity: full, capacityAt: null })).toBeNull();
  });
});

describe("awaitingWorkItemRoute", () => {
  it("opens the item on its project's board by its external id", () => {
    const item = { externalId: "bd-d38.5", project: "bd" };
    expect(awaitingWorkItemRoute(item)).toEqual({ view: "board", viewId: null, projects: ["bd"], item: "bd-d38.5" });
    expect(formatRoute(awaitingWorkItemRoute(item))).toContain("bd-d38.5");
  });
});

describe("formatDiskBytes", () => {
  it("reads in binary units with one decimal, and bytes under a kilobyte whole", () => {
    expect(formatDiskBytes(8 * 1024 ** 3)).toBe("8.0 GB");
    expect(formatDiskBytes(1536 * 1024 ** 2)).toBe("1.5 GB");
    expect(formatDiskBytes(512 * 1024 ** 2)).toBe("512.0 MB");
    expect(formatDiskBytes(2048)).toBe("2.0 KB");
    expect(formatDiskBytes(512)).toBe("512 B");
    expect(formatDiskBytes(3 * 1024 ** 4)).toBe("3.0 TB");
    // The unit is picked after rounding.
    expect(formatDiskBytes(1024 ** 3 - 1)).toBe("1.0 GB");
    expect(formatDiskBytes(1024 ** 2 - 1)).toBe("1.0 MB");
    expect(formatDiskBytes(1023.9 * 1024 ** 2)).toBe("1023.9 MB");
  });
});
