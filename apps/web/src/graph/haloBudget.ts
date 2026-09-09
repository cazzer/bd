// Which nodes get a halo this frame (bd-6qo, readable-graph-and-timeline,
// design.md decision 2).
//
// The failure this exists to fix: GraphCanvas's `drawNode` treated
// `isSeed || isSelected || isNeighborOfSelected || isFocusedMatch` as the
// halo condition, and drew two filled circles at 2.2x and 1.5x the node
// radius for every node that matched. `isNeighborOfSelected` is true for
// EVERY neighbour of the selection, so selecting a degree-98 node painted
// 28+ overlapping halos at once and the neighbourhood became a single
// continuous wash with not one edge visible through it.
//
// The important thing about that failure is that it is a COUNT problem,
// not a radius problem. A halo small enough never to merge at 28 nodes is
// too faint to notice at one, so shrinking it would have traded a
// broken emphasis for a useless one. Bounding how many nodes may carry a
// halo keeps the effect at full strength where it is drawn and stops it
// becoming a background.
//
// Selection is by the same relevance tiers GraphCanvas already computes
// for label priority — deliberately the same ordering, so the nodes that
// keep their halo are the nodes that keep their label, and the two
// emphases never disagree about what matters. Ties break on node id so
// the chosen set is stable frame to frame: a set that reshuffled would
// make halos flicker on and off during the simulation, which is worse
// than either drawing them or not.
//
// Pure and node-testable; GraphCanvas draws what this returns.

/** Highest first. Mirrors GraphCanvas's label priority tiers exactly — see the module header on why the two must agree. */
export const HALO_TIER_SELECTED = 3;
export const HALO_TIER_SEED = 2;
export const HALO_TIER_NEIGHBOR = 1;
export const HALO_TIER_FOCUSED = 0;

/**
 * How many nodes may carry a halo at once. Twelve is enough that a
 * modest neighbourhood is fully emphasised and small enough that the
 * halos stay separable at the densities this app actually reaches — the
 * review's 28-neighbour case is the one being bounded.
 */
export const MAX_HALOED_NODES = 12;

export interface HaloCandidate {
  id: string;
  /** One of the HALO_TIER_* values. A node that qualifies under several takes the highest. */
  tier: number;
}

/**
 * The at-most-`max` most relevant candidates, highest tier first, ties
 * broken by id.
 *
 * The selected node holds the top tier, so it is never the node dropped
 * — that is a property of the ordering, not of luck, and
 * graph-explorer/spec.md's "Selecting a hub" scenario depends on it.
 */
export function selectHaloedNodes(candidates: readonly HaloCandidate[], max: number = MAX_HALOED_NODES): Set<string> {
  if (max <= 0) return new Set();
  const ordered = [...candidates].sort((a, b) => b.tier - a.tier || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return new Set(ordered.slice(0, max).map((c) => c.id));
}
