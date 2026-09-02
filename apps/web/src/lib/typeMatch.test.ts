// Tests for bd-73t's suggestion matching — graph-explorer/spec.md's
// "Search is the entry point" (MODIFIED), "Choosing a type suggestion
// filters the query" scenario's data source.

import { describe, expect, it } from "vitest";
import type { TypeCount } from "../graph/typePrevalence.js";
import { matchNodeTypes } from "./typeMatch.js";

const NODE_TYPES: TypeCount[] = [
  { nodeType: "doc", count: 40 },
  { nodeType: "openspec-spec", count: 12 },
  { nodeType: "openspec-proposal", count: 12 },
  { nodeType: "openspec-design", count: 3 },
];

describe("matchNodeTypes", () => {
  it("returns [] for empty input", () => {
    expect(matchNodeTypes("", NODE_TYPES)).toEqual([]);
  });

  it("returns [] for whitespace-only input", () => {
    expect(matchNodeTypes("   ", NODE_TYPES)).toEqual([]);
  });

  it("returns [] when nothing matches", () => {
    expect(matchNodeTypes("zzz", NODE_TYPES)).toEqual([]);
  });

  it("matches case-insensitively as a substring", () => {
    // "-SPEC" (not "SPEC" alone — "openspec" itself ends in "spec", so a
    // bare "spec" needle also matches openspec-proposal/-design) isolates
    // the single node_type that actually contains this substring.
    expect(matchNodeTypes("-SPEC", NODE_TYPES)).toEqual([{ nodeType: "openspec-spec", count: 12 }]);
  });

  it("ranks matches by count descending, then name ascending on a tie", () => {
    expect(matchNodeTypes("openspec", NODE_TYPES)).toEqual([
      { nodeType: "openspec-proposal", count: 12 },
      { nodeType: "openspec-spec", count: 12 },
      { nodeType: "openspec-design", count: 3 },
    ]);
  });

  it("trims surrounding whitespace before matching", () => {
    expect(matchNodeTypes("  doc  ", NODE_TYPES)).toEqual([{ nodeType: "doc", count: 40 }]);
  });
});
