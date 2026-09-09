// Tests for lib/timelineRow.ts (timeline-view, tasks.md 3.1): the chip
// rules of timeline-view/spec.md's "The type chips come from the view and
// live in the address" — every chip when the address names none, the
// intersection otherwise, a type the view does not name ignored, nothing
// chosen, a view naming no types — plus the toggle, the address a toggle
// writes, the time label, and the relation label (github-prs-and-commits
// 3.1: `closes` and `touches` read as phrases in both directions).

import { describe, expect, it } from "vitest";
import {
  addressTypesFor,
  chipCountLabel,
  chipCountsCaption,
  chosenTypes,
  countRowsByType,
  formatEventTime,
  formatTimeOfDay,
  GAP_CEILING_PX,
  GAP_FLOOR_MS,
  GAP_FLOOR_PX,
  gapBetween,
  groupRowsByDay,
  linkHost,
  NO_TYPE_CHOSEN,
  relationLabel,
  toggleType,
} from "./timelineRow.js";

describe("chosenTypes", () => {
  it("offers no chips and reads every type when the view names no types (null or absent)", () => {
    expect(chosenTypes([], null)).toEqual({ chips: null, chosen: null, none: false });
    expect(chosenTypes([], undefined)).toEqual({ chips: null, chosen: null, none: false });
  });

  it("ignores the address's types when the view names no types — every timed neighbour is listed", () => {
    expect(chosenTypes(["gh-issue"], null)).toEqual({ chips: null, chosen: null, none: false });
    expect(chosenTypes([NO_TYPE_CHOSEN], null)).toEqual({ chips: null, chosen: null, none: false });
  });

  it("chooses every chip when the address names no type", () => {
    expect(chosenTypes([], ["gh-issue", "work_item"])).toEqual({ chips: ["gh-issue", "work_item"], chosen: ["gh-issue", "work_item"], none: false });
  });

  it("chooses the intersection, in the view's order", () => {
    expect(chosenTypes(["work_item", "gh-issue"], ["gh-issue", "work_item", "repo"])).toEqual({ chips: ["gh-issue", "work_item", "repo"], chosen: ["gh-issue", "work_item"], none: false });
    expect(chosenTypes(["work_item"], ["gh-issue", "work_item"])).toEqual({ chips: ["gh-issue", "work_item"], chosen: ["work_item"], none: false });
  });

  it("drops an address type the view does not name and keeps the rest", () => {
    expect(chosenTypes(["file", "gh-issue"], ["gh-issue", "work_item"])).toEqual({ chips: ["gh-issue", "work_item"], chosen: ["gh-issue"], none: false });
  });

  it("is none when every address type is foreign — including the deselect-all marker", () => {
    expect(chosenTypes(["file"], ["gh-issue", "work_item"])).toEqual({ chips: ["gh-issue", "work_item"], chosen: [], none: true });
    expect(chosenTypes([NO_TYPE_CHOSEN], ["gh-issue", "work_item"])).toEqual({ chips: ["gh-issue", "work_item"], chosen: [], none: true });
  });

  it("collapses a view type named twice to one chip", () => {
    expect(chosenTypes([], ["gh-issue", "work_item", "gh-issue"])).toEqual({ chips: ["gh-issue", "work_item"], chosen: ["gh-issue", "work_item"], none: false });
  });

  it("returns copies, never the view's or address's own arrays", () => {
    const viewTypes = ["gh-issue", "work_item"];
    const selection = chosenTypes([], viewTypes);
    expect(selection.chips).not.toBe(viewTypes);
    expect(selection.chosen).not.toBe(viewTypes);
    expect(selection.chosen).not.toBe(selection.chips);
    selection.chips?.push("x");
    expect(viewTypes).toEqual(["gh-issue", "work_item"]);
  });
});

describe("toggleType", () => {
  it("removes a chosen type", () => {
    expect(toggleType(["gh-issue", "work_item"], "work_item")).toEqual(["gh-issue"]);
  });

  it("appends an unchosen type", () => {
    expect(toggleType(["gh-issue"], "work_item")).toEqual(["gh-issue", "work_item"]);
  });

  it("empties on the last chip and refills from empty", () => {
    expect(toggleType(["gh-issue"], "gh-issue")).toEqual([]);
    expect(toggleType([], "gh-issue")).toEqual(["gh-issue"]);
  });

  it("does not mutate its input", () => {
    const chosen = ["gh-issue", "work_item"];
    toggleType(chosen, "work_item");
    toggleType(chosen, "repo");
    expect(chosen).toEqual(["gh-issue", "work_item"]);
  });
});

describe("addressTypesFor", () => {
  it("writes the chosen set as it is", () => {
    expect(addressTypesFor(["gh-issue"])).toEqual(["gh-issue"]);
    expect(addressTypesFor(["gh-issue", "work_item"])).toEqual(["gh-issue", "work_item"]);
  });

  it("writes the marker alone for an empty set, since an empty address means every chip", () => {
    expect(addressTypesFor([])).toEqual([NO_TYPE_CHOSEN]);
    expect(chosenTypes(addressTypesFor([]), ["gh-issue", "work_item"]).none).toBe(true);
  });

  it("round-trips a deselect-then-reselect through chosenTypes", () => {
    const view = ["gh-issue", "work_item"];
    const afterFirst = addressTypesFor(toggleType(chosenTypes([], view).chosen ?? [], "work_item"));
    expect(afterFirst).toEqual(["gh-issue"]);
    const afterLast = addressTypesFor(toggleType(chosenTypes(afterFirst, view).chosen ?? [], "gh-issue"));
    expect(afterLast).toEqual([NO_TYPE_CHOSEN]);
    const back = addressTypesFor(toggleType(chosenTypes(afterLast, view).chosen ?? [], "work_item"));
    expect(back).toEqual(["work_item"]);
    expect(chosenTypes(back, view)).toEqual({ chips: view, chosen: ["work_item"], none: false });
  });
});

describe("formatEventTime", () => {
  it("shows date and time in the given locale and zone, with the canonical ISO instant as the title", () => {
    const label = formatEventTime("2026-03-04T10:00:00.000Z", { locale: "en-US", timeZone: "UTC" });
    expect(label.text).toMatch(/^Mar 4, 2026, 10:00\sAM$/);
    expect(label.title).toBe("2026-03-04T10:00:00.000Z");
    expect(label.iso).toBe("2026-03-04T10:00:00.000Z");
  });

  it("renders the same instant in the viewer's zone", () => {
    const label = formatEventTime("2026-03-04T10:00:00.000Z", { locale: "en-US", timeZone: "America/New_York" });
    expect(label.text).toMatch(/^Mar 4, 2026, 5:00\sAM$/);
    expect(label.title).toBe("2026-03-04T10:00:00.000Z");
  });

  it("canonicalizes the title for a value that bypassed the contract, and shows it in the zone", () => {
    const label = formatEventTime("2026-03-04T10:00:00+02:00", { locale: "en-US", timeZone: "UTC" });
    expect(label.title).toBe("2026-03-04T08:00:00.000Z");
    expect(label.iso).toBe("2026-03-04T08:00:00.000Z");
    expect(label.text).toMatch(/^Mar 4, 2026, 8:00\sAM$/);
  });

  it("shows an unparseable value as the text it is", () => {
    expect(formatEventTime("last Tuesday", { timeZone: "UTC" })).toEqual({ text: "last Tuesday", title: "last Tuesday", iso: null });
    expect(formatEventTime("", { timeZone: "UTC" })).toEqual({ text: "", title: "", iso: null });
  });

  it("uses the viewer's own locale and zone when none are given", () => {
    const label = formatEventTime("2026-03-04T10:00:00.000Z");
    expect(label.title).toBe("2026-03-04T10:00:00.000Z");
    expect(label.text.length).toBeGreaterThan(0);
  });
});

describe("relationLabel", () => {
  it("points an incoming edge from the row toward the anchor", () => {
    expect(relationLabel("belongs-to", "incoming")).toEqual({ text: "belongs-to →", title: "this item —belongs-to→ the anchor" });
  });

  it("points an outgoing edge from the anchor toward the row", () => {
    expect(relationLabel("blocks", "outgoing")).toEqual({ text: "← blocks", title: "the anchor —blocks→ this item" });
  });

  it("reads closes as a phrase: a pull request row that closes the anchor issue", () => {
    expect(relationLabel("closes", "incoming")).toEqual({ text: "closes →", title: "this item closes the anchor" });
  });

  it("reads closes as a phrase: an issue row the anchor pull request closes", () => {
    expect(relationLabel("closes", "outgoing")).toEqual({ text: "← closes", title: "this item is closed by the anchor" });
  });

  it("reads touches as a phrase: a commit row that touches the anchor file", () => {
    expect(relationLabel("touches", "incoming")).toEqual({ text: "touches →", title: "this item touches the anchor" });
  });

  it("reads touches as a phrase: a file row the anchor commit touches", () => {
    expect(relationLabel("touches", "outgoing")).toEqual({ text: "← touches", title: "this item is touched by the anchor" });
  });

  it("keeps the generic sentence for a type with no phrase, including one named like an inherited object key", () => {
    expect(relationLabel("mentions", "incoming")).toEqual({ text: "mentions →", title: "this item —mentions→ the anchor" });
    expect(relationLabel("constructor", "outgoing")).toEqual({ text: "← constructor", title: "the anchor —constructor→ this item" });
  });
});

describe("linkHost", () => {
  it("names a link by its host", () => {
    expect(linkHost("https://github.com/cazzer/traitor/issues/1")).toBe("github.com");
    expect(linkHost("http://example.test:8080/pr/2")).toBe("example.test:8080");
  });

  it("falls back to the text itself when it is not a URL", () => {
    expect(linkHost("not a url")).toBe("not a url");
  });
});

describe("formatTimeOfDay", () => {
  it("drops the date the group header already states, keeping the canonical instant as the title", () => {
    const label = formatTimeOfDay("2026-03-04T10:00:00.000Z", { locale: "en-US", timeZone: "UTC" });
    expect(label.text).toMatch(/^10:00\sAM$/);
    expect(label.title).toBe("2026-03-04T10:00:00.000Z");
    expect(label.iso).toBe("2026-03-04T10:00:00.000Z");
  });

  it("renders the same instant in the viewer's zone", () => {
    expect(formatTimeOfDay("2026-03-04T10:00:00.000Z", { locale: "en-US", timeZone: "America/New_York" }).text).toMatch(/^5:00\sAM$/);
  });

  it("shows an unparseable value as the text it is", () => {
    expect(formatTimeOfDay("last Tuesday", { timeZone: "UTC" })).toEqual({ text: "last Tuesday", title: "last Tuesday", iso: null });
  });
});

describe("gapBetween", () => {
  it("draws the floor for rows inside the burst window, whichever order they are given in", () => {
    expect(gapBetween("2026-09-04T10:00:00.000Z", "2026-09-04T09:52:00.000Z")).toEqual({ ms: 8 * 60_000, spacingPx: GAP_FLOOR_PX, label: null });
    expect(gapBetween("2026-09-04T09:52:00.000Z", "2026-09-04T10:00:00.000Z").spacingPx).toBe(GAP_FLOOR_PX);
    expect(gapBetween("2026-09-04T10:00:00.000Z", "2026-09-04T09:00:00.000Z")).toEqual({ ms: GAP_FLOOR_MS, spacingPx: GAP_FLOOR_PX, label: null });
  });

  it("grows with the interval between the floor and the ceiling", () => {
    const twoHours = gapBetween("2026-09-04T10:00:00.000Z", "2026-09-04T08:00:00.000Z");
    const tenHours = gapBetween("2026-09-04T10:00:00.000Z", "2026-09-04T00:00:00.000Z");
    expect(twoHours.spacingPx).toBeGreaterThan(GAP_FLOOR_PX);
    expect(tenHours.spacingPx).toBeGreaterThan(twoHours.spacingPx);
    expect(tenHours.spacingPx).toBeLessThan(GAP_CEILING_PX);
  });

  it("names a three-week gap rather than drawing it to scale — the spacing is the ceiling a one-week gap already reaches", () => {
    const threeWeeks = gapBetween("2026-09-04T00:00:00.000Z", "2026-08-14T00:00:00.000Z");
    expect(threeWeeks.label).toBe("3 weeks earlier");
    expect(threeWeeks.spacingPx).toBe(GAP_CEILING_PX);
    expect(gapBetween("2026-09-04T00:00:00.000Z", "2026-08-28T00:00:00.000Z").spacingPx).toBe(GAP_CEILING_PX);
    // Proportional spacing would be three times a week's, which is what the bound exists to refuse.
    expect(threeWeeks.spacingPx).toBeLessThan(3 * GAP_CEILING_PX);
  });

  it("names the interval in the largest unit that fits, floored, so three weeks never rounds up to a month", () => {
    expect(gapBetween("2026-09-04T00:00:00.000Z", "2026-09-03T18:00:00.000Z").label).toBe("6 hours earlier");
    expect(gapBetween("2026-09-04T00:00:00.000Z", "2026-09-02T18:00:00.000Z").label).toBe("1 day earlier");
    expect(gapBetween("2026-09-04T00:00:00.000Z", "2026-08-21T00:00:00.000Z").label).toBe("2 weeks earlier");
    expect(gapBetween("2026-09-04T00:00:00.000Z", "2026-06-04T00:00:00.000Z").label).toBe("3 months earlier");
    expect(gapBetween("2026-09-04T00:00:00.000Z", "2023-09-04T00:00:00.000Z").label).toBe("3 years earlier");
  });

  it("says nothing about a gap under the label threshold", () => {
    expect(gapBetween("2026-09-04T00:00:00.000Z", "2026-09-03T18:00:01.000Z").label).toBeNull();
  });

  it("falls back to the floor and no label when either end did not parse", () => {
    expect(gapBetween("last Tuesday", "2026-09-04T00:00:00.000Z")).toEqual({ ms: 0, spacingPx: GAP_FLOOR_PX, label: null });
    expect(gapBetween("2026-09-04T00:00:00.000Z", "")).toEqual({ ms: 0, spacingPx: GAP_FLOOR_PX, label: null });
  });
});

describe("groupRowsByDay", () => {
  const utc = { locale: "en-US", timeZone: "UTC" } as const;

  it("groups eight rows inside one hour together, every one of them at floor spacing", () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({ occurredAt: new Date(Date.UTC(2026, 8, 4, 10, 56 - i * 8)).toISOString() }));
    const groups = groupRowsByDay(rows, utc);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.entries).toHaveLength(8);
    expect(groups[0]!.gap).toBeNull();
    expect(groups[0]!.entries[0]!.gap).toBeNull();
    expect(groups[0]!.entries.slice(1).map((e) => e.gap?.spacingPx)).toEqual(Array.from({ length: 7 }, () => GAP_FLOOR_PX));
    expect(groups[0]!.entries.every((e) => e.gap?.label == null)).toBe(true);
  });

  it("starts a new group at a day boundary and names each day once", () => {
    const groups = groupRowsByDay(
      [
        { occurredAt: "2026-09-04T00:30:00.000Z" },
        { occurredAt: "2026-09-03T23:30:00.000Z" },
        { occurredAt: "2026-09-03T09:00:00.000Z" },
      ],
      utc,
    );
    expect(groups.map((g) => g.key)).toEqual(["2026-09-04", "2026-09-03"]);
    expect(groups.map((g) => g.entries.length)).toEqual([1, 2]);
    expect(groups[0]!.label).toBe("Fri, Sep 4, 2026");
    expect(groups[1]!.label).toBe("Thu, Sep 3, 2026");
  });

  it("carries the gap across a group boundary on the group, not on its first row", () => {
    const groups = groupRowsByDay([{ occurredAt: "2026-09-04T02:00:00.000Z" }, { occurredAt: "2026-09-03T02:00:00.000Z" }], utc);
    expect(groups[1]!.entries[0]!.gap).toBeNull();
    expect(groups[1]!.gap).toEqual(gapBetween("2026-09-04T02:00:00.000Z", "2026-09-03T02:00:00.000Z"));
    expect(groups[1]!.gap?.label).toBe("1 day earlier");
  });

  it("breaks groups on the viewer's own day, not on UTC's", () => {
    const rows = [{ occurredAt: "2026-09-04T03:00:00.000Z" }, { occurredAt: "2026-09-04T01:00:00.000Z" }];
    expect(groupRowsByDay(rows, utc).map((g) => g.key)).toEqual(["2026-09-04"]);
    expect(groupRowsByDay(rows, { locale: "en-US", timeZone: "America/New_York" }).map((g) => g.key)).toEqual(["2026-09-03"]);
  });

  it("keeps the rows' own order and never merges two runs of one day", () => {
    const groups = groupRowsByDay([{ occurredAt: "2026-09-04T10:00:00.000Z" }, { occurredAt: "2026-09-03T10:00:00.000Z" }, { occurredAt: "2026-09-04T09:00:00.000Z" }], utc);
    expect(groups.map((g) => g.key)).toEqual(["2026-09-04", "2026-09-03", "2026-09-04"]);
  });

  it("groups a row whose time did not parse alone, labelled as the text it is", () => {
    const groups = groupRowsByDay([{ occurredAt: "2026-09-04T10:00:00.000Z" }, { occurredAt: "whenever" }], utc);
    expect(groups.map((g) => g.key)).toEqual(["2026-09-04", "?whenever"]);
    expect(groups[1]!.label).toBe("whenever");
    expect(groups[1]!.gap).toEqual({ ms: 0, spacingPx: GAP_FLOOR_PX, label: null });
  });

  it("returns nothing for no rows", () => {
    expect(groupRowsByDay([], utc)).toEqual([]);
  });
});

describe("countRowsByType and the chip labels", () => {
  const rows = [{ nodeType: "commit" }, { nodeType: "commit" }, { nodeType: "gh-pr" }];

  it("counts the loaded page's composition", () => {
    expect([...countRowsByType(rows)]).toEqual([
      ["commit", 2],
      ["gh-pr", 1],
    ]);
    expect(countRowsByType([]).size).toBe(0);
  });

  it("reports a chosen chip's share of the loaded rows, zero distinguishably", () => {
    const counts = countRowsByType(rows);
    const chosen = ["commit", "gh-pr", "work_item"];
    expect(chipCountLabel("commit", chosen, counts)).toEqual({ text: "2", empty: false, title: "2 of the rows loaded are commit" });
    expect(chipCountLabel("gh-pr", chosen, counts)).toEqual({ text: "1", empty: false, title: "1 of the rows loaded is a gh-pr" });
    expect(chipCountLabel("work_item", chosen, counts)).toEqual({ text: "0", empty: true, title: "no work_item among the rows loaded" });
  });

  it("reports no number for a deselected chip, whose rows were never read", () => {
    const label = chipCountLabel("repo", ["commit"], countRowsByType(rows));
    expect(label.text).toBeNull();
    expect(label.empty).toBe(false);
    expect(label.title).toContain("deselected");
  });

  it("counts every chip when the view names no types to narrow by", () => {
    expect(chipCountLabel("commit", null, countRowsByType(rows)).text).toBe("2");
  });

  it("gives the counts their scope, never implying a store-wide total", () => {
    expect(chipCountsCaption(50, true)).toBe("counts are of the 50 rows loaded — more exist");
    expect(chipCountsCaption(12, false)).toBe("counts are of all 12 rows");
  });
});
