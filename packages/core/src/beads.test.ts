import { describe, expect, it } from "vitest";
import { deriveBeadsEdges, mapBeadsIssueToNode, resolveBeadsEdges, type BeadsIssue } from "./beads.js";
import { InvalidWorkItemError } from "./errors.js";

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
    });
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
