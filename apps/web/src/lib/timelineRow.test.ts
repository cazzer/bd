// Tests for lib/timelineRow.ts (timeline-view, tasks.md 3.1): the chip
// rules of timeline-view/spec.md's "The type chips come from the view and
// live in the address" — every chip when the address names none, the
// intersection otherwise, a type the view does not name ignored, nothing
// chosen, a view naming no types — plus the toggle, the address a toggle
// writes, the time label, and the relation label.

import { describe, expect, it } from "vitest";
import { addressTypesFor, chosenTypes, formatEventTime, NO_TYPE_CHOSEN, relationLabel, toggleType } from "./timelineRow.js";

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
  });

  it("renders the same instant in the viewer's zone", () => {
    const label = formatEventTime("2026-03-04T10:00:00.000Z", { locale: "en-US", timeZone: "America/New_York" });
    expect(label.text).toMatch(/^Mar 4, 2026, 5:00\sAM$/);
    expect(label.title).toBe("2026-03-04T10:00:00.000Z");
  });

  it("canonicalizes the title for a value that bypassed the contract, and shows it in the zone", () => {
    const label = formatEventTime("2026-03-04T10:00:00+02:00", { locale: "en-US", timeZone: "UTC" });
    expect(label.title).toBe("2026-03-04T08:00:00.000Z");
    expect(label.text).toMatch(/^Mar 4, 2026, 8:00\sAM$/);
  });

  it("shows an unparseable value as the text it is", () => {
    expect(formatEventTime("last Tuesday", { timeZone: "UTC" })).toEqual({ text: "last Tuesday", title: "last Tuesday" });
    expect(formatEventTime("", { timeZone: "UTC" })).toEqual({ text: "", title: "" });
  });

  it("uses the viewer's own locale and zone when none are given", () => {
    const label = formatEventTime("2026-03-04T10:00:00.000Z");
    expect(label.title).toBe("2026-03-04T10:00:00.000Z");
    expect(label.text.length).toBeGreaterThan(0);
    expect(label.text).toContain("2026");
  });
});

describe("relationLabel", () => {
  it("points an incoming edge from the row toward the anchor", () => {
    expect(relationLabel("belongs-to", "incoming")).toEqual({ text: "belongs-to →", title: "this item —belongs-to→ the anchor" });
  });

  it("points an outgoing edge from the anchor toward the row", () => {
    expect(relationLabel("blocks", "outgoing")).toEqual({ text: "← blocks", title: "the anchor —blocks→ this item" });
  });
});
