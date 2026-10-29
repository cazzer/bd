// Tests for url-addressable-views' parse/format pair — graph-explorer/
// spec.md's "The view is addressable" requirement: the "root path
// redirects" scenario's parameter carry-over, the "malformed parameters
// degrade to defaults" scenario, and the equal-routes-format-equally
// property lib/navigate.ts's skip depends on — plus, node-views, the feed
// member of the union: node-views/spec.md's "The feed view is
// addressable" requirement ("Feed with no view" parses rather than
// redirects; "Unknown path still redirects" carries the graph's
// parameters and nothing else).

import { describe, expect, it } from "vitest";
import { BOARD_VIEW_PATH, CODE_VIEW_PATH, FEED_VIEW_PATH, formatRoute, GRAPH_VIEW_PATH, graphRouteFromSearch, parseRoute, TIMELINE_VIEW_PATH, type BoardRoute, type CodeRoute, type FeedRoute, type GraphRoute, type Route, type TimelineRoute } from "./route.js";

function graph(partial: Partial<Omit<GraphRoute, "view">> = {}): GraphRoute {
  return { view: "graph", q: null, types: [], node: null, ...partial };
}

function feed(viewId: string | null = null): FeedRoute {
  return { view: "feed", viewId };
}

function code(viewId: string | null = null, node: string | null = null): CodeRoute {
  return { view: "code", viewId, node };
}

function timeline(viewId: string | null = null, node: string | null = null, types: string[] = []): TimelineRoute {
  return { view: "timeline", viewId, node, types };
}

function board(viewId: string | null = null, projects: string[] = [], item: string | null = null): BoardRoute {
  return { view: "board", viewId, projects, item };
}

/** `formatRoute` output split back into the two strings `parseRoute` takes — what `location.pathname`/`location.search` would hold after a `pushState` of that URL. */
function split(url: string): [pathname: string, search: string] {
  const i = url.indexOf("?");
  return i === -1 ? [url, ""] : [url.slice(0, i), url.slice(i)];
}

/** Parse of the format of `route`. The cast only narrows the union back to the member that went in — every use also asserts `toEqual(route)`, which is what actually checks the member came back. */
function roundTrip<R extends Route>(route: R): R | null {
  return parseRoute(...split(formatRoute(route))) as R | null;
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

describe("feed route (node-views)", () => {
  const VIEW_ID = "0b8d1e4a-2f5c-4c6e-9a7b-1d2e3f4a5b6c";

  it("round-trips a view id", () => {
    expect(roundTrip(feed(VIEW_ID))).toEqual(feed(VIEW_ID));
  });

  it("round-trips no view id", () => {
    expect(roundTrip(feed())).toEqual(feed());
  });

  it("formats an empty feed route to exactly the view path", () => {
    expect(formatRoute(feed())).toBe(FEED_VIEW_PATH);
  });

  it("formats the view id as the only parameter", () => {
    expect(formatRoute(feed("v1"))).toBe("/feed?view=v1");
  });

  it("formats two structurally equal feed routes to the same string", () => {
    expect(formatRoute(feed(VIEW_ID))).toBe(formatRoute(feed(VIEW_ID)));
  });

  it("accepts /feed and /feed/ alike", () => {
    expect(parseRoute("/feed", "?view=v1")).toEqual(feed("v1"));
    expect(parseRoute("/feed/", "?view=v1")).toEqual(feed("v1"));
  });

  it("returns null for /feed/x and /Feed (unknown paths, same as the graph's)", () => {
    expect(parseRoute("/feed/x", "?view=v1")).toBeNull();
    expect(parseRoute("/Feed", "?view=v1")).toBeNull();
  });

  it("parses a bare /feed, or an empty or whitespace view, as no view — never a redirect", () => {
    expect(parseRoute("/feed", "")).toEqual(feed());
    expect(parseRoute("/feed", "?view=")).toEqual(feed());
    expect(parseRoute("/feed", "?view=%20")).toEqual(feed());
  });

  it("trims the view id", () => {
    expect(parseRoute("/feed", "?view=%20v1%20")).toEqual(feed("v1"));
  });

  it("keeps a non-UUID view id (validation is the server's, not the parser's)", () => {
    expect(parseRoute("/feed", "?view=abc")).toEqual(feed("abc"));
    expect(roundTrip(feed("abc"))).toEqual(feed("abc"));
  });

  it("ignores graph and unknown parameters on the feed path", () => {
    expect(parseRoute("/feed", "?q=x&type=a&node=n1&view=v1&zoom=3")).toEqual(feed("v1"));
  });

  it("keeps a graph address a graph address when it carries a view parameter", () => {
    expect(parseRoute("/graph", "?q=x&view=v1")).toEqual(graph({ q: "x" }));
  });

  it("still redirects /list, carrying the graph parameters and dropping view (the 'Unknown path still redirects' scenario)", () => {
    expect(parseRoute("/list", "?q=x&type=a&view=v1")).toBeNull();
    expect(formatRoute(graphRouteFromSearch("?q=x&type=a&view=v1"))).toBe("/graph?q=x&type=a");
  });
});

// code-view/spec.md, "The code view is addressable" (design.md decision 2):
// the code member of the union — `view` and `node`, each optional.
describe("code route (code-view)", () => {
  const VIEW_ID = "0b8d1e4a-2f5c-4c6e-9a7b-1d2e3f4a5b6c";
  const NODE_ID = "9f1c2b3a-4d5e-4f60-8a71-0b2c3d4e5f60";

  const cases: Array<[string, CodeRoute]> = [
    ["nothing set", code()],
    ["view only", code(VIEW_ID)],
    ["node only", code(null, NODE_ID)],
    ["view and node", code(VIEW_ID, NODE_ID)],
  ];

  for (const [name, route] of cases) {
    it(`round-trips ${name}`, () => {
      expect(roundTrip(route)).toEqual(route);
    });
  }

  it("formats an empty code route to exactly the view path", () => {
    expect(formatRoute(code())).toBe(CODE_VIEW_PATH);
  });

  it("emits view then node, omitting an absent one", () => {
    expect(formatRoute(code("v1", "n1"))).toBe("/code?view=v1&node=n1");
    expect(formatRoute(code("v1"))).toBe("/code?view=v1");
    expect(formatRoute(code(null, "n1"))).toBe("/code?node=n1");
  });

  it("formats two structurally equal code routes to the same string", () => {
    expect(formatRoute(code(VIEW_ID, NODE_ID))).toBe(formatRoute(code(VIEW_ID, NODE_ID)));
  });

  it("accepts /code and /code/ alike", () => {
    expect(parseRoute("/code", "?view=v1&node=n1")).toEqual(code("v1", "n1"));
    expect(parseRoute("/code/", "?view=v1&node=n1")).toEqual(code("v1", "n1"));
  });

  it("returns null for /code/x and /Code (unknown paths, same as the graph's and the feed's)", () => {
    expect(parseRoute("/code/x", "?view=v1")).toBeNull();
    expect(parseRoute("/Code", "?view=v1")).toBeNull();
  });

  it("parses a bare /code, or an empty or whitespace view or node, as absent — never a redirect", () => {
    expect(parseRoute("/code", "")).toEqual(code());
    expect(parseRoute("/code", "?view=")).toEqual(code());
    expect(parseRoute("/code", "?view=%20")).toEqual(code());
    expect(parseRoute("/code", "?view=v1&node=")).toEqual(code("v1"));
    expect(parseRoute("/code", "?view=v1&node=%20")).toEqual(code("v1"));
    expect(parseRoute("/code", "?node=n1")).toEqual(code(null, "n1"));
  });

  it("trims the view and node ids", () => {
    expect(parseRoute("/code", "?view=%20v1%20&node=%20n1%20")).toEqual(code("v1", "n1"));
  });

  it("keeps non-UUID view and node ids (validation is the server's, not the parser's)", () => {
    expect(parseRoute("/code", "?view=abc&node=xyz")).toEqual(code("abc", "xyz"));
    expect(roundTrip(code("abc", "xyz"))).toEqual(code("abc", "xyz"));
  });

  it("ignores graph and unknown parameters on the code path", () => {
    expect(parseRoute("/code", "?q=x&type=a&view=v1&node=n1&zoom=3")).toEqual(code("v1", "n1"));
  });

  it("keeps a graph address a graph address when it carries a view parameter beside its node", () => {
    expect(parseRoute("/graph", "?q=x&view=v1&node=n1")).toEqual(graph({ q: "x", node: "n1" }));
  });

  it("still redirects /list, carrying the graph parameters and dropping view (the 'Unknown path still redirects' scenario)", () => {
    expect(parseRoute("/list", "?q=x&view=v1&node=n1")).toBeNull();
    expect(formatRoute(graphRouteFromSearch("?q=x&view=v1&node=n1"))).toBe("/graph?q=x&node=n1");
  });
});

// timeline-view/spec.md, "The timeline view is addressable" (design.md
// decision 4): the timeline member of the union — `view`, `node`, and
// repeated `type`, each optional; `type` parsed by the graph's own rule.
describe("timeline route (timeline-view)", () => {
  const VIEW_ID = "0b8d1e4a-2f5c-4c6e-9a7b-1d2e3f4a5b6c";
  const NODE_ID = "9f1c2b3a-4d5e-4f60-8a71-0b2c3d4e5f60";

  const cases: Array<[string, TimelineRoute]> = [
    ["nothing set", timeline()],
    ["view only", timeline(VIEW_ID)],
    ["node only", timeline(null, NODE_ID)],
    ["types only", timeline(null, null, ["gh-issue"])],
    ["view and node", timeline(VIEW_ID, NODE_ID)],
    ["view and types", timeline(VIEW_ID, null, ["gh-issue", "work_item"])],
    ["node and types", timeline(null, NODE_ID, ["work_item"])],
    ["all three", timeline(VIEW_ID, NODE_ID, ["gh-issue", "work_item"])],
  ];

  for (const [name, route] of cases) {
    it(`round-trips ${name}`, () => {
      expect(roundTrip(route)).toEqual(route);
    });
  }

  it("preserves type order", () => {
    expect(roundTrip(timeline(VIEW_ID, NODE_ID, ["zeta", "alpha", "mid"]))?.types).toEqual(["zeta", "alpha", "mid"]);
  });

  it("formats an empty timeline route to exactly the view path", () => {
    expect(formatRoute(timeline())).toBe(TIMELINE_VIEW_PATH);
  });

  it("emits view, node, then each type, omitting absent ones", () => {
    expect(formatRoute(timeline("v1", "n1", ["a", "b"]))).toBe("/timeline?view=v1&node=n1&type=a&type=b");
    expect(formatRoute(timeline("v1", "n1"))).toBe("/timeline?view=v1&node=n1");
    expect(formatRoute(timeline("v1"))).toBe("/timeline?view=v1");
    expect(formatRoute(timeline(null, "n1"))).toBe("/timeline?node=n1");
    expect(formatRoute(timeline(null, null, ["a"]))).toBe("/timeline?type=a");
    expect(formatRoute(timeline("v1", null, ["a"]))).toBe("/timeline?view=v1&type=a");
  });

  it("formats two structurally equal timeline routes to the same string", () => {
    expect(formatRoute(timeline(VIEW_ID, NODE_ID, ["a", "b"]))).toBe(formatRoute(timeline(VIEW_ID, NODE_ID, ["a", "b"])));
  });

  it("accepts /timeline and /timeline/ alike", () => {
    expect(parseRoute("/timeline", "?view=v1&node=n1&type=a")).toEqual(timeline("v1", "n1", ["a"]));
    expect(parseRoute("/timeline/", "?view=v1&node=n1&type=a")).toEqual(timeline("v1", "n1", ["a"]));
  });

  it("returns null for /timeline/x and /Timeline (unknown paths, same as the other views')", () => {
    expect(parseRoute("/timeline/x", "?view=v1")).toBeNull();
    expect(parseRoute("/Timeline", "?view=v1")).toBeNull();
  });

  it("parses a bare /timeline, or an empty or whitespace view or node, as absent — never a redirect", () => {
    expect(parseRoute("/timeline", "")).toEqual(timeline());
    expect(parseRoute("/timeline", "?view=")).toEqual(timeline());
    expect(parseRoute("/timeline", "?view=%20")).toEqual(timeline());
    expect(parseRoute("/timeline", "?view=v1&node=")).toEqual(timeline("v1"));
    expect(parseRoute("/timeline", "?view=v1&node=%20")).toEqual(timeline("v1"));
    expect(parseRoute("/timeline", "?node=n1")).toEqual(timeline(null, "n1"));
  });

  it("trims the view and node ids", () => {
    expect(parseRoute("/timeline", "?view=%20v1%20&node=%20n1%20")).toEqual(timeline("v1", "n1"));
  });

  it("handles type values as the graph does: empties dropped, duplicates collapsed to the first occurrence, values trimmed", () => {
    expect(parseRoute("/timeline", "?view=v1&type=&type=doc")).toEqual(timeline("v1", null, ["doc"]));
    expect(parseRoute("/timeline", "?view=v1&type=b&type=a&type=b")).toEqual(timeline("v1", null, ["b", "a"]));
    expect(parseRoute("/timeline", "?view=v1&type=%20a%20")).toEqual(timeline("v1", null, ["a"]));
    expect(parseRoute("/timeline", "?view=v1&type=%20")).toEqual(timeline("v1"));
  });

  it("keeps non-UUID view and node ids (validation is the server's, not the parser's)", () => {
    expect(parseRoute("/timeline", "?view=abc&node=xyz")).toEqual(timeline("abc", "xyz"));
    expect(roundTrip(timeline("abc", "xyz"))).toEqual(timeline("abc", "xyz"));
  });

  it("ignores graph and unknown parameters on the timeline path", () => {
    expect(parseRoute("/timeline", "?q=x&view=v1&node=n1&type=a&zoom=3&foo=bar")).toEqual(timeline("v1", "n1", ["a"]));
  });

  it("keeps a graph address a graph address when it carries a view parameter beside its node and types", () => {
    expect(parseRoute("/graph", "?q=x&view=v1&node=n1&type=a")).toEqual(graph({ q: "x", node: "n1", types: ["a"] }));
  });

  it("still redirects /list, carrying the graph parameters and dropping view (the 'Unknown path still redirects' scenario)", () => {
    expect(parseRoute("/list", "?q=x&view=v1&node=n1&type=a")).toBeNull();
    expect(formatRoute(graphRouteFromSearch("?q=x&view=v1&node=n1&type=a"))).toBe("/graph?q=x&type=a&node=n1");
  });
});

describe("board route", () => {
  it("parses /board with its view and projects, in order", () => {
    expect(parseRoute("/board", "?view=v1&project=tides&project=bd")).toEqual(board("v1", ["tides", "bd"]));
    expect(parseRoute("/board/", "?view=v1")).toEqual(board("v1"));
    expect(BOARD_VIEW_PATH).toBe("/board");
  });

  it("degrades malformed parameters: empty and duplicate projects dropped, trimmed, whitespace view is null", () => {
    expect(parseRoute("/board", "?view=%20&project=&project=%20a%20&project=a&project=b")).toEqual(board(null, ["a", "b"]));
    expect(parseRoute("/board", "")).toEqual(board());
  });

  it("formats with a stable parameter order: view, then each project", () => {
    expect(formatRoute(board("v1", ["b", "a"]))).toBe("/board?view=v1&project=b&project=a");
    expect(formatRoute(board())).toBe("/board");
    expect(formatRoute(board(null, ["a"]))).toBe("/board?project=a");
  });

  it("round-trips", () => {
    for (const r of [board(), board("v1"), board(null, ["a"]), board("v1", ["tides", "strides", "sky.os"])]) {
      expect(roundTrip(r)).toEqual(r);
    }
  });

  it("ignores graph and unknown parameters, and /board/x is unknown", () => {
    expect(parseRoute("/board", "?q=x&node=n&type=t&view=v1&project=a&zoom=1")).toEqual(board("v1", ["a"]));
    expect(parseRoute("/board/x", "")).toBeNull();
  });

  it("parses item trimmed, empty or whitespace-only as null", () => {
    expect(parseRoute("/board", "?item=%20bd-ker.3%20")).toEqual(board(null, [], "bd-ker.3"));
    expect(parseRoute("/board", "?item=")).toEqual(board());
    expect(parseRoute("/board", "?item=%20%20")).toEqual(board());
  });

  it("reads the CLI's deep link with no view as every project's board with the drawer open", () => {
    expect(parseRoute("/board", "?project=tides&item=tides-r1")).toEqual({ view: "board", viewId: null, projects: ["tides"], item: "tides-r1" });
  });

  it("formats item last, after view and every project, and omits it when null", () => {
    expect(formatRoute(board("v1", ["b", "a"], "bd-1"))).toBe("/board?view=v1&project=b&project=a&item=bd-1");
    expect(formatRoute(board(null, [], "bd-1"))).toBe("/board?item=bd-1");
    expect(formatRoute(board("v1", ["a"], null))).toBe("/board?view=v1&project=a");
  });

  it("round-trips with an item, including characters that need escaping", () => {
    for (const r of [board(null, [], "bd-1"), board("v1", ["tides"], "tides-r1"), board(null, ["a"], "x y&z=#?")]) {
      expect(roundTrip(r)).toEqual(r);
    }
  });
});
