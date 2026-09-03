// Tests for url-addressable-views' parse/format pair — graph-explorer/
// spec.md's "The view is addressable" requirement: the "root path
// redirects" scenario's parameter carry-over, the "malformed parameters
// degrade to defaults" scenario, and the equal-routes-format-equally
// property App.tsx's `navigate` skip depends on.

import { describe, expect, it } from "vitest";
import { formatRoute, GRAPH_VIEW_PATH, graphRouteFromSearch, parseRoute, type GraphRoute } from "./route.js";

function graph(partial: Partial<Omit<GraphRoute, "view">> = {}): GraphRoute {
  return { view: "graph", q: null, types: [], node: null, ...partial };
}

/** `formatRoute` output split back into the two strings `parseRoute` takes — what `location.pathname`/`location.search` would hold after a `pushState` of that URL. */
function split(url: string): [pathname: string, search: string] {
  const i = url.indexOf("?");
  return i === -1 ? [url, ""] : [url.slice(0, i), url.slice(i)];
}

function roundTrip(route: GraphRoute): GraphRoute | null {
  return parseRoute(...split(formatRoute(route)));
}

describe("formatRoute / parseRoute round trip", () => {
  const cases: Array<[string, GraphRoute]> = [
    ["nothing set", graph()],
    ["q only", graph({ q: "spec" })],
    ["types only", graph({ types: ["doc"] })],
    ["node only", graph({ node: "0b8d1e4a-2f5c-4c6e-9a7b-1d2e3f4a5b6c" })],
    ["all three", graph({ q: "spec", types: ["doc"], node: "0b8d1e4a-2f5c-4c6e-9a7b-1d2e3f4a5b6c" })],
    ["multiple types", graph({ q: "spec", types: ["doc", "openspec-spec", "gh-issue"] })],
  ];

  for (const [name, route] of cases) {
    it(`round-trips ${name}`, () => {
      expect(roundTrip(route)).toEqual(route);
    });
  }

  it("keeps spaces, ampersands, and non-ASCII in q", () => {
    const route = graph({ q: "a b & c — ünïcode ?" });
    expect(roundTrip(route)).toEqual(route);
  });

  it("keeps a non-UUID node id (validation is the server's, not the parser's)", () => {
    const route = graph({ node: "not-a-uuid" });
    expect(roundTrip(route)).toEqual(route);
  });

  it("preserves type order", () => {
    const route = graph({ types: ["zeta", "alpha", "mid"] });
    expect(roundTrip(route)?.types).toEqual(["zeta", "alpha", "mid"]);
  });
});

describe("formatRoute", () => {
  it("formats an empty route to exactly the view path", () => {
    expect(formatRoute(graph())).toBe(GRAPH_VIEW_PATH);
  });

  it("emits q, then each type, then node, in that order", () => {
    expect(formatRoute(graph({ q: "spec", types: ["doc", "repo"], node: "n1" }))).toBe("/graph?q=spec&type=doc&type=repo&node=n1");
  });

  it("formats two structurally equal routes to the same string", () => {
    const a = graph({ q: "spec", types: ["doc", "repo"], node: "n1" });
    const b = graph({ q: "spec", types: ["doc", "repo"], node: "n1" });
    expect(formatRoute(a)).toBe(formatRoute(b));
  });
});

describe("parseRoute", () => {
  it("accepts /graph and /graph/ alike", () => {
    expect(parseRoute("/graph", "?q=x")).toEqual(graph({ q: "x" }));
    expect(parseRoute("/graph/", "?q=x")).toEqual(graph({ q: "x" }));
  });

  it("returns null for the root and any unknown path", () => {
    expect(parseRoute("/", "")).toBeNull();
    expect(parseRoute("/", "?q=x")).toBeNull();
    expect(parseRoute("/list", "?q=x")).toBeNull();
    expect(parseRoute("/graph/x", "")).toBeNull();
    expect(parseRoute("/Graph", "")).toBeNull();
  });

  it("still yields an unknown path's parameters through graphRouteFromSearch (the redirect carries them)", () => {
    expect(parseRoute("/list", "?q=x&type=a")).toBeNull();
    expect(graphRouteFromSearch("?q=x&type=a")).toEqual(graph({ q: "x", types: ["a"] }));
  });

  it("parses a node with no q", () => {
    expect(parseRoute("/graph", "?node=x")).toEqual(graph({ node: "x" }));
  });
});

describe("malformed parameters degrade to defaults", () => {
  it("treats an empty or whitespace q as absent", () => {
    expect(graphRouteFromSearch("?q=").q).toBeNull();
    expect(graphRouteFromSearch("?q=%20").q).toBeNull();
  });

  it("treats an empty node as absent", () => {
    expect(graphRouteFromSearch("?node=").node).toBeNull();
  });

  it("drops empty type values", () => {
    expect(graphRouteFromSearch("?type=&type=doc").types).toEqual(["doc"]);
  });

  it("collapses duplicate types keeping the first occurrence", () => {
    expect(graphRouteFromSearch("?type=b&type=a&type=b").types).toEqual(["b", "a"]);
  });

  it("trims q and node", () => {
    expect(graphRouteFromSearch("?q=%20spec%20&node=%20n1%20")).toEqual(graph({ q: "spec", node: "n1" }));
  });

  it("ignores unknown parameters", () => {
    expect(graphRouteFromSearch("?q=x&zoom=3&foo=bar")).toEqual(graph({ q: "x" }));
  });

  it("accepts a search string with or without its leading ?", () => {
    expect(graphRouteFromSearch("q=x")).toEqual(graph({ q: "x" }));
    expect(graphRouteFromSearch("")).toEqual(graph());
  });
});
