// Tests for lib/relayStatus.ts (laptop-relay tasks.md 1.7): the relay pill's
// wording for each liveness state, the pending count, when it shows at all,
// and the tooltip's lines. Dates are built in local time, so the
// expectations hold in any zone.

import { describe, expect, it } from "vitest";
import { relayPillHidden, relayPillLabel, relayPillPending, relayPillTitle, type RelayStatusView } from "./relayStatus.js";

const NOW = new Date(2026, 10, 14, 11, 0, 0);
const base: RelayStatusView = { status: "online", relay: "relay-laptop", version: "1.0.0", lastSeenAt: new Date(2026, 10, 14, 10, 59, 30).toISOString(), queued: 1, claimed: 1, missingBinaries: ["bd", "herdr"] };

describe("relayPillLabel", () => {
  it("reads online, offline since a time (with the date on an earlier day), or never checked in", () => {
    expect(relayPillLabel(base, NOW)).toBe("relay online");
    expect(relayPillLabel({ ...base, status: "offline", lastSeenAt: new Date(2026, 10, 14, 9, 0, 0).toISOString() }, NOW)).toBe("relay offline since 09:00");
    expect(relayPillLabel({ ...base, status: "offline", lastSeenAt: new Date(2026, 10, 12, 9, 0, 0).toISOString() }, NOW)).toBe("relay offline since Nov 12, 09:00");
    expect(relayPillLabel({ ...base, status: "never", relay: null, version: null, lastSeenAt: null }, NOW)).toBe("relay never checked in");
    expect(relayPillLabel({ ...base, status: "offline", lastSeenAt: "garbage" }, NOW)).toBe("relay never checked in");
  });
});

describe("relayPillTitle", () => {
  it("names the relay and version, the last check-in to the second, the counts, and what the server lacks", () => {
    expect(relayPillTitle(base, NOW).split("\n")).toEqual([
      "relay-laptop 1.0.0",
      "Last check-in 10:59:30",
      "1 queued · 1 claimed",
      "This server has no bd or herdr; that work waits for the relay",
    ]);
  });

  it("says no relay has checked in, and leaves out the lack line on a server with both binaries", () => {
    expect(relayPillTitle({ ...base, status: "never", relay: null, version: null, lastSeenAt: null, missingBinaries: [] }, NOW).split("\n")).toEqual(["No laptop relay has checked in", "1 queued · 1 claimed"]);
  });
});

describe("relayPillPending and relayPillHidden", () => {
  it("counts queued and claimed together, and is null with nothing open", () => {
    expect(relayPillPending(base)).toBe("2 pending");
    expect(relayPillPending({ ...base, queued: 0, claimed: 0 })).toBeNull();
  });

  it("shows when a binary is missing or an action is open, and only then", () => {
    expect(relayPillHidden({ ...base, queued: 0, claimed: 0 })).toBe(false);
    expect(relayPillHidden({ ...base, missingBinaries: [], queued: 0, claimed: 1 })).toBe(false);
    expect(relayPillHidden({ ...base, missingBinaries: [], queued: 0, claimed: 0 })).toBe(true);
  });
});
