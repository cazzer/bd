// Tests for lib/relayAction.ts (laptop-relay tasks.md 1.7): how a queued
// review decision reads while the relay has not reported and once it has
// (the writer's own answer, a note, an error), how an inbox pane prompt's
// notice reads, and the board's refresh note.

import { describe, expect, it } from "vitest";
import { describeRefresh, describeRelayDecision, describeRelayPrompt, isRelayActionOpen, RELAY_CLAIMED_TEXT, RELAY_PENDING_TEXT, type RelayActionView } from "./relayAction.js";

const action = (over: Partial<RelayActionView>): RelayActionView => ({ id: 7, state: "queued", result: null, error: null, ...over });

describe("describeRelayDecision", () => {
  it("is pending while queued or claimed, keeping the message and touching nothing", () => {
    for (const [state, text] of [["queued", RELAY_PENDING_TEXT], ["claimed", RELAY_CLAIMED_TEXT]] as const) {
      expect(isRelayActionOpen(state)).toBe(true);
      expect(describeRelayDecision(action({ state }), "accept")).toEqual({
        outcome: { tone: "pending", text, keepMessage: true },
        notified: null,
        notifyFailed: false,
        finished: false,
        reread: false,
        written: false,
      });
    }
  });

  it("reads a done action's writer answer as a direct decision's, with the option and who was told", () => {
    const done = action({ state: "done", result: { ok: true, written: ["comment", "remove-changes-label", "close"], notified: { ok: true, pane: "w1:p2" } } });
    expect(describeRelayDecision(done, "accept", "Accepted A")).toEqual({
      outcome: { tone: "ok", text: "Accepted A and closed — card moved to Closed.", keepMessage: false },
      notified: "Agent notified (pane w1:p2)",
      notifyFailed: false,
      finished: true,
      reread: true,
      written: true,
    });
    const told = describeRelayDecision(action({ state: "done", result: { ok: true, written: ["comment", "add-changes-label"], notified: { ok: false, reason: "pane gone" } } }), "changes");
    expect(told).toMatchObject({ notified: "Agent not notified: pane gone", notifyFailed: true, written: true });
  });

  it("reads a note (the tracker had moved past the decision) as written, and re-reads", () => {
    expect(describeRelayDecision(action({ state: "done", result: { note: "already applied" } }), "accept")).toMatchObject({
      outcome: { tone: "ok", text: "The laptop relay reported it already applied.", keepMessage: false },
      finished: true,
      reread: true,
      written: true,
    });
  });

  it("reads a failure with written steps as a partial write, with the relay's error when the writer gave none", () => {
    const failed = action({ state: "failed", error: "bd close failed: database is locked", result: { ok: false, written: ["comment"] } });
    const reading = describeRelayDecision(failed, "accept");
    expect(reading.outcome.tone).toBe("partial");
    expect(reading.outcome.text).toContain("Partly written (comment added), then the tracker failed: bd close failed: database is locked");
    expect(reading).toMatchObject({ finished: true, reread: true, written: false });
  });

  it("reads a failure without written steps as the relay's error, keeping the message", () => {
    const reading = describeRelayDecision(action({ state: "failed", error: "abandoned after 3 claims without a report" }), "changes");
    expect(reading.outcome).toEqual({
      tone: "error",
      text: "The laptop relay could not write the decision: abandoned after 3 claims without a report. Check the thread before deciding again.",
      keepMessage: true,
    });
    expect(reading).toMatchObject({ finished: true, written: false });
    expect(describeRelayDecision(action({ state: "failed", result: { ok: false, written: [] } }), "changes").outcome.text).toContain("it gave no reason");
  });
});

describe("describeRelayPrompt", () => {
  it("says the relay will tell the pane, then that it did, or why it could not", () => {
    expect(describeRelayPrompt(null, "w1:p6")).toEqual({ tone: "pending", text: "Recorded. The laptop relay will tell pane w1:p6 when it runs." });
    expect(describeRelayPrompt(action({ state: "claimed" }), "w1:p6").tone).toBe("pending");
    expect(describeRelayPrompt(action({ state: "done" }), "w1:p6")).toEqual({ tone: "ok", text: "The laptop relay told pane w1:p6." });
    expect(describeRelayPrompt(action({ state: "failed", error: "agent_not_found" }), null)).toEqual({
      tone: "error",
      text: "The laptop relay could not tell the session that queued it: agent_not_found. The decision is recorded.",
    });
  });
});

describe("describeRefresh", () => {
  it("reports re-read projects, or projects queued for the relay, and failures", () => {
    expect(describeRefresh(2, 0, 0)).toBe("Refreshed 2 projects.");
    expect(describeRefresh(1, 0, 0)).toBe("Refreshed 1 project.");
    expect(describeRefresh(3, 0, 1)).toBe("Refreshed; 1 failed.");
    expect(describeRefresh(2, 2, 0)).toBe("Queued a refresh of 2 projects for the laptop relay; the board updates when it runs.");
    expect(describeRefresh(3, 2, 1)).toBe("Queued a refresh of 2 projects for the laptop relay; the board updates when it runs. 1 could not be queued.");
  });
});
