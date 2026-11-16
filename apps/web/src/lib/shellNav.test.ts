// The shell header's links and switcher (shared-nav-header tasks.md 1.1-1.3;
// app-navigation spec "Every view shares one header", "The chosen project
// follows the reader").

import { describe, expect, it } from "vitest";
import { formatRoute, parseRoute, type BoardRoute, type Route } from "./route.js";
import { boardViewProjects, carriedProjects, currentPlace, currentSavedViewId, headerSwitcherOffer, isProjectScoped, navLinks, unfilteredHint, type ShellProjects, type ShellView } from "./shellNav.js";

function parsed(url: string): Route {
  const i = url.indexOf("?");
  const route = i === -1 ? parseRoute(url, "") : parseRoute(url.slice(0, i), url.slice(i));
  if (route === null) throw new Error(`not a route: ${url}`);
  return route;
}

function hrefs(route: Route, carried: readonly string[]): Record<string, string> {
  return Object.fromEntries(navLinks(route, carried).map((l) => [l.label, formatRoute(l.route)]));
}

const SHELL: ShellProjects = { registry: ["skyos", "tides", "strides"], registryFailed: false, view: null };

function boardView(viewId: string, projects: string[] | null, renderer = "board"): ShellView {
  return { viewId, title: "A board", renderer, projects };
}

describe("navLinks", () => {
  it("lists Graph, Board, Roadmap, Inbox, Search in order, marking the current view", () => {
    const links = navLinks(parsed("/inbox"), []);
    expect(links.map((l) => l.label)).toEqual(["Graph", "Board", "Roadmap", "Inbox", "Search"]);
    expect(links.filter((l) => l.current).map((l) => l.id)).toEqual(["inbox"]);
  });

  it("marks none on a saved view — feed, code, timeline, or a board drawn from one — whose Board link is the plain board", () => {
    for (const url of ["/feed?view=v1", "/code?view=v1", "/timeline?view=v1", "/board?view=v1&project=tides"]) {
      expect(navLinks(parsed(url), []).some((l) => l.current)).toBe(false);
    }
    expect(formatRoute(navLinks(parsed("/board?view=v1&project=tides"), ["tides"]).find((l) => l.id === "board")!.route)).toBe("/board?project=tides");
    expect(navLinks(parsed("/board?project=tides"), ["tides"]).find((l) => l.id === "board")!.current).toBe(true);
  });

  it("opens each view's home carrying the projects (Project survives a detour)", () => {
    expect(hrefs(parsed("/board?project=tides&item=tides-r1"), ["tides"])).toEqual({
      Graph: "/graph?project=tides",
      Board: "/board?project=tides&item=tides-r1",
      Roadmap: "/roadmap?project=tides",
      Inbox: "/inbox?project=tides",
      Search: "/search?project=tides",
    });
    const graph = parsed("/graph?project=tides");
    expect(formatRoute(navLinks(graph, carriedProjects(graph, null)).find((l) => l.id === "roadmap")!.route)).toBe("/roadmap?project=tides");
  });

  it("links the current view to its own address, so activating it changes nothing", () => {
    const route = parsed("/graph?q=spec&node=n1&project=tides");
    expect(navLinks(route, ["tides"]).find((l) => l.id === "graph")!.route).toBe(route);
  });

  it("builds the Board link from a shared timeline link (Shared link)", () => {
    const route = parsed("/timeline?view=v1&project=tides");
    expect(hrefs(route, carriedProjects(route, null)).Board).toBe("/board?project=tides");
  });
});

describe("carriedProjects", () => {
  const viewBoard: BoardRoute = { view: "board", viewId: "v1", projects: [], item: null };

  it("is the address's projects", () => {
    expect(carriedProjects(parsed("/inbox?project=a&project=b"), null)).toEqual(["a", "b"]);
    expect(carriedProjects(parsed("/graph"), null)).toEqual([]);
  });

  it("is a saved board view's projects while the address names none", () => {
    expect(carriedProjects(viewBoard, ["tides", "skyos"])).toEqual(["tides", "skyos"]);
    expect(carriedProjects({ ...viewBoard, projects: ["skyos"] }, ["tides", "skyos"])).toEqual(["skyos"]);
    expect(carriedProjects(viewBoard, null)).toEqual([]);
    expect(carriedProjects({ ...viewBoard, viewId: null }, ["tides"])).toEqual([]);
  });
});

describe("the switcher's hint", () => {
  it("says so on every view the project does not filter, and nothing where it does", () => {
    for (const view of ["graph", "feed", "code", "timeline", "inbox"] as const) {
      expect(isProjectScoped(view)).toBe(false);
      expect(unfilteredHint(view)).toMatch(/isn't filtered by project\.$/);
    }
    expect(unfilteredHint("inbox")).toBe("The inbox isn't filtered by project.");
    for (const view of ["board", "roadmap", "search"] as const) {
      expect(isProjectScoped(view)).toBe(true);
      expect(unfilteredHint(view)).toBeNull();
    }
  });
});

describe("headerSwitcherOffer", () => {
  it("offers every registered project off a saved board view", () => {
    expect(headerSwitcherOffer(parsed("/inbox"), SHELL)).toEqual({ offered: ["skyos", "tides", "strides"], fallback: false });
    expect(headerSwitcherOffer(parsed("/board"), SHELL)).toEqual({ offered: ["skyos", "tides", "strides"], fallback: false });
  });

  it("falls back to the address's projects when the registry cannot be read", () => {
    expect(headerSwitcherOffer(parsed("/graph?project=tides"), { registry: null, registryFailed: true, view: null })).toEqual({ offered: ["tides"], fallback: true });
  });

  it("is unknown until the registry is read", () => {
    expect(headerSwitcherOffer(parsed("/graph"), { registry: null, registryFailed: false, view: null })).toEqual({ offered: null, fallback: false });
  });

  it("offers a saved board view's own projects, unknown until that view is read", () => {
    const route = parsed("/board?view=v1");
    expect(headerSwitcherOffer(route, SHELL)).toEqual({ offered: null, fallback: false });
    expect(headerSwitcherOffer(route, { ...SHELL, view: boardView("v0", ["x"]) })).toEqual({ offered: null, fallback: false });
    expect(headerSwitcherOffer(route, { ...SHELL, view: boardView("v1", ["tides", "skyos"]) })).toEqual({ offered: ["tides", "skyos"], fallback: false });
    expect(headerSwitcherOffer(route, { ...SHELL, view: boardView("v1", null) })).toEqual({ offered: ["skyos", "tides", "strides"], fallback: false });
    // A view id naming a non-board view (or no view): the registry, as the board falls back.
    expect(headerSwitcherOffer(route, { ...SHELL, view: boardView("v1", ["tides"], "feed") })).toEqual({ offered: ["skyos", "tides", "strides"], fallback: false });
  });

  it("reads a board view's projects only for that board", () => {
    expect(boardViewProjects(parsed("/board?view=v1"), { ...SHELL, view: boardView("v1", ["tides"]) })).toEqual(["tides"]);
    expect(boardViewProjects(parsed("/feed?view=v1"), { ...SHELL, view: boardView("v1", ["tides"]) })).toBeNull();
    expect(boardViewProjects(parsed("/board?view=v2"), { ...SHELL, view: boardView("v1", ["tides"]) })).toBeNull();
  });
});

describe("currentSavedViewId and currentPlace", () => {
  it("names the saved view a route draws", () => {
    expect(currentSavedViewId(parsed("/timeline?view=v1"))).toBe("v1");
    expect(currentSavedViewId(parsed("/board?view=v1"))).toBe("v1");
    expect(currentSavedViewId(parsed("/board"))).toBeNull();
    expect(currentSavedViewId(parsed("/inbox"))).toBeNull();
  });

  it("is the current nav label, else the saved view's title, else its renderer", () => {
    expect(currentPlace(parsed("/roadmap"), null)).toBe("Roadmap");
    expect(currentPlace(parsed("/board"), null)).toBe("Board");
    expect(currentPlace(parsed("/timeline?view=v1"), "Shipping log")).toBe("Shipping log");
    expect(currentPlace(parsed("/timeline?view=v1"), null)).toBe("Timeline");
    expect(currentPlace(parsed("/feed"), null)).toBe("Feed");
    expect(currentPlace(parsed("/board?view=v1"), "  ")).toBe("Board");
  });
});
