// Tests for the search results view's pure half (search-results-view,
// search-results/spec.md): where a result opens, the "Open in graph"
// address, the route a submit names, `find`'s input for a route, filter
// toggles, facet back-fill, and a row's status line.

import { describe, expect, it } from "vitest";
import { formatRoute, type SearchRoute } from "./route.js";
import {
  approximateSearchRoute,
  FACET_PREVIEW_COUNT,
  facetOptions,
  findInputFor,
  isNoSearchableTermsMessage,
  openInGraphLink,
  resultRoute,
  rowStatus,
  searchRouteFor,
  toggleProject,
  toggleType,
  visibleFacetOptions,
  withReviewsOnly,
  type FacetOption,
} from "./searchRow.js";

function search(partial: Partial<Omit<SearchRoute, "view">> = {}): SearchRoute {
  return { view: "search", q: null, types: [], projects: [], reviewsOnly: false, ...partial };
}

describe("resultRoute", () => {
  it("opens a review work item with a project in its board drawer, keyed by the bead id", () => {
    const route = resultRoute({ id: "n1", nodeType: "work_item", externalId: "collective-sx4.20.10.1", project: "collective", isReview: true });
    expect(formatRoute(route)).toBe("/board?project=collective&item=collective-sx4.20.10.1");
  });

  it("opens a review without a project in the graph", () => {
    expect(formatRoute(resultRoute({ id: "n2", nodeType: "work_item", externalId: "owner/repo#4", project: null, isReview: true }))).toBe("/graph?node=n2");
  });

  it("opens a review-labelled node that is not a work item in the graph, even with a project", () => {
    expect(formatRoute(resultRoute({ id: "n5", nodeType: "gh-issue", externalId: "owner/repo#7", project: "collective", isReview: true }))).toBe("/graph?node=n5");
  });

  it("opens anything else, a gh-pr included, in the graph with it selected", () => {
    expect(formatRoute(resultRoute({ id: "n3", nodeType: "gh-pr", externalId: "owner/repo#12", project: null, isReview: false }))).toBe("/graph?node=n3");
    expect(formatRoute(resultRoute({ id: "n4", nodeType: "work_item", externalId: "bd-1", project: "bd", isReview: false }))).toBe("/graph?node=n4");
  });
});

describe("openInGraphLink", () => {
  it("carries the text and chosen types, and says so when projects or reviews only stay behind", () => {
    const link = openInGraphLink(search({ q: "cuts", types: ["work_item", "gh-pr"], projects: ["p"], reviewsOnly: true }));
    expect(link.route).toEqual({ view: "graph", q: "cuts", types: ["work_item", "gh-pr"], node: null });
    expect(formatRoute(link.route)).toBe("/graph?q=cuts&type=work_item&type=gh-pr");
    expect(link.label).toBe("Open in graph (text and types only)");
    expect(openInGraphLink(search({ q: "cuts", reviewsOnly: true })).label).toBe("Open in graph (text and types only)");
    expect(openInGraphLink(search({ q: "cuts", types: ["a"] })).label).toBe("Open in graph");
  });

  it("opens the bare graph with no text", () => {
    const link = openInGraphLink(search({ types: ["a"], projects: ["p"] }));
    expect(formatRoute(link.route)).toBe("/graph");
    expect(link.label).toBe("Open the graph");
  });
});

describe("approximateSearchRoute", () => {
  it("is the graph's search for the text alone, or null with no text", () => {
    expect(formatRoute(approximateSearchRoute(search({ q: "cuts", types: ["a"], projects: ["p"] }))!)).toBe("/graph?q=cuts");
    expect(approximateSearchRoute(search())).toBeNull();
  });
});

describe("visibleFacetOptions", () => {
  const options: FacetOption[] = Array.from({ length: 12 }, (_, i) => ({ value: `v${i}`, count: 12 - i, chosen: i === 10 }));

  it("shows the first few plus any chosen option past them, in order", () => {
    const shown = visibleFacetOptions(options, false).map((o) => o.value);
    expect(shown).toEqual([...Array.from({ length: FACET_PREVIEW_COUNT }, (_, i) => `v${i}`), "v10"]);
  });

  it("shows every option when asked", () => {
    expect(visibleFacetOptions(options, true)).toHaveLength(12);
  });
});

describe("isNoSearchableTermsMessage", () => {
  it("recognises the server's stopword-only refusal and nothing else", () => {
    expect(isNoSearchableTermsMessage('query text "the" contains no searchable terms Provide at least one meaningful search term')).toBe(true);
    expect(isNoSearchableTermsMessage("invalid list option limit (got 0): must be an integer")).toBe(false);
  });
});

describe("searchRouteFor", () => {
  it("trims the text and defaults the filters", () => {
    expect(searchRouteFor("  island cuts ")).toEqual(search({ q: "island cuts" }));
  });

  it("reads whitespace-only as no text", () => {
    expect(searchRouteFor("   ")).toEqual(search());
    expect(formatRoute(searchRouteFor(""))).toBe("/search");
  });

  it("carries the filters given", () => {
    expect(searchRouteFor("x", { types: ["a"] })).toEqual(search({ q: "x", types: ["a"] }));
    expect(searchRouteFor("", { types: ["a"], projects: ["p"], reviewsOnly: true })).toEqual(search({ types: ["a"], projects: ["p"], reviewsOnly: true }));
  });
});

describe("filter toggles", () => {
  it("add a value at the end and remove it again, keeping the others' order", () => {
    const start = search({ q: "x", types: ["a", "b"] });
    const added = toggleType(start, "c");
    expect(added.types).toEqual(["a", "b", "c"]);
    expect(toggleType(added, "a").types).toEqual(["b", "c"]);
    expect(toggleProject(search({ projects: ["p"] }), "q").projects).toEqual(["p", "q"]);
    expect(toggleProject(search({ projects: ["p", "q"] }), "p").projects).toEqual(["q"]);
  });

  it("never mutate the route they are given", () => {
    const start = search({ types: ["a"], projects: ["p"] });
    const snapshot = structuredClone(start);
    toggleType(start, "b");
    toggleType(start, "a");
    toggleProject(start, "q");
    withReviewsOnly(start, true);
    expect(start).toEqual(snapshot);
  });

  it("set reviews only on and off, leaving the rest", () => {
    const on = withReviewsOnly(search({ q: "x", projects: ["p"] }), true);
    expect(on).toEqual(search({ q: "x", projects: ["p"], reviewsOnly: true }));
    expect(withReviewsOnly(on, false)).toEqual(search({ q: "x", projects: ["p"] }));
  });
});

describe("findInputFor", () => {
  it("sends empty filter lists as absent and leaves out text and reviews only when unset", () => {
    const input = findInputFor(search(), 0, 50);
    expect(input).toEqual({ nodeTypes: undefined, projects: undefined, limit: 50, offset: 0 });
    expect("text" in input).toBe(false);
    expect("reviewsOnly" in input).toBe(false);
  });

  it("sends every set field and the offset given", () => {
    expect(findInputFor(search({ q: "cuts", types: ["a"], projects: ["p", "q"], reviewsOnly: true }), 50, 50)).toEqual({
      text: "cuts",
      nodeTypes: ["a"],
      projects: ["p", "q"],
      reviewsOnly: true,
      limit: 50,
      offset: 50,
    });
  });
});

describe("facetOptions", () => {
  it("keeps the server's order and marks the chosen values", () => {
    expect(
      facetOptions(
        [
          { value: "b", count: 2 },
          { value: "a", count: 9 },
        ],
        ["b"],
      ),
    ).toEqual([
      { value: "b", count: 2, chosen: true },
      { value: "a", count: 9, chosen: false },
    ]);
  });

  it("back-fills a chosen value the server left out at 0, after the server's", () => {
    expect(facetOptions([{ value: "a", count: 3 }], ["gone", "a"])).toEqual([
      { value: "a", count: 3, chosen: true },
      { value: "gone", count: 0, chosen: true },
    ]);
    expect(facetOptions([], ["x"])).toEqual([{ value: "x", count: 0, chosen: true }]);
  });
});

describe("rowStatus", () => {
  it("prefers the closed date when closedAt is a readable time", () => {
    expect(rowStatus({ status: "closed", closedAt: "2026-03-04T08:00:00.000Z" })).toBe("closed 2026-03-04");
  });

  it("falls back to the status, then to null", () => {
    expect(rowStatus({ status: "open", closedAt: null })).toBe("open");
    expect(rowStatus({ status: "closed", closedAt: "not a time" })).toBe("closed");
    expect(rowStatus({ status: null, closedAt: null })).toBeNull();
  });
});
