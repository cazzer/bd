// bd-6qo: the halo budget. Node-environment tests, no DOM — what gets
// decided is asserted here, what gets painted is not (see
// encoding.test.ts's header for the split).

import { describe, expect, it } from "vitest";
import { HALO_TIER_FOCUSED, HALO_TIER_NEIGHBOR, HALO_TIER_SEED, HALO_TIER_SELECTED, MAX_HALOED_NEIGHBORS, selectHaloedNodes } from "./haloBudget.js";

function neighbors(n: number, tier: number = HALO_TIER_NEIGHBOR) {
  // Padded ids so the id tie-break is lexicographic in the same order a
  // reader expects; an unpadded "n10" sorts before "n2".
  return Array.from({ length: n }, (_, i) => ({ id: `n${String(i).padStart(3, "0")}`, tier }));
}

describe("selectHaloedNodes", () => {
  it("returns everything when the neighbours fit inside the budget", () => {
    const chosen = selectHaloedNodes(neighbors(5));
    expect(chosen.size).toBe(5);
  });

  // graph-explorer/spec.md, "Selecting a hub": the review's own case —
  // selecting the degree-98 repo made 28+ neighbours relevant at once.
  it("caps a hub's neighbourhood at the budget rather than haloing all 28", () => {
    const chosen = selectHaloedNodes([{ id: "selected", tier: HALO_TIER_SELECTED }, ...neighbors(28)]);
    expect(chosen.size).toBe(MAX_HALOED_NEIGHBORS + 1); // the neighbours, capped, plus the selected node
    expect(chosen.has("selected")).toBe(true);
  });

  // The regression the first version of this module shipped: one shared
  // allowance with seeds ranked above neighbours meant a normal search
  // (up to DEFAULT_SEED_LIMIT = 10 seeds) spent the whole budget before
  // the neighbourhood got a slot, leaving the selected hub with ONE
  // haloed neighbour chosen by id sort.
  it("does not let seeds crowd the selection's neighbourhood out of the budget", () => {
    const seeds = Array.from({ length: 10 }, (_, i) => ({ id: `seed${i}`, tier: HALO_TIER_SEED }));
    const chosen = selectHaloedNodes([...seeds, { id: "selected", tier: HALO_TIER_SELECTED }, ...neighbors(28)]);
    const haloedNeighbors = [...chosen].filter((id) => id.startsWith("n"));
    expect(haloedNeighbors).toHaveLength(MAX_HALOED_NEIGHBORS);
    for (const seed of seeds) expect(chosen.has(seed.id)).toBe(true);
  });

  // bd-8ub should-fix 9: a type focus puts a BRIGHTER halo on every
  // matching node, so the payoff does not rest on the dimming alone. The
  // shared-budget version reverted that silently — 10 seeds ate the
  // allowance and two matches glowed.
  it("halos every focus match, however many there are", () => {
    const matches = Array.from({ length: 50 }, (_, i) => ({ id: `m${String(i).padStart(3, "0")}`, tier: HALO_TIER_FOCUSED }));
    const seeds = Array.from({ length: 10 }, (_, i) => ({ id: `seed${i}`, tier: HALO_TIER_SEED }));
    const chosen = selectHaloedNodes([...seeds, ...matches]);
    for (const m of matches) expect(chosen.has(m.id), `${m.id} should keep its focus halo`).toBe(true);
  });

  // The property the spec scenario actually depends on: it must be
  // impossible for the node the person just clicked to be the one
  // dropped. That follows from the tier ordering, not from luck, so it
  // holds however many neighbours crowd in.
  it("never drops the selected node, however large the neighbourhood", () => {
    for (const n of [11, 12, 13, 40, 500]) {
      const chosen = selectHaloedNodes([...neighbors(n), { id: "selected", tier: HALO_TIER_SELECTED }]);
      expect(chosen.has("selected")).toBe(true);
      // The neighbour tier is what the cap applies to; the selected node
      // is outside it, so the total is the cap plus itself.
      expect(chosen.size).toBeLessThanOrEqual(MAX_HALOED_NEIGHBORS + 1);
    }
  });

  it("budgets the neighbour tier only — every other tier passes through", () => {
    const chosen = selectHaloedNodes(
      [
        { id: "focused", tier: HALO_TIER_FOCUSED },
        ...neighbors(3),
        { id: "seed", tier: HALO_TIER_SEED },
      ],
      1,
    );
    expect([...chosen].sort()).toEqual(["focused", "n000", "seed"]);
  });

  // A set that reshuffled between frames would make halos flicker on and
  // off while the simulation runs.
  it("is stable across calls regardless of input order", () => {
    const candidates = [...neighbors(30), { id: "selected", tier: HALO_TIER_SELECTED }];
    const a = selectHaloedNodes(candidates);
    const b = selectHaloedNodes([...candidates].reverse());
    expect([...a].sort()).toEqual([...b].sort());
  });

  it("breaks a same-tier tie on id, so the chosen set is deterministic", () => {
    const chosen = selectHaloedNodes([{ id: "b", tier: 1 }, { id: "a", tier: 1 }, { id: "c", tier: 1 }], 2);
    expect([...chosen].sort()).toEqual(["a", "b"]);
  });

  it("does not mutate the caller's array", () => {
    const candidates = [{ id: "b", tier: 1 }, { id: "a", tier: 2 }];
    selectHaloedNodes(candidates, 1);
    expect(candidates.map((c) => c.id)).toEqual(["b", "a"]);
  });

  it("halos nothing for an empty graph, and no NEIGHBOUR for a non-positive budget", () => {
    expect(selectHaloedNodes([]).size).toBe(0);
    expect(selectHaloedNodes(neighbors(5), 0).size).toBe(0);
    expect(selectHaloedNodes(neighbors(5), -1).size).toBe(0);
    // A zero budget still does not silence the selection itself.
    expect(selectHaloedNodes([{ id: "selected", tier: HALO_TIER_SELECTED }, ...neighbors(5)], 0).size).toBe(1);
  });
});
