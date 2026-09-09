// What the legend says about the edges currently drawn (bd-o1e,
// readable-graph-and-timeline, design.md decision 1).
//
// Two things, derived from the same one pass over the drawn links.
//
// `families` is the relation legend proper: which of palette.ts's edge
// families are actually on the canvas, with how many edges each accounts
// for. Derived from the DRAWN links rather than listed statically,
// because a legend that names five families when the view holds two is
// the same failure this change is fixing on the node side (TypePanel was
// reporting store-wide node counts beside a canvas holding none of them).
//
// `sourceSystems` is what survives of the removed `Edge provenance is
// visible` requirement. That requirement protected a real property — "a
// store whose edges all come from one source SHALL be visually obvious as
// such" — which was worth keeping even though the colour channel it spent
// was not. Reporting the composition as text says the same thing
// (`git 57` beside nothing else IS the uniformity, stated rather than
// implied) without spending a visual channel on a variable that, in this
// store, is very nearly constant within any one view.
//
// Pure and node-testable, like every other module in this directory;
// TypePanel.tsx renders what this returns.

import type { GraphLink } from "./encoding.js";
import { edgeFamily, type EdgeFamily, type EdgeFamilyKey } from "./palette.js";

export interface EdgeFamilyCount {
  family: EdgeFamily;
  count: number;
}

export interface SourceSystemCount {
  sourceSystem: string;
  count: number;
}

export interface EdgeLegend {
  /** Families present among the drawn edges, most edges first; ties broken by family key so the order is stable frame to frame. */
  families: EdgeFamilyCount[];
  /** Source systems present among the drawn edges, most edges first; ties broken by name. */
  sourceSystems: SourceSystemCount[];
  /** Total drawn edges — lets the panel say "all of them" without the caller re-summing. */
  total: number;
}

export const EMPTY_EDGE_LEGEND: EdgeLegend = { families: [], sourceSystems: [], total: 0 };

export function edgeLegendOf(links: readonly GraphLink[]): EdgeLegend {
  const byFamily = new Map<EdgeFamilyKey, number>();
  const bySource = new Map<string, number>();

  for (const link of links) {
    byFamily.set(link.family, (byFamily.get(link.family) ?? 0) + 1);
    bySource.set(link.sourceSystem, (bySource.get(link.sourceSystem) ?? 0) + 1);
  }

  const families = [...byFamily.entries()]
    .map(([key, count]) => ({ family: edgeFamily(key), count }))
    .sort((a, b) => b.count - a.count || a.family.key.localeCompare(b.family.key));

  const sourceSystems = [...bySource.entries()]
    .map(([sourceSystem, count]) => ({ sourceSystem, count }))
    .sort((a, b) => b.count - a.count || a.sourceSystem.localeCompare(b.sourceSystem));

  return { families, sourceSystems, total: links.length };
}
