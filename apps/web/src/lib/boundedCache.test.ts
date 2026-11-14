import { describe, expect, it } from "vitest";
import { BoundedCache } from "./boundedCache.js";

describe("BoundedCache", () => {
  it("evicts the least recently used key past its capacity", () => {
    const cache = new BoundedCache<number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.get("a")).toBe(1);
    cache.set("c", 3);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(1);
    expect(cache.get("c")).toBe(3);
  });

  it("replaces a key's value without growing", () => {
    const cache = new BoundedCache<number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("a", 9);
    cache.set("c", 3);
    expect(cache.get("a")).toBe(9);
    expect(cache.get("b")).toBeUndefined();
  });
});
