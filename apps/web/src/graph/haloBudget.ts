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

/** Highest first. The same tiers GraphCanvas computes for label priority, reused rather than redefined so one description of "how relevant is this node" serves both — but they do not select the same SET; see the module header. */
export const HALO_TIER_SELECTED = 3;
export const HALO_TIER_SEED = 2;
export const HALO_TIER_NEIGHBOR = 1;
export const HALO_TIER_FOCUSED = 0;

/**
 * How many NEIGHBOURS-OF-THE-SELECTION may carry a halo at once.
 *
 * The budget applies to this tier alone (see `selectHaloedNodes`), and
 * that is the correction the first version of this module needed. It
 * capped all four tiers against one shared allowance of 12, with seeds
 * ranked ABOVE neighbours — and a search returns up to
 * DEFAULT_SEED_LIMIT (10) seeds. So selecting the degree-98 hub spent
 * the budget on 10 seeds plus the selected node and left exactly ONE
 * haloed neighbour, picked by lexicographic node id, which has no
 * relation to anything on screen. The wash was gone and so was the
 * neighbourhood, which is the signal selection exists to draw.
 *
 * It was worse for type focus, which sits at the lowest tier: 10 seeds
 * ate the allowance and two matching nodes glowed, silently reverting
 * bd-8ub should-fix 9 ("a brighter halo on the MATCHING nodes ... rather
 * than the payoff resting on the dimming alone").
 *
 * Only this tier is unbounded by nature. Seeds are already bounded by
 * the seed limit AND carry a second, unbudgeted channel (the dashed seed
 * ring), so they need no allowance here. Focus matches are the
 * deliberate "all of them" case. The selected node is one node.
 */
export const MAX_HALOED_NEIGHBORS = 12;

export interface HaloCandidate {
  id: string;
  /** One of the HALO_TIER_* values. A node that qualifies under several takes the highest. */
  tier: number;
}

/**
 * Every candidate except the neighbour tier, which is capped at `max`
 * (ties within it broken by id, so the chosen set is stable frame to
 * frame rather than flickering as the simulation reorders nodes).
 *
 * The selected node, the seeds and the focus matches all pass through
 * untouched — see MAX_HALOED_NEIGHBORS for why bounding them too was a
 * mistake. The 28-neighbours-of-one-hub case that motivated this module
 * is still bounded, which was the actual failure.
 */
export function selectHaloedNodes(candidates: readonly HaloCandidate[], max: number = MAX_HALOED_NEIGHBORS): Set<string> {
  const chosen = new Set<string>();
  const neighbors: HaloCandidate[] = [];
  for (const candidate of candidates) {
    if (candidate.tier === HALO_TIER_NEIGHBOR) {
      neighbors.push(candidate);
    } else {
      chosen.add(candidate.id);
    }
  }
  if (max > 0) {
    // Sorted by id alone: every candidate here shares one tier, so id is
    // the only tie-break there is, and it must be deterministic or the
    // haloed set would churn between frames.
    neighbors.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const candidate of neighbors.slice(0, max)) chosen.add(candidate.id);
  }
  return chosen;
}
