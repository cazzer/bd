import { BOARD_COLUMNS, MAX_BOARD_PROJECTS as CORE_MAX, PROJECT_KEY_PATTERN as CORE_PATTERN } from "@breakdown/core";
import { describe, expect, it } from "vitest";
import {
  addHighlights,
  BOARD_COLUMN_ORDER,
  buildLanes,
  chosenChips,
  filterProjects,
  HIGHLIGHT_MS,
  MAX_BOARD_PROJECTS,
  nextHighlightExpiry,
  offeredChips,
  PROJECT_KEY_PATTERN,
  pruneHighlights,
  readableProjects,
  toggleChip,
  type BoardCardRow,
  type BoardEpicRow,
} from "./boardRow.js";
import { formatRoute, parseRoute } from "./route.js";

function card(id: string, over: Partial<BoardCardRow> = {}): BoardCardRow {
  return { id, externalId: id, title: id, project: "p", priority: 2, issueType: "task", column: "ready", epicId: null, blockedFlag: false, updatedAt: "2026-10-01T00:00:00.000Z", ...over };
}
const epic = (id: string, status = "open", title = id): BoardEpicRow => ({ id, title, status, project: "p" });

describe("columns", () => {
  it("run Ready, Blocked, In progress, Deferred, Closed and match core's ids and pattern", () => {
    expect(BOARD_COLUMN_ORDER.map((c) => c.label)).toEqual(["Ready", "Blocked", "In progress", "Deferred", "Closed"]);
    expect(BOARD_COLUMN_ORDER.map((c) => c.id)).toEqual([...BOARD_COLUMNS]);
    expect(PROJECT_KEY_PATTERN.source).toBe(CORE_PATTERN.source);
    expect(MAX_BOARD_PROJECTS).toBe(CORE_MAX);
  });
});

describe("buildLanes", () => {
  it("puts 'No epic' last, live lanes before collapsed ones, and collapses closed epics whose cards are all closed", () => {
    const lanes = buildLanes(
      [card("a", { epicId: "e-live" }), card("b", { epicId: "e-done", column: "closed" }), card("c", { epicId: "e-done-open" }), card("d")],
      [epic("e-done", "closed", "A done"), epic("e-live", "open", "Z live"), epic("e-done-open", "closed", "B closed epic, open card")],
    );
    expect(lanes.map((l) => l.title)).toEqual(["B closed epic, open card", "Z live", "A done", "No epic"]);
    expect(lanes.map((l) => l.collapsedByDefault)).toEqual([false, false, true, false]);
  });

  it("splits a lane into columns ordered by priority then recency, and sends unknown-epic cards to No epic", () => {
    const [lane, noEpic] = buildLanes(
      [
        card("old-p2", { epicId: "e", updatedAt: "2026-10-01T00:00:00.000Z" }),
        card("new-p2", { epicId: "e", updatedAt: "2026-10-02T00:00:00.000Z" }),
        card("p0", { epicId: "e", priority: 0 }),
        card("wip", { epicId: "e", column: "in_progress" }),
        card("orphan", { epicId: "missing" }),
      ],
      [epic("e")],
    );
    expect(lane!.columns.ready.map((c) => c.id)).toEqual(["p0", "new-p2", "old-p2"]);
    expect(lane!.columns.in_progress.map((c) => c.id)).toEqual(["wip"]);
    expect(lane!.cardCount).toBe(4);
    expect(noEpic!.columns.ready.map((c) => c.id)).toEqual(["orphan"]);
  });

  it("keeps an epic with no cards as a header-only lane and omits an empty No epic lane", () => {
    const lanes = buildLanes([], [epic("e")]);
    expect(lanes.map((l) => [l.title, l.cardCount])).toEqual([["e", 0]]);
  });
});

describe("chips", () => {
  it("reads the project predicate from a view filter, or null when it names none", () => {
    expect(filterProjects([{ key: "project", op: "equals", value: "bd" }])).toEqual(["bd"]);
    expect(filterProjects([{ key: "status", op: "equals", value: "x" }, { key: "project", op: "oneOf", values: ["a", "b", 3] }])).toEqual(["a", "b"]);
    expect(filterProjects([{ key: "status", op: "equals", value: "x" }])).toBeNull();
    expect(filterProjects(undefined)).toBeNull();
  });

  it("offers the view's projects, else the registry", () => {
    expect(offeredChips(["b", "a"], ["x"])).toEqual(["b", "a"]);
    expect(offeredChips(null, ["x", "y", "x"])).toEqual(["x", "y"]);
  });

  it("selects every chip for an empty or stale address, else the address's chips in chip order", () => {
    const offered = ["a", "b", "c"];
    expect(chosenChips(offered, [])).toEqual(offered);
    expect(chosenChips(offered, ["nope"])).toEqual(offered);
    expect(chosenChips(offered, ["c", "a", "nope"])).toEqual(["a", "c"]);
  });

  it("toggles in chip order, spells all-selected as an empty address, and keeps the last chip", () => {
    const offered = ["a", "b", "c"];
    expect(toggleChip(offered, [], "b")).toEqual(["a", "c"]);
    expect(toggleChip(offered, ["a", "c"], "b")).toEqual([]);
    expect(toggleChip(offered, ["c", "a"], "a")).toEqual(["c"]);
    expect(toggleChip(offered, ["c"], "c")).toEqual(["c"]);
    expect(toggleChip(["a"], [], "a")).toEqual([]);
  });

  it("round-trips the toggled selection through the address", () => {
    const offered = ["a", "b", "c"];
    const projects = toggleChip(offered, [], "b");
    const url = formatRoute({ view: "board", viewId: "v1", projects });
    expect(url).toBe("/board?view=v1&project=a&project=c");
    const route = parseRoute("/board", url.slice(url.indexOf("?")));
    expect(route).toEqual({ view: "board", viewId: "v1", projects });
    expect(chosenChips(offered, route && route.view === "board" ? route.projects : [])).toEqual(["a", "c"]);
  });

  it("drops keys the server would refuse and caps the list", () => {
    expect(readableProjects(["ok", "Not A Key", "", "x".repeat(65)])).toEqual(["ok"]);
    expect(readableProjects(Array.from({ length: 25 }, (_, i) => `k${i}`))).toHaveLength(MAX_BOARD_PROJECTS);
  });
});

describe("highlights", () => {
  it("expire after HIGHLIGHT_MS and report the next expiry", () => {
    const h1 = addHighlights(new Map(), ["a"], 1000);
    const h2 = addHighlights(h1, ["b"], 2000);
    expect(nextHighlightExpiry(h2)).toBe(1000 + HIGHLIGHT_MS);
    expect([...pruneHighlights(h2, 1000 + HIGHLIGHT_MS).keys()]).toEqual(["b"]);
    expect(pruneHighlights(h2, 2000 + HIGHLIGHT_MS).size).toBe(0);
    expect(nextHighlightExpiry(new Map())).toBeNull();
  });
});
