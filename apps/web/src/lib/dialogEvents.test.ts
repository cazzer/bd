// Tests for lib/dialogEvents.ts (review-queue, review of task group 6).

import { describe, expect, it } from "vitest";
import { isOwnDialogEvent } from "./dialogEvents.js";

describe("isOwnDialogEvent", () => {
  it("is true for the dialog's own cancel/close and false for one from a dialog inside it", () => {
    const outer = {};
    const inner = {};
    expect(isOwnDialogEvent({ target: outer, currentTarget: outer })).toBe(true);
    expect(isOwnDialogEvent({ target: inner, currentTarget: outer })).toBe(false);
  });
});
