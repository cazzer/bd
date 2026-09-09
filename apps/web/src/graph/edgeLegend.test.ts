// bd-o1e (readable-graph-and-timeline, design.md decision 1): the edge
// relation families and the legend derived from the drawn links.
//
// Node-environment tests, no DOM — the same split every other module in
// this directory follows (see encoding.test.ts's header): what gets
// decided is asserted here, what gets painted is not asserted at all.

import { describe, expect, it } from "vitest";
import { edgeLegendOf, EMPTY_EDGE_LEGEND } from "./edgeLegend.js";
import type { GraphLink } from "./encoding.js";
import { edgeFamily, familyForEdgeType, familyKeyForEdgeType, knownEdgeFamilies } from "./palette.js";

function link(over: Partial<GraphLink> & Pick<GraphLink, "id" | "edgeType" | "sourceSystem">): GraphLink {
  return {
    source: "a",
    target: "b",
    weight: 1,
    width: 5,
    family: familyKeyForEdgeType(over.edgeType),
    ...over,
  };
}

describe("familyKeyForEdgeType — the relation families", () => {
  it("puts the store's containment relations in one family", () => {
    for (const t of ["child_of", "belongs-to", "part-of-change"]) {
      expect(familyKeyForEdgeType(t)).toBe("containment");
    }
  });

  it("puts the dependency relations in one family, separate from containment", () => {
    expect(familyKeyForEdgeType("blocks")).toBe("dependency");
    expect(familyKeyForEdgeType("closes")).toBe("dependency");
    expect(familyKeyForEdgeType("blocks")).not.toBe(familyKeyForEdgeType("child_of"));
  });

  it("puts the reference relations in one family", () => {
    expect(familyKeyForEdgeType("mentions")).toBe("reference");
    expect(familyKeyForEdgeType("touches")).toBe("reference");
  });

  // graph-explorer/spec.md, "An unknown relation still draws": edge_type is
  // open text, so a relation the table has never seen must resolve to the
  // reserved styling rather than throwing or returning undefined.
  it("resolves an unmapped relation to the reserved `unassigned` family without throwing", () => {
    expect(familyKeyForEdgeType("some-future-relation")).toBe("unassigned");
    expect(familyKeyForEdgeType("")).toBe("unassigned");
    expect(() => familyForEdgeType("😀")).not.toThrow();
    expect(familyForEdgeType("😀").key).toBe("unassigned");
  });

  it("`sibling` is deliberately unmapped, so the fallback has a real caller in this store", () => {
    expect(familyKeyForEdgeType("sibling")).toBe("unassigned");
  });

  it("every family is visually distinct from every other — a legend entry that draws like its neighbour names nothing", () => {
    const families = knownEdgeFamilies();
    // A family's appearance is (colour, dash, arrow) taken together: two
    // may share a colour only if their dash or arrow differs, and so on.
    const signatures = families.map((f) => `${f.color}|${f.dash.join(",")}|${f.arrow}`);
    expect(new Set(signatures).size).toBe(families.length);
  });

  it("the unassigned family is distinct from every assigned one, so 'we have no styling for this' never reads as a real relation", () => {
    const unassigned = edgeFamily("unassigned");
    const assigned = knownEdgeFamilies().filter((f) => f.key !== "unassigned");
    for (const f of assigned) {
      expect(`${f.color}|${f.dash.join(",")}`).not.toBe(`${unassigned.color}|${unassigned.dash.join(",")}`);
    }
  });

  it("dash lengths are positive — a zero-length segment renders as an invisible edge", () => {
    for (const f of knownEdgeFamilies()) {
      for (const segment of f.dash) expect(segment).toBeGreaterThan(0);
    }
  });
});

describe("edgeLegendOf", () => {
  it("is empty for an empty graph, so the panel can drop the whole footer", () => {
    expect(edgeLegendOf([])).toEqual(EMPTY_EDGE_LEGEND);
  });

  it("names only the families actually drawn, never the whole table", () => {
    const legend = edgeLegendOf([link({ id: "1", edgeType: "child_of", sourceSystem: "git" }), link({ id: "2", edgeType: "touches", sourceSystem: "git" })]);
    expect(legend.families.map((f) => f.family.key)).toEqual(["containment", "reference"]);
    expect(legend.families).toHaveLength(2); // not 5
  });

  it("orders families by how many edges they account for, most first", () => {
    const links = [
      ...Array.from({ length: 3 }, (_, i) => link({ id: `t${i}`, edgeType: "touches", sourceSystem: "git" })),
      link({ id: "c0", edgeType: "child_of", sourceSystem: "git" }),
    ];
    const legend = edgeLegendOf(links);
    expect(legend.families[0]?.family.key).toBe("reference");
    expect(legend.families[0]?.count).toBe(3);
    expect(legend.families[1]?.family.key).toBe("containment");
  });

  it("breaks a tie on family key, so the legend does not reshuffle between frames", () => {
    const a = edgeLegendOf([link({ id: "1", edgeType: "child_of", sourceSystem: "git" }), link({ id: "2", edgeType: "blocks", sourceSystem: "git" })]);
    const b = edgeLegendOf([link({ id: "2", edgeType: "blocks", sourceSystem: "git" }), link({ id: "1", edgeType: "child_of", sourceSystem: "git" })]);
    expect(a.families.map((f) => f.family.key)).toEqual(b.families.map((f) => f.family.key));
  });

  // graph-explorer/spec.md, "A uniformly structural graph is still
  // apparent": this is what replaced the removed colour-uniformity
  // requirement. One entry in `sourceSystems` IS the uniformity.
  it("reports one source system for a view whose edges all came from one loader", () => {
    const links = Array.from({ length: 57 }, (_, i) => link({ id: `e${i}`, edgeType: "touches", sourceSystem: "git" }));
    const legend = edgeLegendOf(links);
    expect(legend.sourceSystems).toEqual([{ sourceSystem: "git", count: 57 }]);
    expect(legend.total).toBe(57);
  });

  it("reports a mixed view's composition, most edges first", () => {
    const links = [
      ...Array.from({ length: 5 }, (_, i) => link({ id: `g${i}`, edgeType: "touches", sourceSystem: "git" })),
      ...Array.from({ length: 2 }, (_, i) => link({ id: `h${i}`, edgeType: "mentions", sourceSystem: "human" })),
    ];
    expect(edgeLegendOf(links).sourceSystems).toEqual([
      { sourceSystem: "git", count: 5 },
      { sourceSystem: "human", count: 2 },
    ]);
  });

  it("counts an unmapped relation under the unassigned family rather than dropping it from the legend", () => {
    const legend = edgeLegendOf([link({ id: "1", edgeType: "sibling", sourceSystem: "repo" })]);
    expect(legend.families).toEqual([{ family: edgeFamily("unassigned"), count: 1 }]);
    expect(legend.total).toBe(1);
  });
});
