// bd-hmd.3 review, priority 3: response-size budget tests. Ported
// alongside budget.ts from apps/mcp/src/budget.test.ts (same mechanism,
// same generic tests) plus a reproduction of the review's own finding:
// three ~999,000-character notes produced a 2,998,095-byte getNodes
// response with no truncation before this file existed.

import { describe, expect, it } from "vitest";
import { boundList, boundResponse, DEFAULT_RESPONSE_CHAR_BUDGET } from "./budget.js";

describe("boundList", () => {
  it("keeps everything and reports no truncation when well within budget", () => {
    const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const result = boundList(items, (i) => i.id, 10_000);
    expect(result.kept).toEqual(items);
    expect(result.truncated).toBe(false);
    expect(result.droppedIds).toEqual([]);
    expect(result.shrunkIds).toEqual([]);
  });

  it("drops a prefix-preserving suffix once the budget is exceeded, reporting the dropped ids in order", () => {
    const items = [
      { id: "a", data: "x".repeat(50) },
      { id: "b", data: "x".repeat(50) },
      { id: "c", data: "x".repeat(50) },
      { id: "d", data: "x".repeat(50) },
    ];
    const result = boundList(items, (i) => i.id, 150);
    expect(result.truncated).toBe(true);
    expect(result.kept.length).toBeGreaterThan(0);
    expect(result.kept.length).toBeLessThan(items.length);
    expect(result.kept).toEqual(items.slice(0, result.kept.length));
    expect(result.droppedIds).toEqual(items.slice(result.kept.length).map((i) => i.id));
    expect(result.shrunkIds).toEqual([]);
  });

  it("bd-hmd.3 review's exact repro: three ~999,000-character notes are truncated, not returned whole (a naive getNodes response would be ~2,998,095 bytes)", () => {
    const bigContent = "x".repeat(999_000);
    const items = [
      { id: "note-1", content: bigContent },
      { id: "note-2", content: bigContent },
      { id: "note-3", content: bigContent },
    ];

    const naiveSize = JSON.stringify(items).length;
    expect(naiveSize).toBeGreaterThan(2_900_000); // reproduces the review's ~2,998,095 figure

    const result = boundList(items, (i) => i.id, DEFAULT_RESPONSE_CHAR_BUDGET);

    expect(result.truncated).toBe(true);
    // At least one of the three ~999,000-char notes did not survive
    // whole — either dropped entirely or shrunk in place.
    expect(result.droppedIds.length + result.shrunkIds.length).toBeGreaterThan(0);
    const boundedSize = JSON.stringify(result.kept).length;
    expect(boundedSize).toBeLessThan(naiveSize);
    expect(boundedSize).toBeLessThanOrEqual(DEFAULT_RESPONSE_CHAR_BUDGET * 2); // never more than one oversized item's worth over budget
  });

  it("shrinks a pathologically oversized first item's large fields in place, rather than embedding it whole", () => {
    const items = [{ id: "huge", data: "x".repeat(10_000) }, { id: "b" }];
    const result = boundList(items, (i) => i.id, 10);

    expect(result.kept).toHaveLength(1);
    expect(result.kept[0]!.id).toBe("huge");
    expect((result.kept[0] as { data: string }).data.length).toBeLessThan(2_500);
    expect((result.kept[0] as { data: string }).data).toContain("truncated");

    expect(result.truncated).toBe(true);
    expect(result.shrunkIds).toEqual(["huge"]);
    expect(result.droppedIds).toEqual(["b"]);
  });

  it("never returns an empty list even when the single item alone vastly exceeds the budget", () => {
    const items = [{ id: "only", data: "x".repeat(50_000) }];
    const result = boundList(items, (i) => i.id, 10);
    expect(result.kept).toHaveLength(1);
    expect(result.droppedIds).toEqual([]);
  });
});

describe("boundResponse", () => {
  it("verifies against the exact assembled envelope, not just the list's own accounting", () => {
    const items = [
      { id: "a", data: "x".repeat(40) },
      { id: "b", data: "x".repeat(40) },
      { id: "c", data: "x".repeat(40) },
    ];
    // maxChars is sized so the list alone fits, but a large envelope note
    // pushes the whole response over budget — boundResponse must catch
    // this even though boundList's own accounting says "fits".
    const envelope = boundResponse(
      items,
      (i) => i.id,
      (kept, meta) => ({ kept, meta, note: "x".repeat(200) }),
      250,
    );
    // boundResponse's actual contract: it backs off until the envelope
    // fits, UNLESS the last remaining item alone still doesn't fit — in
    // that one case it stops rather than return an empty list (the
    // "never drop the last item" guarantee), so the envelope can still
    // be over budget with exactly one kept item.
    const fits = JSON.stringify(envelope).length <= 250;
    expect(fits || envelope.kept.length === 1).toBe(true);
    expect(envelope.kept.length).toBeGreaterThan(0);
    expect(envelope.kept.length).toBeLessThan(items.length); // the 200-char envelope note forced at least one drop
  });

  it("real getNodes-shaped envelope: oversized content is truncated and droppedNodeIds/shrunkNodeIds are populated", () => {
    const bigContent = "x".repeat(999_000);
    const nodes = [
      { id: "n1", content: bigContent, title: "t1" },
      { id: "n2", content: bigContent, title: "t2" },
      { id: "n3", content: bigContent, title: "t3" },
    ];

    const response = boundResponse(
      nodes,
      (n) => n.id,
      (kept, meta) => ({ nodes: kept, notFoundIds: [], truncated: meta.truncated, droppedNodeIds: meta.droppedIds, shrunkNodeIds: meta.shrunkIds }),
    );

    expect(response.truncated).toBe(true);
    expect(response.droppedNodeIds.length + response.shrunkNodeIds.length).toBeGreaterThan(0);
    expect(JSON.stringify(response).length).toBeLessThan(JSON.stringify({ nodes, notFoundIds: [] }).length);
  });
});
