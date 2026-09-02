// Tests for graph/labelPolicy.ts (bd-cfc). shouldLabel's scenarios map
// directly onto graph-explorer/spec.md's "Labels follow relevance"
// requirement; truncateLabel's onto its "A long title is truncated with
// the full title still reachable" scenario.

import { describe, expect, it } from "vitest";
import { DEFAULT_ZOOM_THRESHOLD, shouldLabel, truncateLabel, type LabelEligibilityInput } from "./labelPolicy.js";

const BELOW_THRESHOLD = 1.0;
const ABOVE_THRESHOLD = 2.0;

function input(overrides: Partial<LabelEligibilityInput>): LabelEligibilityInput {
  return { isSeed: false, isSelected: false, isNeighborOfSelected: false, isHovered: false, globalScale: BELOW_THRESHOLD, ...overrides };
}

describe("shouldLabel — always-on relevance categories (eligible regardless of zoom)", () => {
  it("a seed node is eligible even far below the zoom threshold", () => {
    expect(shouldLabel(input({ isSeed: true, globalScale: 0.1 }))).toBe(true);
  });

  it("the selected node is eligible even far below the zoom threshold", () => {
    expect(shouldLabel(input({ isSelected: true, globalScale: 0.1 }))).toBe(true);
  });

  it("a direct neighbour of the selected node is eligible even far below the zoom threshold", () => {
    expect(shouldLabel(input({ isNeighborOfSelected: true, globalScale: 0.1 }))).toBe(true);
  });

  it("a hovered node is eligible even far below the zoom threshold", () => {
    expect(shouldLabel(input({ isHovered: true, globalScale: 0.1 }))).toBe(true);
  });

  it("more than one relevance category at once is still simply eligible", () => {
    expect(shouldLabel(input({ isSeed: true, isSelected: true, globalScale: 0.1 }))).toBe(true);
  });
});

describe("shouldLabel — ambient nodes (none of seed/selected/neighbour/hovered)", () => {
  it("is NOT eligible below the zoom threshold", () => {
    expect(shouldLabel(input({ globalScale: BELOW_THRESHOLD }))).toBe(false);
  });

  it("is NOT eligible exactly AT the threshold — 'past', not 'at or past'", () => {
    expect(shouldLabel(input({ globalScale: DEFAULT_ZOOM_THRESHOLD }))).toBe(false);
  });

  it("IS eligible once zoomed in past the threshold", () => {
    expect(shouldLabel(input({ globalScale: ABOVE_THRESHOLD }))).toBe(true);
  });

  it("IS eligible just a hair past the threshold", () => {
    expect(shouldLabel(input({ globalScale: DEFAULT_ZOOM_THRESHOLD + 0.001 }))).toBe(true);
  });

  it("honours a caller-supplied threshold instead of the default", () => {
    expect(shouldLabel(input({ globalScale: 5 }), 10)).toBe(false);
    expect(shouldLabel(input({ globalScale: 11 }), 10)).toBe(true);
  });
});

describe("truncateLabel", () => {
  it("leaves a title at exactly the max length unchanged — no ellipsis appended", () => {
    const title = "x".repeat(40);
    expect(truncateLabel(title, 40)).toBe(title);
  });

  it("leaves a title under the max length unchanged", () => {
    const title = "a short title";
    expect(truncateLabel(title, 40)).toBe(title);
  });

  it("truncates a title over the max length to max code points plus a single ellipsis", () => {
    const title = "x".repeat(45);
    const result = truncateLabel(title, 40);
    expect(result).toBe(`${"x".repeat(40)}…`);
    expect(Array.from(result)).toHaveLength(41); // 40 kept characters + 1 ellipsis
  });

  it("trims trailing whitespace immediately before the cut, rather than reading 'word␠…'", () => {
    const title = `${"x".repeat(39)} ${"y".repeat(5)}`; // the 40th character (index 39) is a space
    expect(truncateLabel(title, 40)).toBe(`${"x".repeat(39)}…`);
  });

  it("never cuts inside a surrogate pair — an emoji title truncates to whole emoji, never a lone surrogate", () => {
    const title = "🎉".repeat(50); // 50 code points, 100 UTF-16 code units
    const result = truncateLabel(title, 40);
    const codePoints = Array.from(result);
    expect(codePoints).toEqual([...Array.from({ length: 40 }, () => "🎉"), "…"]);
    // Every retained character is a full, valid code point — Array.from
    // agreeing with the string's own length in UTF-16 units (2 per
    // emoji) is what proves no surrogate was split.
    expect(result.length).toBe(40 * 2 + 1); // 40 emoji * 2 UTF-16 units each, + 1 for "…"
  });

  it("uses the default max (40) when none is supplied", () => {
    const title = "x".repeat(41);
    expect(truncateLabel(title)).toBe(`${"x".repeat(40)}…`);
  });
});
