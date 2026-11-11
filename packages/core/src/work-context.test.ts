import { describe, expect, it } from "vitest";
import { InvalidWorkItemError } from "./errors.js";
import { MAX_WORK_CONTEXT_ENTRIES } from "./work-context.js";
import { normalizeWorkItemMetadata } from "./work-items.js";

const ITEM = "4e250cb0-f6ae-45a7-8e44-b48721aabda5";

describe("work item decisions and signals", () => {
  it("normalizes entries and drops absent lists", () => {
    const m = normalizeWorkItemMetadata({
      decisions: [{ at: "2026-11-10T14:02:01Z", decision: "Close", note: " Sam already wrote this ", item: ITEM.toUpperCase() }],
      signals: [{ at: "2026-11-10", title: "Pat's NDA question", url: "https://example.slack.com/x", gist: "not for them" }],
    });
    expect(m["decisions"]).toEqual([{ at: "2026-11-10T14:02:01.000Z", decision: "close", note: "Sam already wrote this", item: ITEM }]);
    expect(m["signals"]).toEqual([{ at: "2026-11-10T00:00:00.000Z", title: "Pat's NDA question", url: "https://example.slack.com/x", gist: "not for them" }]);
    expect(normalizeWorkItemMetadata({ decisions: null })).not.toHaveProperty("decisions");
    expect(normalizeWorkItemMetadata({})).not.toHaveProperty("signals");
  });

  it("keeps the most recent entries past the cap, so an append never fails", () => {
    const many = Array.from({ length: MAX_WORK_CONTEXT_ENTRIES + 5 }, (_, i) => ({ at: `2026-11-01T00:00:${String(i % 60).padStart(2, "0")}Z`, decision: "close", note: `n${i}` }));
    const kept = normalizeWorkItemMetadata({ decisions: many })["decisions"] as { note: string }[];
    expect(kept).toHaveLength(MAX_WORK_CONTEXT_ENTRIES);
    expect(kept[0]!.note).toBe("n5");
    expect(kept.at(-1)!.note).toBe(`n${MAX_WORK_CONTEXT_ENTRIES + 4}`);
  });

  it("refuses malformed entries naming the field", () => {
    expect(() => normalizeWorkItemMetadata({ decisions: "close" })).toThrow(/decisions/);
    expect(() => normalizeWorkItemMetadata({ decisions: [{ at: "nope", decision: "close", note: "x" }] })).toThrow(/decisions\[0\]\.at/);
    expect(() => normalizeWorkItemMetadata({ decisions: [{ at: "2026-11-10", decision: "close", note: "" }] })).toThrow(/decisions\[0\]\.note/);
    expect(() => normalizeWorkItemMetadata({ decisions: [{ at: "2026-11-10", decision: "close", note: "x", item: "abc" }] })).toThrow(/decisions\[0\]\.item/);
    expect(() => normalizeWorkItemMetadata({ signals: [{ at: "2026-11-10", title: "t", gist: "g", url: "ftp://x" }] })).toThrow(InvalidWorkItemError);
  });
});
