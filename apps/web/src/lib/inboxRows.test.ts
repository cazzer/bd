import { describe, expect, it } from "vitest";
import { filterBySource, groupByWork, hangarOriginLabel, needsMeRows, reviewKey, sourcesOf } from "./inboxRows.js";

const item = (id: string, priority: number, at: string, extra: Partial<{ status: string; parentId: string | null; source: string }> = {}) => ({
  id,
  priority,
  receivedAt: at,
  status: extra.status ?? "pending",
  parentId: extra.parentId ?? null,
  source: extra.source ?? "gmail",
});
const review = (project: string, externalId: string, at: string, parent: { id: string; title: string } | null = null) => ({ project, externalId, requestedAt: at, parent });

describe("needsMeRows", () => {
  it("merges pending top-level items with reviews, by priority then age", () => {
    const rows = needsMeRows(
      [
        item("a", 2, "2026-11-01T00:00:00.000Z"),
        item("b", 0, "2026-11-05T00:00:00.000Z"),
        item("c", 1, "2026-11-04T00:00:00.000Z"),
        item("held", 0, "2026-11-01T00:00:00.000Z", { status: "undigested" }),
        item("kid", 0, "2026-11-01T00:00:00.000Z", { parentId: "a" }),
      ],
      [review("shlo", "shlo-1", "2026-11-03T00:00:00.000Z")],
    );
    expect(rows.map((r) => r.key)).toEqual(["b", "shlo/shlo-1", "c", "a"]);
    expect(rows[1]).toMatchObject({ kind: "review", source: "review", priority: 1 });
  });
});

describe("source filter", () => {
  it("lists reviews first, filters to one source, and keeps all for null", () => {
    const rows = needsMeRows([item("a", 2, "2026-11-01T00:00:00.000Z", { source: "slack" }), item("b", 2, "2026-11-02T00:00:00.000Z")], [review("p", "p-1", "2026-11-01T00:00:00.000Z")]);
    expect(sourcesOf(rows)).toEqual(["review", "gmail", "slack"]);
    expect(filterBySource(rows, "review").map((r) => r.key)).toEqual(["p/p-1"]);
    expect(filterBySource(rows, null)).toHaveLength(3);
    expect(reviewKey(review("p", "p-1.2", ""))).toBe("p/p-1.2");
  });
});

describe("groupByWork", () => {
  const rfi = { id: "w1", title: "Vendor RFI" };
  const about = (id: string, priority: number, at: string, work: { id: string; title: string } | null) => ({ ...item(id, priority, at), about: work });

  it("pulls two or more items about the same work to the first one's place, and leaves the rest", () => {
    const rows = needsMeRows(
      [
        about("x", 0, "2026-11-01T00:00:00.000Z", null),
        about("r1", 1, "2026-11-02T00:00:00.000Z", rfi),
        about("y", 1, "2026-11-03T00:00:00.000Z", { id: "w2", title: "Solo" }),
        about("r2", 3, "2026-11-04T00:00:00.000Z", rfi),
      ],
      [review("shlo", "shlo-1", "2026-11-05T00:00:00.000Z")],
    );
    const grouped = groupByWork(rows);
    expect(grouped.rows.map((r) => r.key)).toEqual(["x", "r1", "r2", "y", "shlo/shlo-1"]);
    expect(grouped.slots.get("r1")).toEqual({ workId: "w1", title: "Vendor RFI", count: 2, first: true });
    expect(grouped.slots.get("r2")).toMatchObject({ first: false });
    expect(grouped.slots.has("y")).toBe(false);
    expect(grouped.slots.has("x")).toBe(false);
  });
});

describe("groupByWork with reviews (split-review-decisions)", () => {
  const epic = { id: "w9", title: "Launch a city" };
  const at = (day: number) => `2026-11-${String(day).padStart(2, "0")}T00:00:00.000Z`;

  it("groups reviews under the same parent at the first one's place, each keeping its own key", () => {
    const rows = needsMeRows(
      [item("x", 1, at(2))],
      [review("shlo", "shlo-btp.1", at(1), epic), review("shlo", "solo", at(3)), review("shlo", "shlo-btp.2", at(4), epic), review("shlo", "shlo-btp.3", at(5), epic)],
    );
    const grouped = groupByWork(rows);
    expect(grouped.rows.map((r) => r.key)).toEqual(["shlo/shlo-btp.1", "shlo/shlo-btp.2", "shlo/shlo-btp.3", "x", "shlo/solo"]);
    expect(grouped.slots.get("shlo/shlo-btp.1")).toEqual({ workId: "w9", title: "Launch a city", count: 3, first: true });
    expect(grouped.slots.get("shlo/shlo-btp.3")).toMatchObject({ count: 3, first: false });
    expect(grouped.slots.has("shlo/solo")).toBe(false);
  });

  it("groups a review with an inbox item about the same work item", () => {
    const rows = needsMeRows([{ ...item("mail", 2, at(1)), about: epic }], [review("shlo", "shlo-btp.1", at(2), epic)]);
    const grouped = groupByWork(rows);
    expect(grouped.rows.map((r) => r.key)).toEqual(["shlo/shlo-btp.1", "mail"]);
    expect(grouped.slots.get("mail")).toMatchObject({ workId: "w9", count: 2 });
  });

  it("leaves a lone review, and one without a parent, in place", () => {
    const rows = needsMeRows([item("a", 0, at(1))], [review("p", "p-1", at(2), epic), review("p", "p-2", at(3))]);
    const grouped = groupByWork(rows);
    expect(grouped.rows.map((r) => r.key)).toEqual(["a", "p/p-1", "p/p-2"]);
    expect(grouped.slots.size).toBe(0);
  });

  it("applies the source filter before grouping", () => {
    const rows = needsMeRows([{ ...item("mail", 2, at(1)), about: epic }], [review("shlo", "shlo-btp.1", at(2), epic)]);
    const grouped = groupByWork(filterBySource(rows, "review"));
    expect(grouped.rows.map((r) => r.key)).toEqual(["shlo/shlo-btp.1"]);
    expect(grouped.slots.size).toBe(0);
  });
});

describe("hangarOriginLabel", () => {
  it("labels an item a hangar session filed, in words, and nothing else", () => {
    expect(hangarOriginLabel({ hangarSession: "0b6f2c1e-6d2a-4c1f-9a51-3f1c1b2e7d10" })).toBe("from hangar session");
    expect(hangarOriginLabel({ hangarSession: null })).toBeNull();
  });
});
