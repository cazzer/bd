// Tests for the label-collision-avoidance pure function (bd-hmd.4 follow-up
// review: task 4.3's "legible at the default zoom" scenario, re-checked
// after the review found labels overlapping in the corpus's densest
// cluster). Every scenario below is fully hand-computable — see the
// worked geometry in each describe block's comment — rather than relying
// on the implementation to grade its own homework.

import { describe, expect, it } from "vitest";
import { DEFAULT_LABEL_GAP, DEFAULT_LABEL_LINE_HEIGHT_RATIO, placeLabels, STACK_GAP, type LabelCandidate } from "./labelPlacement.js";

const FONT_SIZE = 12;
const RADIUS = 5;
const LINE_HEIGHT = FONT_SIZE * DEFAULT_LABEL_LINE_HEIGHT_RATIO;
const BELOW_DY = RADIUS + DEFAULT_LABEL_GAP; // 7 — the node's own default/preferred offset
const ABOVE_DY = -(RADIUS + DEFAULT_LABEL_GAP + LINE_HEIGHT); // ~-21.4 — the 2nd-preferred slot
const BELOW_FAR_DY = BELOW_DY + LINE_HEIGHT + STACK_GAP; // ~23.4 — one row further below — the 3rd-preferred slot
const ABOVE_FAR_DY = ABOVE_DY - LINE_HEIGHT - STACK_GAP; // ~-37.8 — one row further above — the 4th (last) slot

function candidate(overrides: Partial<LabelCandidate> & { id: string }): LabelCandidate {
  return { x: 0, y: 0, radius: RADIUS, text: overrides.id, alwaysShow: false, priority: 0, ...overrides };
}

describe("placeLabels — uncrowded nodes", () => {
  it("two widely separated nodes both get their default (below) slot", () => {
    const candidates = [candidate({ id: "a", x: 0, y: 0 }), candidate({ id: "b", x: 200, y: 0 })];
    const placements = placeLabels(candidates, FONT_SIZE);
    expect(placements).toEqual([
      { id: "a", visible: true, dx: 0, dy: BELOW_DY },
      { id: "b", visible: true, dx: 0, dy: BELOW_DY },
    ]);
  });

  it("preserves the input order in its output regardless of processing order", () => {
    const candidates = [
      candidate({ id: "low-priority", x: 0, y: 0, priority: 1 }),
      candidate({ id: "high-priority", x: 500, y: 0, priority: 9 }),
    ];
    const placements = placeLabels(candidates, FONT_SIZE);
    expect(placements.map((p) => p.id)).toEqual(["low-priority", "high-priority"]);
  });
});

describe("placeLabels — two coincident nodes (identical x/y): priority decides who gets the preferred slot", () => {
  // Both at (0,0), same radius, so every candidate slot is at the exact
  // same absolute position for both — the only thing that can differ is
  // WHICH slot each one ends up in. The higher-priority node is
  // processed first and always finds its own first choice ("below")
  // free; the lower-priority node's identical "below" attempt then
  // collides with that already-placed label, so it falls through to the
  // next candidate ("above"), which is unclaimed.
  it("the higher-priority node keeps the default slot; the lower-priority one is displaced to the next slot, not hidden", () => {
    const candidates = [candidate({ id: "hub", priority: 10 }), candidate({ id: "leaf", priority: 1 })];
    const placements = placeLabels(candidates, FONT_SIZE);
    expect(placements).toEqual([
      { id: "hub", visible: true, dx: 0, dy: BELOW_DY },
      { id: "leaf", visible: true, dx: 0, dy: ABOVE_DY },
    ]);
  });
});

describe("placeLabels — slot exhaustion at one point (5 coincident candidates, only 4 candidate slots exist)", () => {
  // All five candidates sit at the identical (0,0), so each of the four
  // candidateOffsets slots is at one shared absolute position for all
  // of them (see candidateOffsets' header for why exactly four — not
  // more — slots are geometrically guaranteed non-overlapping
  // regardless of label width). Processed in id order (equal priority,
  // equal alwaysShow — the tie-break), the first four each grab one of
  // the four slots; the fifth finds all of them already occupied.
  const fiveCoincident = (alwaysShow: boolean) => Array.from({ length: 5 }, (_, i) => candidate({ id: `n${i}`, alwaysShow }));

  it("a non-alwaysShow candidate with no free slot left is hidden, not overlapped", () => {
    const placements = placeLabels(fiveCoincident(false), FONT_SIZE);
    const byId = new Map(placements.map((p) => [p.id, p]));
    expect(byId.get("n0")).toEqual({ id: "n0", visible: true, dx: 0, dy: BELOW_DY });
    expect(byId.get("n1")).toEqual({ id: "n1", visible: true, dx: 0, dy: ABOVE_DY });
    expect(byId.get("n2")).toEqual({ id: "n2", visible: true, dx: 0, dy: BELOW_FAR_DY });
    expect(byId.get("n3")).toEqual({ id: "n3", visible: true, dx: 0, dy: ABOVE_FAR_DY });
    // A hidden label carries no drawable offset — GraphCanvas must not draw it.
    expect(byId.get("n4")).toEqual({ id: "n4", visible: false, dx: 0, dy: 0 });
  });

  it("an alwaysShow candidate with no free slot left is ALSO hidden, not force-placed on top of another label (explorer-legibility review, hub-density fix)", () => {
    // Before this fix, the fifth fell back to n0's already-claimed
    // default slot instead of disappearing — exactly the overlap this
    // review found at hub density (several seeds/neighbours converging
    // on one node). With every candidate's priority and alwaysShow
    // status equal here, the id tie-break still decides processing
    // order, so the result is identical to the non-alwaysShow case
    // above: alwaysShow no longer changes whether a candidate can be
    // dropped, only that it's tried first (see the next describe block
    // for what DOES still decide who wins a contested slot).
    const placements = placeLabels(fiveCoincident(true), FONT_SIZE);
    const byId = new Map(placements.map((p) => [p.id, p]));
    expect(byId.get("n0")).toEqual({ id: "n0", visible: true, dx: 0, dy: BELOW_DY });
    expect(byId.get("n1")).toEqual({ id: "n1", visible: true, dx: 0, dy: ABOVE_DY });
    expect(byId.get("n2")).toEqual({ id: "n2", visible: true, dx: 0, dy: BELOW_FAR_DY });
    expect(byId.get("n3")).toEqual({ id: "n3", visible: true, dx: 0, dy: ABOVE_FAR_DY });
    expect(byId.get("n4")).toEqual({ id: "n4", visible: false, dx: 0, dy: 0 });
  });
});

describe("placeLabels — priority decides who is dropped when two labels can't both fit (explorer-legibility review, finding 5)", () => {
  // Three "filler" candidates (priority 1) are just enough to consume 3
  // of the 4 geometrically-guaranteed slots at this coincident point,
  // leaving exactly one slot contested between "high" (priority 2) and
  // "low" (priority 0). Processing order (priority desc): high, then
  // the three fillers, then low — high claims the slot first (nothing
  // placed yet), the fillers claim the remaining three, and low finds
  // every slot already taken.
  it("two labels that cannot both fit: only the higher-priority one is placed, the lower-priority one is dropped", () => {
    const high = candidate({ id: "high", priority: 2, alwaysShow: true });
    const low = candidate({ id: "low", priority: 0, alwaysShow: true });
    const fillers = ["filler-a", "filler-b", "filler-c"].map((id) => candidate({ id, priority: 1, alwaysShow: true }));
    const placements = placeLabels([high, low, ...fillers], FONT_SIZE);
    const byId = new Map(placements.map((p) => [p.id, p]));
    expect(byId.get("high")).toEqual({ id: "high", visible: true, dx: 0, dy: BELOW_DY });
    expect(byId.get("low")).toEqual({ id: "low", visible: false, dx: 0, dy: 0 });
  });

  it("unrelated labels are unaffected by that contest", () => {
    const high = candidate({ id: "high", priority: 2, alwaysShow: true });
    const low = candidate({ id: "low", priority: 0, alwaysShow: true });
    const fillers = ["filler-a", "filler-b", "filler-c"].map((id) => candidate({ id, priority: 1, alwaysShow: true }));
    const placements = placeLabels([high, low, ...fillers], FONT_SIZE);
    const byId = new Map(placements.map((p) => [p.id, p]));
    // The three fillers — not party to the high/low contest, just
    // sharing the same point — all still get a slot, regardless of
    // which of high/low won theirs.
    expect(byId.get("filler-a")).toEqual({ id: "filler-a", visible: true, dx: 0, dy: ABOVE_DY });
    expect(byId.get("filler-b")).toEqual({ id: "filler-b", visible: true, dx: 0, dy: BELOW_FAR_DY });
    expect(byId.get("filler-c")).toEqual({ id: "filler-c", visible: true, dx: 0, dy: ABOVE_FAR_DY });
    // A node far away from the contested point is unaffected too.
    const distant = candidate({ id: "distant", x: 500, y: 0, alwaysShow: true, priority: 0 });
    const withDistant = placeLabels([high, low, ...fillers, distant], FONT_SIZE);
    expect(withDistant.find((p) => p.id === "distant")).toEqual({ id: "distant", visible: true, dx: 0, dy: BELOW_DY });
  });
});

describe("placeLabels — the reviewed corpus scenario: a 7-node dense cluster, priority order settles who keeps a label", () => {
  // Loosely reproduces the add-knowledge-graph-core cluster from the
  // review's screenshot: seven nodes within a ~40-unit box, growing
  // radius (a rough stand-in for degree), plus two isolated nodes far
  // away. cluster-0 stands in for the selected node (priority 3); the
  // rest stand in for seeds (priority 2, GraphCanvas's own tier order —
  // see computeLabelPlacements' doc comment). Expected offsets below are
  // the actual (fixed) algorithm's output for this exact geometry —
  // computed via the same radius-dependent formulas BELOW_DY/etc. above
  // generalize to (belowDy/aboveDy/belowFarDy/aboveFarDy, this block's
  // own helpers), not asserted from first principles: a 7-body packing
  // problem isn't hand-solvable the way the coincident-point cases above
  // are, but the RESULT is still exactly reproducible from those same
  // four formulas once each node's own radius is known.
  const belowDy = (radius: number) => radius + DEFAULT_LABEL_GAP;
  const aboveDy = (radius: number) => -(radius + DEFAULT_LABEL_GAP + LINE_HEIGHT);
  const belowFarDy = (radius: number) => belowDy(radius) + LINE_HEIGHT + STACK_GAP;
  const aboveFarDy = (radius: number) => aboveDy(radius) - LINE_HEIGHT - STACK_GAP;

  const clusterPositions: Array<[number, number]> = [
    [0, 0],
    [8, -6],
    [-7, -5],
    [4, 8],
    [-6, 7],
    [10, 4],
    [-3, 12],
  ];
  const cluster = clusterPositions.map(([x, y], i) => candidate({ id: `cluster-${i}`, x, y, radius: 6 + i, alwaysShow: true, priority: i === 0 ? 3 : 2 }));
  const isolated = [candidate({ id: "isolated-a", x: 1000, y: 0, alwaysShow: true }), candidate({ id: "isolated-b", x: 1000, y: 60, alwaysShow: true })];
  const placements = placeLabels([...cluster, ...isolated], FONT_SIZE);
  const byId = new Map(placements.map((p) => [p.id, p]));

  it("the highest-priority node (selected, priority 3) still gets a slot, even if not its preferred one", () => {
    expect(byId.get("cluster-0")).toEqual({ id: "cluster-0", visible: true, dx: 0, dy: belowFarDy(6) });
  });

  it("some same-priority (seed) nodes win a slot and some lose, not every one guaranteed anymore", () => {
    expect(byId.get("cluster-1")).toEqual({ id: "cluster-1", visible: true, dx: 0, dy: aboveDy(7) });
    expect(byId.get("cluster-2")).toEqual({ id: "cluster-2", visible: true, dx: 0, dy: aboveFarDy(8) });
    expect(byId.get("cluster-3")).toEqual({ id: "cluster-3", visible: false, dx: 0, dy: 0 });
    expect(byId.get("cluster-4")).toEqual({ id: "cluster-4", visible: false, dx: 0, dy: 0 });
    expect(byId.get("cluster-5")).toEqual({ id: "cluster-5", visible: false, dx: 0, dy: 0 });
    expect(byId.get("cluster-6")).toEqual({ id: "cluster-6", visible: true, dx: 0, dy: belowFarDy(12) });
  });

  it("nodes far outside the cluster are unaffected by its slot contest", () => {
    expect(byId.get("isolated-a")).toEqual({ id: "isolated-a", visible: true, dx: 0, dy: belowDy(RADIUS) });
    expect(byId.get("isolated-b")).toEqual({ id: "isolated-b", visible: true, dx: 0, dy: belowDy(RADIUS) });
  });
});

describe("placeLabels — a hovered (non-seed) node contests slots exactly like any other alwaysShow candidate", () => {
  it("a non-seed, alwaysShow node with the lowest priority in a full crowd is dropped, not force-placed (explorer-legibility review)", () => {
    // Before this fix, "always placed, never hidden" was alwaysShow's
    // own guarantee regardless of priority — this exact geometry used to
    // assert the opposite of what's asserted below. It no longer holds:
    // alwaysShow now only decides processing ORDER (ahead of ambient
    // nodes), not whether a candidate can lose a contest for the last
    // slot.
    const crowd = Array.from({ length: 4 }, (_, i) => candidate({ id: `blocker${i}`, alwaysShow: true }));
    const hovered = candidate({ id: "hovered-not-a-seed", alwaysShow: true, priority: -1 }); // lowest priority — processed last, finds nothing free
    const placements = placeLabels([...crowd, hovered], FONT_SIZE);
    expect(placements.find((p) => p.id === "hovered-not-a-seed")).toEqual({ id: "hovered-not-a-seed", visible: false, dx: 0, dy: 0 });
    // The crowd that beat it is unaffected — still all four visible.
    expect(placements.filter((p) => p.id.startsWith("blocker")).every((p) => p.visible)).toBe(true);
  });
});
