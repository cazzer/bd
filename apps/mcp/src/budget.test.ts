import { describe, expect, it } from "vitest";
import { boundList } from "./budget.js";

describe("boundList", () => {
  it("keeps everything and reports no truncation when well within budget", () => {
    const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const result = boundList(items, (i) => i.id, 10_000);
    expect(result.kept).toEqual(items);
    expect(result.truncated).toBe(false);
    expect(result.droppedIds).toEqual([]);
  });

  it("drops a prefix-preserving suffix once the budget is exceeded, reporting the dropped ids in order", () => {
    const items = [
      { id: "a", data: "x".repeat(50) },
      { id: "b", data: "x".repeat(50) },
      { id: "c", data: "x".repeat(50) },
      { id: "d", data: "x".repeat(50) },
    ];
    // Each item serializes to roughly 65-70 chars; a budget of 150 should
    // keep the first couple and drop the rest.
    const result = boundList(items, (i) => i.id, 150);
    expect(result.truncated).toBe(true);
    expect(result.kept.length).toBeGreaterThan(0);
    expect(result.kept.length).toBeLessThan(items.length);
    // Kept items are a prefix of the input (best-first order preserved).
    expect(result.kept).toEqual(items.slice(0, result.kept.length));
    expect(result.droppedIds).toEqual(items.slice(result.kept.length).map((i) => i.id));
  });

  it("always keeps at least the first item, even if it alone exceeds the budget", () => {
    const items = [{ id: "huge", data: "x".repeat(1000) }, { id: "b" }];
    const result = boundList(items, (i) => i.id, 10);
    expect(result.kept).toEqual([items[0]]);
    expect(result.truncated).toBe(true);
    expect(result.droppedIds).toEqual(["b"]);
  });

  it("handles an empty list", () => {
    const result = boundList([], (i: { id: string }) => i.id, 100);
    expect(result.kept).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(result.droppedIds).toEqual([]);
  });

  it("uses DEFAULT_RESPONSE_CHAR_BUDGET when no override is given", () => {
    const items = Array.from({ length: 5 }, (_, i) => ({ id: `n${i}`, data: "small" }));
    const result = boundList(items, (i) => i.id);
    expect(result.truncated).toBe(false);
    expect(result.kept).toEqual(items);
  });
});
