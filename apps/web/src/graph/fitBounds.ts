// Percentile-trimmed bounding box for the free-area fit (bd-e9n review,
// explorer-legibility finding 6: "fit wastes the free area on outlier
// nodes"). GraphCanvas.tsx's `fitToFreeArea` used to fit the LITERAL
// bbox of every drawn node (via force-graph's own `getGraphBbox`), so
// one node that drifted far from the rest of the graph (a common force-
// layout outcome once a few nodes settle far from their neighbours)
// shrank the fitted zoom for every OTHER node just to keep that one
// on-screen. `robustBbox` below trims each axis independently to the
// [lo, hi] percentile of every node's own drawn extent before taking the
// min/max, so a handful of outliers no longer dictate the zoom level
// everyone else is squeezed into — those nodes can land off-screen; see
// GraphCanvas.tsx's `fitToFreeArea` for why that's an accepted trade,
// not a bug.
//
// Kept a pure, DOM/canvas-free function (no `ForceGraphMethods`, no
// dependency on GraphCanvas.tsx) for the same reason encoding.ts's and
// labelPlacement.ts's headers give: the bbox math is worth asserting on
// directly with vitest.

export interface BboxPoint {
  /** Node's own position, in the same graph-space units force-graph gives nodeCanvasObject. */
  x: number;
  y: number;
  /** Node's drawn radius (encoding.ts's degreeToRadius), same units — the node's own CIRCLE, not just its center, is what gets bounded. */
  radius: number;
}

export interface Bbox {
  x: [number, number];
  y: [number, number];
}

/** Below this many points, a percentile trim doesn't mean anything — see `robustBbox`'s own doc comment. */
export const ROBUST_BBOX_MIN_POINTS = 10;

/**
 * Trims a SORTED array's low end by dropping the bottom `fraction` of its
 * entries (rounded down — see `robustBbox`'s doc comment on why a partial
 * drop rounds toward "keep more, trim less" rather than interpolating a
 * value that was never actually drawn), returning the value that then
 * sits at the boundary.
 */
function trimmedMin(sortedAscending: readonly number[], fraction: number): number {
  const drop = Math.floor(sortedAscending.length * fraction);
  return sortedAscending[Math.min(drop, sortedAscending.length - 1)]!;
}

/** Mirror of `trimmedMin` for the high end of a sorted array. */
function trimmedMax(sortedAscending: readonly number[], fraction: number): number {
  const drop = Math.floor(sortedAscending.length * fraction);
  return sortedAscending[Math.max(sortedAscending.length - 1 - drop, 0)]!;
}

/**
 * Percentile-trimmed bbox over each point's own PADDED extent
 * (`x`/`y` ± its `radius`, so a node's drawn CIRCLE — not just its
 * center — is what's being bounded, matching the padding contract of the
 * `getGraphBbox` call this replaces at high node counts). `lo`/`hi` trim
 * each axis independently (0.05/0.95 by default): the lowest `lo`
 * fraction of points' own lower edges (`x - radius`, and separately
 * `y - radius`) and the highest `hi`-complement fraction of points' own
 * upper edges are dropped before taking min/max — an outlier only
 * shrinks the fitted view if enough OTHER points share its extreme side,
 * which a single far-drifted node never does.
 *
 * Below `ROBUST_BBOX_MIN_POINTS` (10), returns the FULL extent
 * regardless of `lo`/`hi` — a handful of points is never "dense" enough
 * for a percentile trim to mean anything, and trimming a tiny set risks
 * cutting a real node's own extent, not an outlier's. `null` for zero
 * points, matching `getGraphBbox`'s own no-op contract (GraphCanvas.tsx
 * relies on this — see `fitToFreeArea`).
 */
export function robustBbox(points: readonly BboxPoint[], lo = 0.05, hi = 0.95): Bbox | null {
  if (points.length === 0) return null;

  const lowerX = points.map((p) => p.x - p.radius).sort((a, b) => a - b);
  const upperX = points.map((p) => p.x + p.radius).sort((a, b) => a - b);
  const lowerY = points.map((p) => p.y - p.radius).sort((a, b) => a - b);
  const upperY = points.map((p) => p.y + p.radius).sort((a, b) => a - b);

  if (points.length < ROBUST_BBOX_MIN_POINTS) {
    return {
      x: [lowerX[0]!, upperX[upperX.length - 1]!],
      y: [lowerY[0]!, upperY[upperY.length - 1]!],
    };
  }

  return {
    x: [trimmedMin(lowerX, lo), trimmedMax(upperX, 1 - hi)],
    y: [trimmedMin(lowerY, lo), trimmedMax(upperY, 1 - hi)],
  };
}
