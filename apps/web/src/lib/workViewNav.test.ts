// The project switcher's routes (roadmap-milestones tasks.md 3.2-3.3;
// work-board spec "Switching project", "Back to all projects", "Old
// multi-project link"); "Board to roadmap" is the header's nav links now
// (lib/shellNav.test.ts).

import { describe, expect, it } from "vitest";
import { PROJECT_KEY_PATTERN } from "./boardRow.js";
import { formatRoute, parseRoute, type BoardRoute, type GraphRoute, type InboxRoute, type RoadmapRoute, type SearchRoute } from "./route.js";
import { ALL_PROJECTS_CHOICE, chooseProject, SEVERAL_PROJECTS_VALUE, switcherOffer, switcherState, viewCarriedProjects } from "./workViewNav.js";

const OFFERED = ["skyos", "tides", "strides"];

function board(projects: string[] = [], over: Partial<BoardRoute> = {}): BoardRoute {
  return { view: "board", viewId: null, projects, item: null, ...over };
}

describe("switcherState", () => {
  it("reads All projects for an empty, stale, or every-project address", () => {
    const all = { label: "All projects", value: ALL_PROJECTS_CHOICE, title: null };
    expect(switcherState(OFFERED, [])).toEqual(all);
    expect(switcherState(OFFERED, ["gone"])).toEqual(all);
    expect(switcherState(OFFERED, ["strides", "skyos", "tides"])).toEqual(all);
  });

  it("reads the one chosen key", () => {
    expect(switcherState(OFFERED, ["tides"])).toEqual({ label: "tides", value: "tides", title: null });
    expect(switcherState(OFFERED, ["gone", "tides"])).toEqual({ label: "tides", value: "tides", title: null });
  });

  it("names two or three chosen projects (the old multi-project link), in offered order", () => {
    expect(switcherState(OFFERED, ["strides", "tides"])).toEqual({ label: "tides + strides", value: SEVERAL_PROJECTS_VALUE, title: null });
    const five = ["a", "b", "c", "d", "e"];
    expect(switcherState(five, ["a", "b", "c"]).label).toBe("a + b + c");
  });

  it("counts more than three, naming them in the title", () => {
    const five = ["a", "b", "c", "d", "e"];
    expect(switcherState(five, ["d", "a", "b", "c"])).toEqual({ label: "4 projects", value: SEVERAL_PROJECTS_VALUE, title: "a, b, c, d" });
  });

  it("reads the address alone while the offered projects load", () => {
    expect(switcherState(null, [])).toEqual({ label: "All projects", value: ALL_PROJECTS_CHOICE, title: null });
    expect(switcherState(null, ["rmf"])).toEqual({ label: "rmf", value: "rmf", title: null });
    expect(switcherState(null, ["rmf", "rmb"]).label).toBe("rmf + rmb");
  });

  it("never collides with a project key", () => {
    expect(PROJECT_KEY_PATTERN.test(SEVERAL_PROJECTS_VALUE)).toBe(false);
    expect(PROJECT_KEY_PATTERN.test(ALL_PROJECTS_CHOICE)).toBe(false);
  });
});

describe("chooseProject", () => {
  it("replaces the address's projects with the chosen key, and a reload reads it back", () => {
    const next = chooseProject(board(), OFFERED, "skyos");
    expect(formatRoute(next)).toBe("/board?project=skyos");
    const url = formatRoute(next);
    const reread = parseRoute("/board", url.slice(url.indexOf("?")));
    expect(reread).toEqual(next);
    expect(switcherState(OFFERED, (reread as BoardRoute).projects).label).toBe("skyos");
  });

  it("drops project for All projects", () => {
    expect(formatRoute(chooseProject(board(["skyos"]), OFFERED, ALL_PROJECTS_CHOICE))).toBe("/board");
  });

  it("replaces several projects with the one chosen", () => {
    expect(chooseProject(board(["tides", "strides"]), OFFERED, "tides").projects).toEqual(["tides"]);
  });

  it("keeps the view and drops the open item", () => {
    expect(chooseProject(board(["tides"], { viewId: "v1", item: "tides-r1" }), OFFERED, "skyos")).toEqual(board(["skyos"], { viewId: "v1", item: null }));
    expect(formatRoute(chooseProject(board(["tides"], { item: "tides-r1" }), OFFERED, ALL_PROJECTS_CHOICE))).toBe("/board");
  });

  it("spells every-project as no project: an unoffered key or the only offered one", () => {
    expect(chooseProject(board(["tides"]), OFFERED, "nope").projects).toEqual([]);
    expect(chooseProject(board(), ["solo"], "solo").projects).toEqual([]);
  });

  it("works on the roadmap's route too", () => {
    const roadmap: RoadmapRoute = { view: "roadmap", projects: [], item: "sky-1" };
    expect(formatRoute(chooseProject(roadmap, OFFERED, "tides"))).toBe("/roadmap?project=tides");
  });

  it("changes only the projects on a route the project does not scope (shared-nav-header)", () => {
    const inbox: InboxRoute = { view: "inbox", item: "i1", source: "gmail", projects: [] };
    expect(chooseProject(inbox, OFFERED, "skyos")).toEqual({ ...inbox, projects: ["skyos"] });
    const graph: GraphRoute = { view: "graph", q: "x", types: ["doc"], node: "n1", projects: ["tides"] };
    expect(chooseProject(graph, OFFERED, ALL_PROJECTS_CHOICE)).toEqual({ ...graph, projects: [] });
    const search: SearchRoute = { view: "search", q: "x", types: [], projects: ["tides", "skyos"], reviewsOnly: true };
    expect(formatRoute(chooseProject(search, OFFERED, "tides"))).toBe("/search?q=x&project=tides&review=1");
  });
});

// The Board / Roadmap toggle is gone (shared-nav-header, design.md decision 4):
// the header's nav links carry the projects (lib/shellNav.test.ts), by the
// toggle's view-carrying rule kept here.
describe("viewCarriedProjects", () => {
  it("knows a view's carried projects without the registry", () => {
    expect(viewCarriedProjects(null, ["tides"])).toBeNull();
    expect(viewCarriedProjects(["tides", "skyos", "tides"], [])).toEqual(["tides", "skyos"]);
    expect(viewCarriedProjects(["tides", "skyos"], ["skyos", "gone"])).toEqual(["skyos"]);
    expect(viewCarriedProjects(["tides", "skyos"], ["gone"])).toEqual(["tides", "skyos"]);
  });
});

describe("switcherOffer", () => {
  const base = { viewProjects: null, registry: null, registryFailed: false, address: ["rmf"] };

  it("offers a view's own projects without waiting for the registry", () => {
    expect(switcherOffer({ ...base, viewProjects: ["a", "b", "a"] })).toEqual({ offered: ["a", "b"], fallback: false });
  });

  it("offers the registry's projects once read, whatever the board or roadmap read does", () => {
    expect(switcherOffer({ ...base, registry: ["rmf", "rmb"] })).toEqual({ offered: ["rmf", "rmb"], fallback: false });
    expect(switcherOffer({ ...base, registry: ["rmf"], registryFailed: true })).toEqual({ offered: ["rmf"], fallback: false });
  });

  it("falls back to the address's projects when the registry fails", () => {
    expect(switcherOffer({ ...base, registryFailed: true })).toEqual({ offered: ["rmf"], fallback: true });
    expect(switcherOffer({ ...base, address: [], registryFailed: true })).toEqual({ offered: [], fallback: true });
  });

  it("is unknown while nothing has been read", () => {
    expect(switcherOffer(base)).toEqual({ offered: null, fallback: false });
  });
});
