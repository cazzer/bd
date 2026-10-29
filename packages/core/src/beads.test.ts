import { describe, expect, it } from "vitest";
import { deriveBeadsEdges, fitText, mapBeadsIssueToNode, resolveBeadsEdges, type BeadsIssue } from "./beads.js";
import { InvalidEventTimeError, InvalidWorkItemError } from "./errors.js";
import { DEFAULT_MAX_TITLE_LENGTH } from "./nodes.js";
import { MAX_ASSIGNEE_LENGTH, MAX_CLOSED_REASON_LENGTH, MAX_SPEC_ID_LENGTH } from "./work-items.js";

const base: BeadsIssue = {
  id: "bd-abc",
  title: "Do the thing",
  description: "Why and what.",
  status: "open",
  priority: 1,
  issue_type: "task",
  owner: "caleb@example.com",
  created_by: "Caleb",
  created_at: "2026-09-01T10:00:00Z",
  updated_at: "2026-09-02T10:00:00Z",
  spec_id: "work-items",
};

describe("mapBeadsIssueToNode", () => {
  it("maps an open issue to a work_item with the contract fields and pass-through keys", () => {
    const node = mapBeadsIssueToNode(base);
    expect(node).toMatchObject({ nodeType: "work_item", sourceSystem: "beads", externalId: "bd-abc", title: "Do the thing", content: "Why and what." });
    expect(node.metadata).toEqual({
      status: "open",
      priority: 1,
      assignee: "caleb@example.com",
      spec_id: "work-items",
      issue_type: "task",
      created_by: "Caleb",
      source_created_at: "2026-09-01T10:00:00Z",
      source_updated_at: "2026-09-02T10:00:00Z",
      occurred_at: "2026-09-01T10:00:00.000Z",
    });
  });

  it("cuts an over-cap close reason to exactly the cap and leaves an at-cap one untouched", () => {
    const over = mapBeadsIssueToNode({ ...base, status: "closed", closed_at: "2026-09-03T10:00:00Z", close_reason: "r".repeat(MAX_CLOSED_REASON_LENGTH + 500) });
    expect(over.metadata?.["closed_reason"]).toBe("r".repeat(MAX_CLOSED_REASON_LENGTH));
    const exact = "e".repeat(MAX_CLOSED_REASON_LENGTH);
    const at = mapBeadsIssueToNode({ ...base, status: "closed", closed_at: "2026-09-03T10:00:00Z", close_reason: exact });
    expect(at.metadata?.["closed_reason"]).toBe(exact);
  });

  it("does not split an astral character at the cap", () => {
    const reason = `${"a".repeat(MAX_CLOSED_REASON_LENGTH - 1)}😀tail`;
    const node = mapBeadsIssueToNode({ ...base, status: "closed", closed_at: "2026-09-03T10:00:00Z", close_reason: reason });
    expect(node.metadata?.["closed_reason"]).toBe("a".repeat(MAX_CLOSED_REASON_LENGTH - 1));
    expect(fitText("😀😀", 3)).toBe("😀");
    expect(fitText("short", 10)).toBe("short");
  });

  it("fits an over-long title, owner, and spec_id instead of refusing", () => {
    const node = mapBeadsIssueToNode({ ...base, title: "t".repeat(DEFAULT_MAX_TITLE_LENGTH + 10), owner: "o".repeat(MAX_ASSIGNEE_LENGTH + 10), spec_id: "s".repeat(MAX_SPEC_ID_LENGTH + 10) });
    expect(node.title).toBe("t".repeat(DEFAULT_MAX_TITLE_LENGTH));
    expect(node.metadata).toMatchObject({ assignee: "o".repeat(MAX_ASSIGNEE_LENGTH), spec_id: "s".repeat(MAX_SPEC_ID_LENGTH) });
  });

  it("writes project when given and leaves the key absent otherwise", () => {
    expect(mapBeadsIssueToNode(base, 0, { project: "bd" }).metadata).toMatchObject({ project: "bd", status: "open", spec_id: "work-items" });
    expect(mapBeadsIssueToNode(base, 0, {}).metadata).not.toHaveProperty("project");
  });

  it("refuses an invalid project naming project and the batch index", () => {
    let thrown: unknown;
    try {
      mapBeadsIssueToNode(base, 4, { project: "Tides Repo" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(InvalidWorkItemError);
    expect((thrown as InvalidWorkItemError).field).toBe("project");
    expect((thrown as InvalidWorkItemError).index).toBe(4);
  });

  it("writes created_at as a canonical occurred_at beside source_created_at, and none when the issue has no created_at", () => {
    const timed = mapBeadsIssueToNode({ ...base, created_at: "2026-09-01T03:00:00.123456-07:00" });
    expect(timed.metadata).toMatchObject({ occurred_at: "2026-09-01T10:00:00.123Z", source_created_at: "2026-09-01T03:00:00.123456-07:00" });
    for (const issue of [{ ...base, created_at: null }, { ...base, created_at: undefined }]) {
      const node = mapBeadsIssueToNode(issue);
      expect(node.metadata).not.toHaveProperty("occurred_at");
      expect(node.metadata).toMatchObject({ source_created_at: null });
    }
  });

  it("rejects an unparseable created_at as occurred_at, naming the batch index", () => {
    let thrown: unknown;
    try {
      mapBeadsIssueToNode({ ...base, created_at: "last Tuesday" }, 5);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(InvalidEventTimeError);
    expect((thrown as InvalidEventTimeError).item).toBe("at batch index 5");
    expect((thrown as InvalidEventTimeError).message).toContain("occurred_at");
  });

  it("maps a closed issue's closed_at and close_reason, normalizing the timestamp", () => {
    const node = mapBeadsIssueToNode({ ...base, status: "closed", closed_at: "2026-09-02T21:41:14Z", close_reason: "shipped" });
    expect(node.metadata).toMatchObject({ status: "closed", closed_at: "2026-09-02T21:41:14.000Z", closed_reason: "shipped" });
  });

  it("appends acceptance criteria, design, and notes as sections of the content", () => {
    const node = mapBeadsIssueToNode({ ...base, acceptance_criteria: "It works.", design: null, notes: "  Remember X.  " });
    expect(node.content).toBe("Why and what.\n\n## Acceptance criteria\n\nIt works.\n\n## Notes\n\nRemember X.");
    expect(mapBeadsIssueToNode({ ...base, description: null }).content).toBe("");
  });

  it("carries labels only when present and treats null owner as no assignee", () => {
    expect(mapBeadsIssueToNode({ ...base, owner: null, labels: ["a", "b"] }).metadata).toMatchObject({ labels: ["a", "b"] });
    expect(mapBeadsIssueToNode({ ...base, owner: null }).metadata).not.toHaveProperty("assignee");
    expect(mapBeadsIssueToNode(base).metadata).not.toHaveProperty("labels");
  });

  it("rejects a row that violates the contract, naming the batch index", () => {
    let thrown: unknown;
    try {
      mapBeadsIssueToNode({ ...base, status: "wontfix" }, 7);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(InvalidWorkItemError);
    expect((thrown as InvalidWorkItemError).index).toBe(7);
    expect(() => mapBeadsIssueToNode({ ...base, priority: 9 })).toThrow(InvalidWorkItemError);
  });
});

describe("mapBeadsIssueToNode reviews", () => {
  const images = ["/home/u/.local/share/breakdown/reviews/bd/bd-r1/01-a.png", "/home/u/.local/share/breakdown/reviews/bd/bd-r1/02-b.png"];
  const reviewBead: BeadsIssue = {
    ...base,
    id: "bd-r1",
    labels: ["review"],
    comment_count: 3,
    metadata: { review: { images, pane: "w3:p1", summary: "Board header" }, other: "ignored" },
  };
  const threeComments = [
    { id: 12, issue_id: "bd-r1", author: "agent", text: "updated", created_at: "2026-10-28T12:00:00Z" },
    { id: 10, issue_id: "bd-r1", author: "agent", text: "requested", created_at: "2026-10-28T10:00:00Z" },
    { id: 11, issue_id: "bd-r1", author: "caleb", text: "Changes requested: header overlaps", created_at: "2026-10-28T11:00:00Z" },
  ];

  it("writes a review bead's images, pane, summary, and comments oldest first", () => {
    const node = mapBeadsIssueToNode(reviewBead, 0, { project: "bd", comments: threeComments });
    expect(node.metadata?.["review"]).toEqual({ images, pane: "w3:p1", summary: "Board header" });
    expect(node.metadata?.["review_comments"]).toEqual([
      { id: "10", author: "agent", text: "requested", created_at: "2026-10-28T10:00:00.000Z" },
      { id: "11", author: "caleb", text: "Changes requested: header overlaps", created_at: "2026-10-28T11:00:00.000Z" },
      { id: "12", author: "agent", text: "updated", created_at: "2026-10-28T12:00:00.000Z" },
    ]);
    expect(node.metadata).not.toHaveProperty("other");
    expect(node.metadata).toMatchObject({ labels: ["review"], project: "bd", status: "open" });
  });

  it("stores malformed review metadata as invalid rather than refusing", () => {
    const node = mapBeadsIssueToNode({ ...reviewBead, metadata: { review: { images: "a.png" } } });
    expect(node.metadata?.["review"]).toEqual({ invalid: true });
  });

  it("writes no review key for a review bead without metadata.review, and no comments key when none survive", () => {
    const node = mapBeadsIssueToNode({ ...reviewBead, metadata: null }, 0, { comments: [{ id: 1, text: 5 }] });
    expect(node.metadata).not.toHaveProperty("review");
    expect(node.metadata).not.toHaveProperty("review_comments");
  });

  it("ignores metadata.review and comments on a bead not labelled review", () => {
    for (const labels of [["ui"], ["review:changes"], null]) {
      const node = mapBeadsIssueToNode({ ...reviewBead, labels }, 0, { comments: threeComments });
      expect(node.metadata).not.toHaveProperty("review");
      expect(node.metadata).not.toHaveProperty("review_comments");
    }
  });

  it("maps a plain bead's metadata exactly as before reviews existed", () => {
    const node = mapBeadsIssueToNode({ ...base, labels: ["ui"], comment_count: 2, metadata: { team: "x" } }, 0, { project: "bd", comments: [] });
    expect(node.metadata).toEqual({
      status: "open",
      priority: 1,
      assignee: "caleb@example.com",
      spec_id: "work-items",
      issue_type: "task",
      created_by: "Caleb",
      source_created_at: "2026-09-01T10:00:00Z",
      source_updated_at: "2026-09-02T10:00:00Z",
      occurred_at: "2026-09-01T10:00:00.000Z",
      project: "bd",
      labels: ["ui"],
    });
  });
});

describe("deriveBeadsEdges", () => {
  const issues: BeadsIssue[] = [
    { ...base, id: "a", dependencies: [] },
    { ...base, id: "b", dependencies: [{ issue_id: "b", depends_on_id: "a", type: "blocks" }] },
    {
      ...base,
      id: "c",
      dependencies: [
        { issue_id: "c", depends_on_id: "b", type: "blocks" },
        { issue_id: "c", depends_on_id: "b", type: "blocks" },
        { issue_id: "c", depends_on_id: "epic", type: "parent-child" },
        { issue_id: "c", depends_on_id: "gone", type: "blocks" },
        { issue_id: "c", depends_on_id: "a", type: "discovered-from" },
      ],
    },
    { ...base, id: "epic", issue_type: "epic", dependencies: null },
  ];

  it("turns blocks dependencies into blocker -> blocked edges and parent-child into child_of, deduplicated", () => {
    const result = deriveBeadsEdges(issues, new Set(issues.map((i) => i.id)));
    expect(result.edges).toEqual([
      { srcExternalId: "a", dstExternalId: "b", edgeType: "blocks" },
      { srcExternalId: "b", dstExternalId: "c", edgeType: "blocks" },
      { srcExternalId: "c", dstExternalId: "epic", edgeType: "child_of" },
    ]);
    expect(result.skippedUnknownIssue).toBe(1);
    expect(result.skippedUnknownType).toBe(1);
  });

  it("resolves candidates to edge inputs with the beads source system, dropping any without a node id", () => {
    const { edges } = deriveBeadsEdges(issues, new Set(issues.map((i) => i.id)));
    const ids = new Map([
      ["a", "11111111-1111-4111-8111-111111111111"],
      ["b", "22222222-2222-4222-8222-222222222222"],
      ["c", "33333333-3333-4333-8333-333333333333"],
    ]);
    const resolved = resolveBeadsEdges(edges, ids);
    expect(resolved).toEqual([
      { srcId: ids.get("a"), dstId: ids.get("b"), edgeType: "blocks", sourceSystem: "beads", weight: 1 },
      { srcId: ids.get("b"), dstId: ids.get("c"), edgeType: "blocks", sourceSystem: "beads", weight: 1 },
    ]);
  });
});
