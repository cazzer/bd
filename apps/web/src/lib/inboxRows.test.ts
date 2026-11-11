import { describe, expect, it } from "vitest";
import { filterBySource, groupByWork, needsMeRows, reviewKey, sourcesOf } from "./inboxRows.js";

const item = (id: string, priority: number, at: string, extra: Partial<{ status: string; parentId: string | null; source: string }> = {}) => ({
  id,
  priority,
  receivedAt: at,
  status: extra.status ?? "pending",
  parentId: extra.parentId ?? null,
  source: extra.source ?? "gmail",
});
const review = (project: string, externalId: string, at: string) => ({ project, externalId, requestedAt: at });

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
