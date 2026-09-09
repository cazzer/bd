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

/**
 * A dash pattern's visual character, coarse enough that two patterns
 * sharing it really would look alike on a 1-5px translucent line.
 * "solid", otherwise the segment count paired with the first segment's
 * length bucketed by powers of two — so 1.5px dots and 4px dashes are
 * different shapes, while 9px and 10px dashes would not be.
 */
function dashShape(dash: readonly number[]): string {
  if (dash.length === 0) return "solid";
  return `${dash.length}:${Math.round(Math.log2(dash[0]!))}`;
}

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

  // The lookup tables are plain object literals, so they INHERIT every
  // Object.prototype key. An earlier version used `?? "unassigned"`,
  // which never fired for these — `FAMILY_BY_EDGE_TYPE["constructor"]`
  // is the Object function, not undefined — and `edgeFamily` was then
  // handed a non-key and returned undefined, which threw inside a
  // useMemo during render and took down the whole GraphView subtree.
  //
  // Reachable, not theoretical: `edges.edge_type` is `text NOT NULL`
  // with no CHECK, so an agent can write any of these through
  // `brain_link`. The previous totality test used "", "😀" and an
  // invented word — none of them prototype keys — so it certified a
  // totality the code did not have.
  it.each(["constructor", "toString", "valueOf", "__proto__", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable", "toLocaleString"])(
    "resolves the Object.prototype key %j to `unassigned` rather than inheriting it",
    (key) => {
      expect(familyKeyForEdgeType(key)).toBe("unassigned");
      expect(familyForEdgeType(key)).toBe(edgeFamily("unassigned"));
      expect(edgeLegendOf([link({ id: "1", edgeType: key, sourceSystem: "git" })]).families[0]?.family.key).toBe("unassigned");
    },
  );

  it("`sibling` is deliberately unmapped, so the fallback has a real caller in this store", () => {
    expect(familyKeyForEdgeType("sibling")).toBe("unassigned");
  });

  // The invariant that replaced a string-inequality check on
  // `${color}|${dash}|${arrow}`. That check passed for any table whose
  // colours differed by a single hex digit, so it could not detect the
  // condition its own name claimed — and did not: it shipped green over
  // a table where containment/configuration and reference/unassigned
  // each shared dash AND arrow, leaving two near-identical low-chroma
  // greys as the only separator, composited down to dE00 4.88 and 3.03
  // on the canvas.
  //
  // Stating it as "colour is never the only separator" makes the
  // assertion match the requirement, and removes the need to compute a
  // perceptual colour distance in a unit test at all.
  it("colour is never the only channel separating two families", () => {
    const families = knownEdgeFamilies();
    for (let i = 0; i < families.length; i++) {
      for (let j = i + 1; j < families.length; j++) {
        const a = families[i]!;
        const b = families[j]!;
        const differsInShape = dashShape(a.dash) !== dashShape(b.dash) || a.arrow !== b.arrow;
        expect(differsInShape, `${a.key} and ${b.key} are separated only by colour`).toBe(true);
      }
    }
  });

  // graph-explorer/spec.md, "An unknown relation still draws": the
  // reserved styling has to be distinguishable from EVERY assigned one.
  // It matters most against `reference`, which is the store's most
  // common family (touches + mentions), because an unstyled relation
  // that reads as one more `touches` is worse than one that reads as
  // nothing.
  it("the unassigned family is shape-distinct from every assigned one", () => {
    const unassigned = edgeFamily("unassigned");
    for (const f of knownEdgeFamilies().filter((f) => f.key !== "unassigned")) {
      expect(dashShape(f.dash) !== dashShape(unassigned.dash) || f.arrow !== unassigned.arrow, `${f.key} is not shape-distinct from unassigned`).toBe(true);
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
