// bd-6qo: the halo budget. Node-environment tests, no DOM — what gets
// decided is asserted here, what gets painted is not (see
// encoding.test.ts's header for the split).

import { describe, expect, it } from "vitest";
import { HALO_TIER_FOCUSED, HALO_TIER_NEIGHBOR, HALO_TIER_SEED, HALO_TIER_SELECTED, MAX_HALOED_NODES, selectHaloedNodes } from "./haloBudget.js";

function neighbors(n: number, tier: number = HALO_TIER_NEIGHBOR) {
  // Padded ids so the id tie-break is lexicographic in the same order a
  // reader expects; an unpadded "n10" sorts before "n2".
  return Array.from({ length: n }, (_, i) => ({ id: `n${String(i).padStart(3, "0")}`, tier }));
}

describe("selectHaloedNodes", () => {
  it("returns everything when the candidates fit inside the budget", () => {
    const chosen = selectHaloedNodes(neighbors(5));
    expect(chosen.size).toBe(5);
  });

  // graph-explorer/spec.md, "Selecting a hub": the review's own case —
  // selecting the degree-98 repo made 28+ neighbours relevant at once.
  it("caps a hub's neighbourhood at the budget rather than haloing all 28", () => {
    const chosen = selectHaloedNodes([{ id: "selected", tier: HALO_TIER_SELECTED }, ...neighbors(28)]);
    expect(chosen.size).toBe(MAX_HALOED_NODES);
  });

  // The property the spec scenario actually depends on: it must be
  // impossible for the node the person just clicked to be the one
  // dropped. That follows from the tier ordering, not from luck, so it
  // holds however many neighbours crowd in.
  it("never drops the selected node, however large the neighbourhood", () => {
    for (const n of [11, 12, 13, 40, 500]) {
      const chosen = selectHaloedNodes([...neighbors(n), { id: "selected", tier: HALO_TIER_SELECTED }]);
      expect(chosen.has("selected")).toBe(true);
      expect(chosen.size).toBeLessThanOrEqual(MAX_HALOED_NODES);
    }
  });

  it("fills the budget by tier — a seed outranks a neighbour, a neighbour outranks a focus match", () => {
    const chosen = selectHaloedNodes(
      [
        { id: "focused", tier: HALO_TIER_FOCUSED },
        ...neighbors(3),
        { id: "seed", tier: HALO_TIER_SEED },
      ],
      2,
    );
    expect([...chosen].sort()).toEqual(["n000", "seed"]);
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

  it("halos nothing for an empty graph or a non-positive budget", () => {
    expect(selectHaloedNodes([]).size).toBe(0);
    expect(selectHaloedNodes(neighbors(5), 0).size).toBe(0);
    expect(selectHaloedNodes(neighbors(5), -1).size).toBe(0);
  });
});
