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

  it("an alwaysShow candidate is placed even when every slot is already taken — never hidden", () => {
    const placements = placeLabels(fiveCoincident(true), FONT_SIZE);
    expect(placements.every((p) => p.visible)).toBe(true);
    // The fifth had nowhere free, so it falls back to the shared
    // default slot — the same one n0 already claimed — rather than
    // disappearing (graph-explorer/spec.md's "Query relevance is
    // transient, never geometry" scenario's spirit extended here: a
    // seed's own label must survive even a worst-case pile-up).
    expect(placements.find((p) => p.id === "n4")).toEqual({ id: "n4", visible: true, dx: 0, dy: BELOW_DY });
  });

  it("mixed group: an alwaysShow node processed after all four slots are already filled by other alwaysShow neighbours still gets a label", () => {
    // alwaysShow always sorts before non-alwaysShow regardless of id —
    // so to actually exhaust an alwaysShow candidate's slots, the
    // crowd filling them must also be alwaysShow (a lower-priority
    // non-alwaysShow node can never "beat" a seed to a slot). This is
    // the direct analogue of the review's real scenario: several seed
    // nodes packed into one dense cluster, none of which may lose its
    // label.
    const candidates = [...Array.from({ length: 4 }, (_, i) => candidate({ id: `seed${i}`, alwaysShow: true })), candidate({ id: "last-seed", alwaysShow: true })];
    const placements = placeLabels(candidates, FONT_SIZE);
    expect(placements.every((p) => p.visible)).toBe(true);
  });
});

describe("placeLabels — the reviewed corpus scenario: a 7-node dense cluster where every node is a seed", () => {
  // Loosely reproduces the add-knowledge-graph-core cluster from the
  // review's screenshot: seven nodes within a ~40-unit box (all seeds,
  // since the query that produced it matched every node directly) plus
  // two isolated nodes far away. The fix's guarantee under test: no seed
  // ever loses its label, no matter how tightly packed the cluster is.
  it("every seed in the tight cluster keeps a visible label", () => {
    const clusterPositions: Array<[number, number]> = [
      [0, 0],
      [8, -6],
      [-7, -5],
      [4, 8],
      [-6, 7],
      [10, 4],
      [-3, 12],
    ];
    const cluster = clusterPositions.map(([x, y], i) => candidate({ id: `cluster-${i}`, x, y, radius: 6 + i, alwaysShow: true, priority: i }));
    const isolated = [candidate({ id: "isolated-a", x: 1000, y: 0, alwaysShow: true }), candidate({ id: "isolated-b", x: 1000, y: 60, alwaysShow: true })];

    const placements = placeLabels([...cluster, ...isolated], FONT_SIZE);
    expect(placements.every((p) => p.visible)).toBe(true);
  });
});

describe("placeLabels — a hovered (non-seed) node behaves like a seed", () => {
  it("a non-seed, alwaysShow node (the currently-hovered node) is treated identically to a seed — always placed", () => {
    const crowd = Array.from({ length: 4 }, (_, i) => candidate({ id: `blocker${i}`, alwaysShow: true }));
    const hovered = candidate({ id: "hovered-not-a-seed", alwaysShow: true, priority: -1 }); // lowest priority, still must be visible
    const placements = placeLabels([...crowd, hovered], FONT_SIZE);
    expect(placements.find((p) => p.id === "hovered-not-a-seed")!.visible).toBe(true);
  });
});
