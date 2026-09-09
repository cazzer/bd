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

const AVG_CHAR_WIDTH_RATIO = 0.56; // mirrors labelPlacement.ts's own estimate — see labelBox there

/**
 * The invariant this whole module exists to protect, asserted directly
 * rather than via any one placement's coordinates: no VISIBLE label
 * overlaps another visible label or any node's circle.
 *
 * Added with displacement (bd-6qo). It matters more than it used to:
 * before, several of these tests pinned an exact `dy` per node, which
 * proved non-overlap only incidentally and broke the moment the set of
 * available slots changed. This states the property itself, so it keeps
 * holding whatever new slots get added later.
 */
function expectNoOverlaps(placements: ReturnType<typeof placeLabels>, candidates: readonly LabelCandidate[], fontSize = FONT_SIZE): void {
  const lineHeight = fontSize * DEFAULT_LABEL_LINE_HEIGHT_RATIO;
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const boxes = placements
    .filter((p) => p.visible)
    .map((p) => {
      const c = byId.get(p.id)!;
      const width = Math.max(c.text.length, 1) * fontSize * AVG_CHAR_WIDTH_RATIO;
      const x = c.x + p.dx;
      const y = c.y + p.dy;
      return { id: p.id, left: x - width / 2, right: x + width / 2, top: y, bottom: y + lineHeight };
    });
  const nodes = candidates.map((c) => ({ id: c.id, left: c.x - c.radius, right: c.x + c.radius, top: c.y - c.radius, bottom: c.y + c.radius }));
  const hit = (a: { left: number; right: number; top: number; bottom: number }, b: typeof a) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      expect(hit(boxes[i]!, boxes[j]!), `label ${boxes[i]!.id} overlaps label ${boxes[j]!.id}`).toBe(false);
    }
    for (const node of nodes) {
      expect(hit(boxes[i]!, node), `label ${boxes[i]!.id} overlaps node ${node.id}`).toBe(false);
    }
  }
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

describe("placeLabels — five coincident candidates: four cardinal slots, then displacement", () => {
  // All five candidates sit at the identical (0,0), so each of the four
  // candidateOffsets slots is at one shared absolute position for all of
  // them (see candidateOffsets' header for why exactly four — not more —
  // slots are geometrically guaranteed non-overlapping regardless of
  // label width). Processed in id order (equal priority, equal
  // alwaysShow — the tie-break), the first four each grab one cardinal
  // slot. bd-6qo changed what happens to the fifth: it used to be
  // dropped, and is now displaced outward with a leader.
  const fiveCoincident = (alwaysShow: boolean) => Array.from({ length: 5 }, (_, i) => candidate({ id: `n${i}`, alwaysShow }));

  it.each([
    ["ambient", false],
    ["alwaysShow", true],
  ])("the first four take the cardinal slots and the fifth (%s) is displaced with a leader", (_label, alwaysShow) => {
    const candidates = fiveCoincident(alwaysShow as boolean);
    const placements = placeLabels(candidates, FONT_SIZE);
    const byId = new Map(placements.map((p) => [p.id, p]));
    expect(byId.get("n0")).toEqual({ id: "n0", visible: true, dx: 0, dy: BELOW_DY });
    expect(byId.get("n1")).toEqual({ id: "n1", visible: true, dx: 0, dy: ABOVE_DY });
    expect(byId.get("n2")).toEqual({ id: "n2", visible: true, dx: 0, dy: BELOW_FAR_DY });
    expect(byId.get("n3")).toEqual({ id: "n3", visible: true, dx: 0, dy: ABOVE_FAR_DY });

    const fifth = byId.get("n4")!;
    expect(fifth.visible).toBe(true);
    expect(fifth.leader).toBeDefined();
    expectNoOverlaps(placements, candidates);
  });

  // `alwaysShow` decides processing ORDER, never outcome — the property
  // the explorer-legibility review established, and one displacement does
  // not change: with priority and alwaysShow equal across the set, the id
  // tie-break alone settles who gets which slot.
  it("alwaysShow does not change the outcome when every candidate shares it", () => {
    const ambient = placeLabels(fiveCoincident(false), FONT_SIZE);
    const always = placeLabels(fiveCoincident(true), FONT_SIZE);
    expect(always).toEqual(ambient);
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
  // bd-6qo changed the outcome here, and deliberately: the loser of the
  // slot contest used to be dropped outright, and is now displaced clear
  // of the crowd with a leader line instead. Priority still decides who
  // gets the PREFERRED slot — that part is unchanged, and is what this
  // block is named for — but losing it no longer costs a node its
  // identity on the canvas.
  it("two labels that cannot both fit: the higher-priority one keeps the preferred slot, the lower-priority one is displaced with a leader", () => {
    const high = candidate({ id: "high", priority: 2, alwaysShow: true });
    const low = candidate({ id: "low", priority: 0, alwaysShow: true });
    const fillers = ["filler-a", "filler-b", "filler-c"].map((id) => candidate({ id, priority: 1, alwaysShow: true }));
    const candidates = [high, low, ...fillers];
    const placements = placeLabels(candidates, FONT_SIZE);
    const byId = new Map(placements.map((p) => [p.id, p]));

    expect(byId.get("high")).toEqual({ id: "high", visible: true, dx: 0, dy: BELOW_DY });

    const lowPlacement = byId.get("low")!;
    expect(lowPlacement.visible).toBe(true);
    expect(lowPlacement.leader).toBeDefined(); // displaced, so it must claim its node explicitly
    // Displaced further from its node than any cardinal slot reaches —
    // measured as a distance, since displacement is not confined to the
    // vertical the cardinal slots are.
    expect(Math.hypot(lowPlacement.dx, lowPlacement.dy)).toBeGreaterThan(Math.abs(ABOVE_FAR_DY));
    expectNoOverlaps(placements, candidates);
  });

  it("a label with room in a cardinal slot carries no leader — a line to a label sitting against its own node is noise", () => {
    const placements = placeLabels([candidate({ id: "alone" })], FONT_SIZE);
    expect(placements[0]!.leader).toBeUndefined();
  });

  // The one case where a label is still lost: displacement is bounded, so
  // a point crowded past every cardinal AND every displaced slot has
  // nowhere left to put one. This is what keeps "displaced" from meaning
  // "placed anywhere, overlap be damned" — the old force-placement bug.
  it("still drops a label once every cardinal AND every displaced position is taken", () => {
    // Displacement is bounded — DISPLACED_STEPS x DISPLACED_ANGLES, on
    // top of the four cardinal slots — so a point crowded past all of
    // them has nowhere left to put a label. That bound is what keeps
    // "displaced" from degenerating into the old force-placement bug:
    // there is always a case where the answer is still "no room", and
    // the answer is still "then do not draw it", never "draw it anyway".
    const n = 60;
    const crowd = Array.from({ length: n }, (_, i) => candidate({ id: `c${String(i).padStart(2, "0")}`, priority: n - i, alwaysShow: true }));
    const placements = placeLabels(crowd, FONT_SIZE);
    expect(placements.some((p) => !p.visible)).toBe(true);
    // The highest-priority candidates are the ones that survive.
    expect(placements.find((p) => p.id === "c00")!.visible).toBe(true);
    expectNoOverlaps(placements, crowd);
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

  it("same-priority (seed) nodes still take different cardinal slots, nearest-preferred first", () => {
    expect(byId.get("cluster-1")).toEqual({ id: "cluster-1", visible: true, dx: 0, dy: aboveDy(7) });
    expect(byId.get("cluster-2")).toEqual({ id: "cluster-2", visible: true, dx: 0, dy: aboveFarDy(8) });
  });

  // bd-6qo: before displacement, cluster-3, -4 and -5 were dropped here
  // and this block asserted exactly that. The whole point of the change
  // is that a crowded cluster no longer costs those nodes their labels —
  // on the review's own screenshot the cardinal-only version labelled 6
  // of 40 nodes.
  it("the nodes that lost the cardinal contest are displaced rather than dropped", () => {
    for (const id of ["cluster-3", "cluster-4", "cluster-5", "cluster-6"]) {
      const placement = byId.get(id)!;
      expect(placement.visible, `${id} should be displaced, not dropped`).toBe(true);
      expect(placement.leader, `${id} is displaced so it must carry a leader`).toBeDefined();
    }
  });

  it("every node in the cluster keeps a label, and none of them overlap", () => {
    expect(placements.filter((p) => p.visible)).toHaveLength(placements.length);
    expectNoOverlaps(placements, [...cluster, ...isolated]);
  });

  it("a displaced label's leader starts at its node and ends on its own label box", () => {
    const placement = byId.get("cluster-3")!;
    const node = cluster[3]!;
    const leader = placement.leader!;
    // Starts on the node's circumference, not at its centre.
    expect(Math.hypot(leader.x1 - node.x, leader.y1 - node.y)).toBeCloseTo(node.radius + DEFAULT_LABEL_GAP, 5);
    // Ends within the label's own box.
    const width = Math.max(node.text.length, 1) * FONT_SIZE * AVG_CHAR_WIDTH_RATIO;
    const bx = node.x + placement.dx;
    const by = node.y + placement.dy;
    expect(leader.x2).toBeGreaterThanOrEqual(bx - width / 2 - 1e-6);
    expect(leader.x2).toBeLessThanOrEqual(bx + width / 2 + 1e-6);
    expect(leader.y2).toBeGreaterThanOrEqual(by - 1e-6);
    expect(leader.y2).toBeLessThanOrEqual(by + LINE_HEIGHT + 1e-6);
  });

  it("nodes far outside the cluster are unaffected by its slot contest", () => {
    expect(byId.get("isolated-a")).toEqual({ id: "isolated-a", visible: true, dx: 0, dy: belowDy(RADIUS) });
    expect(byId.get("isolated-b")).toEqual({ id: "isolated-b", visible: true, dx: 0, dy: belowDy(RADIUS) });
  });
});

describe("placeLabels — a hovered (non-seed) node contests slots exactly like any other alwaysShow candidate", () => {
  it("a non-seed, alwaysShow node with the lowest priority loses the cardinal contest and is displaced, never force-placed", () => {
    // This geometry has been asserted three ways as the requirement
    // moved. Originally alwaysShow guaranteed "always placed, never
    // hidden" — which force-placed a label on top of whatever was there.
    // The explorer-legibility review replaced that with "dropped, full
    // stop". bd-6qo replaces THAT with displacement, which is the
    // version that satisfies both concerns at once: the label survives,
    // and it still has to pass the same overlap test as everything else.
    const crowd = Array.from({ length: 4 }, (_, i) => candidate({ id: `blocker${i}`, alwaysShow: true }));
    const hovered = candidate({ id: "hovered-not-a-seed", alwaysShow: true, priority: -1 }); // lowest priority — processed last, finds no cardinal slot free
    const candidates = [...crowd, hovered];
    const placements = placeLabels(candidates, FONT_SIZE);

    const placement = placements.find((p) => p.id === "hovered-not-a-seed")!;
    expect(placement.visible).toBe(true);
    expect(placement.leader).toBeDefined();
    // The crowd that beat it to the cardinal slots is unaffected.
    expect(placements.filter((p) => p.id.startsWith("blocker")).every((p) => p.visible && p.leader === undefined)).toBe(true);
    expectNoOverlaps(placements, candidates);
  });
});
