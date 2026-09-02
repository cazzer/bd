// Tests for the free-area fit's outlier-trimmed bbox (bd-e9n review,
// explorer-legibility finding 6). Every scenario is fully
// hand-computable — see each block's own worked math.

import { describe, expect, it } from "vitest";
import { robustBbox, ROBUST_BBOX_MIN_POINTS, type BboxPoint } from "./fitBounds.js";

describe("robustBbox — zero points", () => {
  it("returns null, matching getGraphBbox's own no-op contract", () => {
    expect(robustBbox([])).toBeNull();
  });
});

describe("robustBbox — fewer than 10 points returns the full extent", () => {
  it("ignores lo/hi entirely below ROBUST_BBOX_MIN_POINTS, even with a wild outlier", () => {
    expect(ROBUST_BBOX_MIN_POINTS).toBe(10);
    const points: BboxPoint[] = [
      { x: 0, y: 0, radius: 0 },
      { x: 1, y: 1, radius: 0 },
      { x: 1000, y: -500, radius: 0 }, // a genuine outlier, still 9 points total
    ];
    expect(points.length).toBeLessThan(ROBUST_BBOX_MIN_POINTS);
    const bbox = robustBbox(points, 0.05, 0.95);
    // Full extent: the outlier's own coordinates ARE the bound, exactly
    // as a literal min/max bbox (force-graph's getGraphBbox) would give.
    expect(bbox).toEqual({ x: [0, 1000], y: [-500, 1] });
  });
});

describe("robustBbox — radius padding is applied", () => {
  it("bounds each point's drawn CIRCLE (x/y ± radius), not just its center — full-extent path (< 10 points)", () => {
    const points: BboxPoint[] = [
      { x: 0, y: 0, radius: 5 },
      { x: 100, y: 50, radius: 20 },
    ];
    const bbox = robustBbox(points);
    // x: [0 - 5, 100 + 20]; y: [0 - 5, 50 + 20] — each point's own
    // radius pads ITS OWN edge, not a shared one.
    expect(bbox).toEqual({ x: [-5, 120], y: [-5, 70] });
  });

  it("radius padding also applies in the trimmed (>= 10 points) path", () => {
    // 20 coincident points at the origin, one with a much larger radius
    // — with no spread in x/y, only radius can widen the bbox beyond
    // zero, and the trim (see the "one outlier excluded" describe block
    // below for the same drop-count math) drops that one large-radius
    // point's contribution rather than letting it set the bound.
    const points: BboxPoint[] = Array.from({ length: 19 }, () => ({ x: 0, y: 0, radius: 1 }));
    points.push({ x: 0, y: 0, radius: 50 });
    expect(points.length).toBeGreaterThanOrEqual(ROBUST_BBOX_MIN_POINTS);
    const bbox = robustBbox(points, 0.05, 0.95);
    // lowerX sorted: nineteen -1's then -50 → trimmedMin drops floor(20*0.05)=1 from the bottom (the -50) → -1.
    // upperX sorted: nineteen 1's then 50 → trimmedMax drops floor(20*0.05)=1 from the top (the 50) → 1.
    expect(bbox).toEqual({ x: [-1, 1], y: [-1, 1] });
  });
});

describe("robustBbox — one outlier excluded (>= 10 points)", () => {
  it("a single far-drifted point does not shift the trimmed bound", () => {
    // 19 points clustered at x = 0..18 (radius 0), plus one outlier at
    // x = 1000 — 20 points total. Sorted upper-x edges:
    // [0, 1, ..., 18, 1000]. trimmedMax with hi = 0.95 drops
    // floor(20 * (1 - 0.95)) = 1 from the top, landing on index 18
    // (value 18) — the outlier at index 19 never becomes the bound.
    // The symmetric low-side trim (lo = 0.05) drops 1 from the bottom
    // too (index 0, value 0), landing on index 1 (value 1) — there's no
    // low-side outlier here, this is just the same trim applied to both
    // ends, same as the "radius padding" trimmed-path test above.
    const cluster = Array.from({ length: 19 }, (_, i) => ({ x: i, y: 0, radius: 0 }));
    const points: BboxPoint[] = [...cluster, { x: 1000, y: 0, radius: 0 }];
    const bbox = robustBbox(points, 0.05, 0.95);
    expect(bbox).toEqual({ x: [1, 18], y: [0, 0] });
  });

  it("an outlier on the y axis is excluded independently of x", () => {
    const cluster = Array.from({ length: 19 }, (_, i) => ({ x: 0, y: i, radius: 0 }));
    const points: BboxPoint[] = [...cluster, { x: 0, y: -1000, radius: 0 }];
    const bbox = robustBbox(points, 0.05, 0.95);
    // y's lower edges sorted: [-1000, 0, 1, ..., 18]. trimmedMin drops
    // floor(20*0.05)=1 from the bottom (the -1000 outlier), landing on
    // index 1 (value 0).
    expect(bbox).toEqual({ x: [0, 0], y: [0, 17] });
  });
});
