// The Views menu's grouping (shared-nav-header tasks.md 1.4; app-navigation
// spec "The Views menu lists saved views").

import { describe, expect, it } from "vitest";
import { formatRoute } from "./route.js";
import { groupSavedViews, savedViewRoute, UNTITLED_VIEW, type ViewRow } from "./savedViews.js";

function row(id: string, title: string, renderer: unknown): ViewRow {
  return { id, title, metadata: renderer === undefined ? {} : { renderer } };
}

describe("groupSavedViews", () => {
  it("groups by renderer in the order feed, code, timeline, board", () => {
    const groups = groupSavedViews([row("1", "Board A", "board"), row("2", "Shipping log", "timeline"), row("3", "Repo", "code"), row("4", "Inbox feed", "feed")]);
    expect(groups.map((g) => [g.renderer, g.label])).toEqual([
      ["feed", "Feeds"],
      ["code", "Code views"],
      ["timeline", "Timelines"],
      ["board", "Boards"],
    ]);
  });

  it("omits a renderer with no saved views (No saved feeds)", () => {
    const groups = groupSavedViews([row("1", "Shipping log", "timeline")]);
    expect(groups.map((g) => g.renderer)).toEqual(["timeline"]);
    expect(groupSavedViews([])).toEqual([]);
  });

  it("leaves out graph views, which no address opens, and rows outside the contract", () => {
    expect(groupSavedViews([row("1", "Map", "graph"), row("2", "Odd", "list"), row("3", "None", undefined), row("4", "Num", 4)])).toEqual([]);
  });

  it("sorts each group by title, then id, and names an untitled view", () => {
    const [group] = groupSavedViews([row("b", "Beta", "feed"), row("c", "", "feed"), row("a2", "Alpha", "feed"), row("a1", "Alpha", "feed")]);
    expect(group!.views).toEqual([
      { id: "c", title: UNTITLED_VIEW },
      { id: "a1", title: "Alpha" },
      { id: "a2", title: "Alpha" },
      { id: "b", title: "Beta" },
    ]);
  });
});

describe("savedViewRoute", () => {
  it("opens each renderer's route on the view, carrying the projects (Opening a saved timeline)", () => {
    expect(formatRoute(savedViewRoute("timeline", "v1", ["tides"]))).toBe("/timeline?view=v1&project=tides");
    expect(formatRoute(savedViewRoute("feed", "v1", []))).toBe("/feed?view=v1");
    expect(formatRoute(savedViewRoute("code", "v1", ["a", "b"]))).toBe("/code?view=v1&project=a&project=b");
    expect(formatRoute(savedViewRoute("board", "v1", ["tides"]))).toBe("/board?view=v1&project=tides");
  });
});
