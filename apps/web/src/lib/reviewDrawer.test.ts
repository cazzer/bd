import { describe, expect, it } from "vitest";
import { canDecide, decisionBlocked, describeDecision, describeNotified, drawerProject, stepIndex } from "./reviewDrawer.js";

describe("drawerProject", () => {
  const cards = [
    { externalId: "bd-1", project: "bd" },
    { externalId: "tides-r1", project: "tides" },
  ];

  it("is the card's project when the board shows the item", () => {
    expect(drawerProject("tides-r1", cards, ["bd", "tides"])).toBe("tides");
    expect(drawerProject("bd-1", cards, ["tides"])).toBe("bd");
  });

  it("falls back to the single chosen project for an item not on the board yet", () => {
    expect(drawerProject("tides-r9", cards, ["tides"])).toBe("tides");
  });

  it("is null (waiting) when the item is not on the board and the project is ambiguous", () => {
    expect(drawerProject("x-1", cards, ["bd", "tides"])).toBeNull();
    expect(drawerProject("x-1", [], [])).toBeNull();
  });
});

describe("canDecide", () => {
  it("is true only for an open review", () => {
    expect(canDecide({ isReview: true, status: "open" })).toBe(true);
    expect(canDecide({ isReview: true, status: "in_progress" })).toBe(true);
    expect(canDecide({ isReview: true, status: "closed" })).toBe(false);
    expect(canDecide({ isReview: false, status: "open" })).toBe(false);
  });
});

describe("decisionBlocked", () => {
  it("blocks everything while a decision is pending", () => {
    expect(decisionBlocked("accept", "", true)).toBe(true);
    expect(decisionBlocked("changes", "fix it", true)).toBe(true);
  });

  it("requires a non-blank message to request changes, never to accept", () => {
    expect(decisionBlocked("changes", "", false)).toBe(true);
    expect(decisionBlocked("changes", "  \n ", false)).toBe(true);
    expect(decisionBlocked("changes", "fix it", false)).toBe(false);
    expect(decisionBlocked("accept", "", false)).toBe(false);
  });
});

describe("describeDecision", () => {
  it("says where the card went on success and clears the message", () => {
    expect(describeDecision({ ok: true, decision: "accept", written: ["comment", "remove-changes-label", "close"] })).toEqual({
      tone: "ok",
      text: "Accepted and closed — card moved to Closed.",
      keepMessage: false,
    });
    expect(describeDecision({ ok: true, decision: "changes", written: ["comment", "add-changes-label"] })).toEqual({
      tone: "ok",
      text: "Changes requested — comment posted and review:changes added; the review stays open.",
      keepMessage: false,
    });
  });

  it("reports a partial write with what landed and the tracker's error, clearing the box once the comment is posted", () => {
    expect(describeDecision({ ok: false, decision: "accept", written: ["comment"], error: "bd: close refused" })).toEqual({
      tone: "partial",
      text: "Partly written (comment added), then the tracker failed: bd: close refused Your comment is posted; deciding again would post it again — check the tracker first.",
      keepMessage: false,
    });
  });

  it("keeps the message for a partial write that did not post the comment", () => {
    expect(describeDecision({ ok: false, decision: "accept", written: ["remove-changes-label"], error: "bd: close refused" })).toMatchObject({ tone: "partial", keepMessage: true });
  });

  it("reports a failure with nothing written, keeping the message", () => {
    expect(describeDecision({ ok: false, decision: "changes", written: [], error: "bd not found" })).toEqual({
      tone: "error",
      text: "Nothing was written; the tracker failed: bd not found",
      keepMessage: true,
    });
  });
});

describe("describeDecision with an uncertain step", () => {
  const error = "bd timed out after 30s; it may have been written — check the tracker before deciding again";

  it("names the uncertain step and passes the server's error through; keeps the message only while the comment is not posted", () => {
    expect(describeDecision({ ok: false, decision: "accept", written: ["comment", "remove-changes-label"], uncertain: "close", error })).toEqual({
      tone: "partial",
      text: `Partly written (comment added, review:changes label removed). Unsure whether the close was written: ${error} Your comment is posted; deciding again would post it again — check the tracker first.`,
      keepMessage: false,
    });
    expect(describeDecision({ ok: false, decision: "changes", written: [], uncertain: "comment", error })).toEqual({
      tone: "partial",
      text: `Unsure whether the comment was written: ${error}`,
      keepMessage: true,
    });
  });
});

describe("describeNotified", () => {
  it("says nothing until the server reports it, then whether the agent was told and why not", () => {
    expect(describeNotified(null)).toBeNull();
    expect(describeNotified(undefined)).toBeNull();
    expect(describeNotified({ ok: true })).toBe("Agent notified");
    expect(describeNotified({ ok: false, reason: "pane w1:p2 is gone" })).toBe("Agent not notified: pane w1:p2 is gone");
  });
});

describe("stepIndex", () => {
  it("wraps both ways", () => {
    expect(stepIndex(0, 1, 3)).toBe(1);
    expect(stepIndex(2, 1, 3)).toBe(0);
    expect(stepIndex(0, -1, 3)).toBe(2);
    expect(stepIndex(1, -4, 3)).toBe(0);
    expect(stepIndex(0, 1, 1)).toBe(0);
    expect(stepIndex(0, 1, 0)).toBe(0);
  });
});
