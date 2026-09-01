// bd-hmd.3 review, priority 2: Zod-layer defense-in-depth boundary tests
// for the four numeric options that had no ceiling before (defect 2) and
// the title cap that had no cap anywhere (defect 3). packages/core's own
// retrieval.test.ts / nodes.test.ts cover the same boundaries against a
// real database (the authoritative fix); these prove the Zod schemas
// reject the identical out-of-range values *before* a request ever
// reaches core — no database needed, since Zod validation is pure.

import { describe, expect, it } from "vitest";
import { MAX_FANOUT, MAX_NEIGHBOR_LIMIT, MAX_NODE_BUDGET, MAX_RECENT_NODES_LIMIT, MAX_SEED_LIMIT } from "@breakdown/core";
import { getNeighborsInputSchema, getStoreSummaryInputSchema, searchInputSchema } from "./read.js";
import { annotateNodeInputSchema, createNoteInputSchema, updateNodeContentInputSchema } from "./write.js";

describe("searchInputSchema — numeric ceilings (bd-hmd.3 review defect 2)", () => {
  it.each([
    ["seedLimit", MAX_SEED_LIMIT],
    ["fanout", MAX_FANOUT],
    ["nodeBudget", MAX_NODE_BUDGET],
  ] as const)("accepts %s at its ceiling and rejects one past it", (field, max) => {
    expect(searchInputSchema.safeParse({ query: "x", [field]: max }).success).toBe(true);
    expect(searchInputSchema.safeParse({ query: "x", [field]: max + 1 }).success).toBe(false);
  });

  it.each(["seedLimit", "fanout", "nodeBudget"] as const)("rejects a %s that would overflow Postgres int4 (the review's exact repro value)", (field) => {
    const result = searchInputSchema.safeParse({ query: "x", [field]: 3_000_000_000 });
    expect(result.success).toBe(false);
  });

  it("caps nodeTypes/sourceSystems/edgeTypes filter arrays at 50 values", () => {
    const ok = Array.from({ length: 50 }, (_, i) => `type-${i}`);
    const tooMany = Array.from({ length: 51 }, (_, i) => `type-${i}`);
    expect(searchInputSchema.safeParse({ query: "x", nodeTypes: ok }).success).toBe(true);
    expect(searchInputSchema.safeParse({ query: "x", nodeTypes: tooMany }).success).toBe(false);
    expect(searchInputSchema.safeParse({ query: "x", sourceSystems: tooMany }).success).toBe(false);
    expect(searchInputSchema.safeParse({ query: "x", edgeTypes: tooMany }).success).toBe(false);
  });
});

describe("getNeighborsInputSchema — numeric ceiling", () => {
  it("accepts limit at MAX_NEIGHBOR_LIMIT and rejects one past it", () => {
    expect(getNeighborsInputSchema.safeParse({ id: "x", limit: MAX_NEIGHBOR_LIMIT }).success).toBe(true);
    expect(getNeighborsInputSchema.safeParse({ id: "x", limit: MAX_NEIGHBOR_LIMIT + 1 }).success).toBe(false);
  });

  it("rejects a limit that would overflow Postgres int4", () => {
    expect(getNeighborsInputSchema.safeParse({ id: "x", limit: 3_000_000_000 }).success).toBe(false);
  });
});

describe("getStoreSummaryInputSchema — numeric ceiling", () => {
  it("accepts recentNodesLimit at MAX_RECENT_NODES_LIMIT and rejects one past it", () => {
    expect(getStoreSummaryInputSchema.safeParse({ recentNodesLimit: MAX_RECENT_NODES_LIMIT }).success).toBe(true);
    expect(getStoreSummaryInputSchema.safeParse({ recentNodesLimit: MAX_RECENT_NODES_LIMIT + 1 }).success).toBe(false);
  });

  it("rejects a recentNodesLimit that would overflow Postgres int4", () => {
    expect(getStoreSummaryInputSchema.safeParse({ recentNodesLimit: 3_000_000_000 }).success).toBe(false);
  });
});

describe("title cap (bd-hmd.3 review defect 3)", () => {
  it("createNote rejects a title over DEFAULT_MAX_TITLE_LENGTH (500)", () => {
    expect(createNoteInputSchema.safeParse({ title: "x".repeat(500) }).success).toBe(true);
    expect(createNoteInputSchema.safeParse({ title: "x".repeat(501) }).success).toBe(false);
  });

  it("annotateNode rejects an oversized title the same way", () => {
    const validId = "00000000-0000-0000-0000-000000000000";
    expect(annotateNodeInputSchema.safeParse({ targetNodeId: validId, title: "x".repeat(501) }).success).toBe(false);
  });

  it("updateNodeContent rejects an oversized title the same way", () => {
    const validId = "00000000-0000-0000-0000-000000000000";
    expect(updateNodeContentInputSchema.safeParse({ nodeId: validId, title: "x".repeat(501) }).success).toBe(false);
  });

  it("a 5,000,000-character title (the review's exact repro) is rejected", () => {
    expect(createNoteInputSchema.safeParse({ title: "x".repeat(5_000_000) }).success).toBe(false);
  });
});

describe("id validation consistency (bd-hmd.3 review nit)", () => {
  it("annotateNode's targetNodeId requires a uuid, same as the edge procedures — not a bare non-empty string", () => {
    expect(annotateNodeInputSchema.safeParse({ targetNodeId: "not-a-uuid" }).success).toBe(false);
    expect(annotateNodeInputSchema.safeParse({ targetNodeId: "00000000-0000-0000-0000-000000000000" }).success).toBe(true);
  });

  it("updateNodeContent's nodeId requires a uuid, same as the edge procedures — not a bare non-empty string", () => {
    expect(updateNodeContentInputSchema.safeParse({ nodeId: "not-a-uuid" }).success).toBe(false);
    expect(updateNodeContentInputSchema.safeParse({ nodeId: "00000000-0000-0000-0000-000000000000" }).success).toBe(true);
  });
});
