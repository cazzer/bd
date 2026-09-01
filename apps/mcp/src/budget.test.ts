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
    // Each item serializes to roughly 65-70 chars; a budget of 150 should
    // keep the first couple and drop the rest.
    const result = boundList(items, (i) => i.id, 150);
    expect(result.truncated).toBe(true);
    expect(result.kept.length).toBeGreaterThan(0);
    expect(result.kept.length).toBeLessThan(items.length);
    // Kept items are a prefix of the input (best-first order preserved).
    expect(result.kept).toEqual(items.slice(0, result.kept.length));
    expect(result.droppedIds).toEqual(items.slice(result.kept.length).map((i) => i.id));
    expect(result.shrunkIds).toEqual([]);
  });

  it("keeps a moderately oversized first item whole (not shrunk) when it exceeds the budget but not the oversized-item multiple", () => {
    // maxChars=100, OVERSIZED_ITEM_MULTIPLE=2 internally: an item of
    // ~150 chars exceeds the budget on its own but not 2x it, so it must
    // be kept exactly as given, not truncated.
    const items = [{ id: "big", data: "x".repeat(120) }, { id: "b" }];
    const result = boundList(items, (i) => i.id, 100);
    expect(result.kept).toEqual([items[0]]);
    expect(result.shrunkIds).toEqual([]);
    expect(result.droppedIds).toEqual(["b"]);
  });

  it("shrinks a pathologically oversized first item's large fields in place, rather than embedding it whole (bd-vt2.5 MUST-FIX: a single item must not blow the budget by 200x)", () => {
    const items = [{ id: "huge", data: "x".repeat(1000) }, { id: "b" }];
    const result = boundList(items, (i) => i.id, 10);

    expect(result.kept).toHaveLength(1);
    expect(result.kept[0]!.id).toBe("huge");
    // The oversized field was replaced with a short placeholder, not the
    // 1000-char original.
    expect((result.kept[0] as { data: string }).data.length).toBeLessThan(700);
    expect((result.kept[0] as { data: string }).data).toContain("truncated");
    expect((result.kept[0] as { data: string }).data).toContain("1000 chars");

    expect(result.truncated).toBe(true);
    expect(result.shrunkIds).toEqual(["huge"]);
    expect(result.droppedIds).toEqual(["b"]);
  });

  it("shrinks an oversized nested object field to an omitted placeholder", () => {
    const items = [{ id: "huge", metadata: { blob: "z".repeat(2000) } }];
    const result = boundList(items, (i) => i.id, 10);

    expect(result.shrunkIds).toEqual(["huge"]);
    const kept = result.kept[0] as { metadata: unknown };
    expect(typeof kept.metadata).toBe("string");
    expect(kept.metadata as string).toContain("omitted");
    expect((kept.metadata as string).length).toBeLessThan(300);
  });

  it("leaves small fields on a shrunk item untouched", () => {
    const items = [{ id: "huge", short: "fine", data: "x".repeat(1000) }];
    const result = boundList(items, (i) => i.id, 10);
    expect((result.kept[0] as { short: string }).short).toBe("fine");
    expect((result.kept[0] as { id: string }).id).toBe("huge");
  });

  it("handles an empty list", () => {
    const result = boundList([], (i: { id: string }) => i.id, 100);
    expect(result.kept).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(result.droppedIds).toEqual([]);
    expect(result.shrunkIds).toEqual([]);
  });

  it("uses DEFAULT_RESPONSE_CHAR_BUDGET when no override is given", () => {
    const items = Array.from({ length: 5 }, (_, i) => ({ id: `n${i}`, data: "small" }));
    const result = boundList(items, (i) => i.id);
    expect(result.truncated).toBe(false);
    expect(result.kept).toEqual(items);
  });
});

describe("boundResponse", () => {
  it("returns the envelope unchanged when everything fits", () => {
    const items = [{ id: "a" }, { id: "b" }];
    const envelope = boundResponse(items, (i) => i.id, (kept, meta) => ({ kept, ...meta }), 10_000);
    expect(envelope.kept).toEqual(items);
    expect(envelope.truncated).toBe(false);
  });

  it("verifies against the exact assembled envelope, not just the list's own accounting (bd-vt2.5 review: 23,218 accounted vs. 25,002 actually sent)", () => {
    // Each item is small individually, but the envelope wraps them in a
    // verbose object whose own overhead a list-local pass never sees.
    const items = Array.from({ length: 20 }, (_, i) => ({ id: `n${i}`, data: "x".repeat(80) }));
    const maxChars = 900;

    const envelope = boundResponse(
      items,
      (i) => i.id,
      (kept, meta) => ({
        kept,
        truncated: meta.truncated,
        droppedIds: meta.droppedIds,
        // A verbose envelope field boundList's list-local pass never
        // accounts for — this is exactly the "envelope overhead" the
        // review flagged.
        padding: "p".repeat(300),
      }),
      maxChars,
    );

    // The actual wire bytes (compact JSON, matching server.ts) must
    // respect the budget — not an internal estimate of it.
    expect(JSON.stringify(envelope).length).toBeLessThanOrEqual(maxChars);
    expect(envelope.truncated).toBe(true);
    expect(envelope.kept.length).toBeGreaterThan(0);
    expect(envelope.kept.length).toBeLessThan(items.length);
  });

  it("never returns an empty kept list purely because of envelope overhead — a single shrunk item is kept even if the assembled envelope is still slightly over budget", () => {
    const items = [{ id: "huge", data: "x".repeat(5000) }];
    const maxChars = 50; // deliberately tiny: even a shrunk item plus a verbose envelope cannot fit

    const envelope = boundResponse(
      items,
      (i) => i.id,
      (kept, meta) => ({
        kept,
        truncated: meta.truncated,
        shrunkIds: meta.shrunkIds,
        note: "a" .repeat(200), // envelope overhead alone exceeds maxChars
      }),
      maxChars,
    );

    expect(envelope.kept).toHaveLength(1);
    expect(envelope.kept[0]!.id).toBe("huge");
    expect(envelope.shrunkIds).toEqual(["huge"]);
  });

  it("the 5MB-metadata landmine: a single pathological item's response stays within a small multiple of the budget, never the item's full raw size", () => {
    // The exact shape of the review's must-fix scenario: one item whose
    // serialized size is ~200x the response budget.
    const hugeMetadata = "m".repeat(5_000_000);
    const items = [{ id: "landmine", nodeType: "doc", title: "T", content: "short content", metadata: hugeMetadata }];

    const envelope = boundResponse(
      items,
      (i) => i.id,
      (kept, meta) => ({ nodes: kept, truncated: meta.truncated, shrunkNodeIds: meta.shrunkIds }),
      DEFAULT_RESPONSE_CHAR_BUDGET,
    );

    const actualBytes = JSON.stringify(envelope).length;
    // Well under the original ~5,000,545-char response this landmine
    // used to produce — a small multiple of the budget, not 200x it.
    expect(actualBytes).toBeLessThan(DEFAULT_RESPONSE_CHAR_BUDGET * 2);
    expect(envelope.shrunkNodeIds).toEqual(["landmine"]);
    expect(envelope.nodes).toHaveLength(1);
  });
});
