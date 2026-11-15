// The project switcher's and the Board / Roadmap toggle's routes
// (roadmap-milestones tasks.md 3.2-3.3; work-board spec "Switching
// project", "Back to all projects", "Old multi-project link", "Board to
// roadmap").

import { describe, expect, it } from "vitest";
import { PROJECT_KEY_PATTERN } from "./boardRow.js";
import { formatRoute, parseRoute, type BoardRoute, type RoadmapRoute } from "./route.js";
import { ALL_PROJECTS_CHOICE, boardToRoadmap, chooseProject, roadmapToBoard, SEVERAL_PROJECTS_VALUE, switcherState, viewCarriedProjects } from "./workViewNav.js";

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
});

describe("Board / Roadmap toggle", () => {
  it("carries the project and drops the item from board to roadmap", () => {
    expect(formatRoute(boardToRoadmap(board(["tides"], { item: "tides-r1" }), null))).toBe("/roadmap?project=tides");
    expect(formatRoute(boardToRoadmap(board(["tides", "strides"]), null))).toBe("/roadmap?project=tides&project=strides");
    expect(formatRoute(boardToRoadmap(board(), null))).toBe("/roadmap");
  });

  it("drops the view, carrying the view's projects when the address names none", () => {
    expect(formatRoute(boardToRoadmap(board([], { viewId: "v1" }), ["tides", "skyos"]))).toBe("/roadmap?project=tides&project=skyos");
    expect(formatRoute(boardToRoadmap(board(["skyos"], { viewId: "v1" }), ["tides", "skyos"]))).toBe("/roadmap?project=skyos");
    expect(formatRoute(boardToRoadmap(board([], { viewId: "v1" }), null))).toBe("/roadmap");
  });

  it("knows a view's carried projects without the registry", () => {
    expect(viewCarriedProjects(null, ["tides"])).toBeNull();
    expect(viewCarriedProjects(["tides", "skyos", "tides"], [])).toEqual(["tides", "skyos"]);
    expect(viewCarriedProjects(["tides", "skyos"], ["skyos", "gone"])).toEqual(["skyos"]);
    expect(viewCarriedProjects(["tides", "skyos"], ["gone"])).toEqual(["tides", "skyos"]);
    expect(formatRoute(boardToRoadmap(board([], { viewId: "v1" }), viewCarriedProjects(["tides", "skyos"], [])))).toBe("/roadmap?project=tides&project=skyos");
  });

  it("carries the project and drops the item from roadmap to board", () => {
    expect(formatRoute(roadmapToBoard({ view: "roadmap", projects: ["skyos"], item: "sky-1" }))).toBe("/board?project=skyos");
    expect(formatRoute(roadmapToBoard({ view: "roadmap", projects: [], item: null }))).toBe("/board");
  });
});
