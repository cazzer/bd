import { describe, expect, it } from "vitest";
import {
  combineEdgeCandidates,
  deriveNodeType,
  deriveStructuralEdges,
  deriveTitle,
  extractMarkdownLinkTargets,
  LINKS_TO_WEIGHT,
  PART_OF_CHANGE_WEIGHT,
  SIBLING_WEIGHT,
  type EdgeCandidate,
} from "./corpus.js";

describe("deriveNodeType", () => {
  it("types a docs/ file as doc", () => {
    expect(deriveNodeType("docs/architecture-handoff.md")).toBe("doc");
  });

  it("types an OpenSpec change's README", () => {
    expect(deriveNodeType("openspec/changes/add-knowledge-graph-core/README.md")).toBe("openspec-readme");
  });

  it("types proposal.md, design.md, tasks.md distinctly", () => {
    expect(deriveNodeType("openspec/changes/add-knowledge-graph-core/proposal.md")).toBe("openspec-proposal");
    expect(deriveNodeType("openspec/changes/add-knowledge-graph-core/design.md")).toBe("openspec-design");
    expect(deriveNodeType("openspec/changes/add-knowledge-graph-core/tasks.md")).toBe("openspec-tasks");
  });

  it("types a change's capability spec", () => {
    expect(deriveNodeType("openspec/changes/add-knowledge-graph-core/specs/retrieval/spec.md")).toBe("openspec-spec");
  });

  it("types an archived (post-change) capability spec the same way", () => {
    expect(deriveNodeType("openspec/specs/retrieval/spec.md")).toBe("openspec-spec");
  });

  it("falls back to doc for an unrecognized path rather than throwing", () => {
    expect(deriveNodeType("openspec/config.yaml.md")).toBe("doc");
    expect(deriveNodeType("docs/sub/dir/notes.md")).toBe("doc");
  });
});

describe("deriveTitle", () => {
  it("uses the document's first H1", () => {
    expect(deriveTitle("docs/architecture-handoff.md", "# Personal Brain — Architecture Handoff\n\nBody.")).toBe(
      "Personal Brain — Architecture Handoff",
    );
  });

  it("uses the first H1 even when a later H1 appears deeper in the document", () => {
    const content = "# First Title\n\nBody.\n\n---\n\n# Second Title\n";
    expect(deriveTitle("docs/architecture-handoff.md", content)).toBe("First Title");
  });

  it("does not match H2/H3 headings as an H1", () => {
    expect(deriveTitle("openspec/changes/add-knowledge-graph-core/proposal.md", "## Why\n\nBody.")).toBe(
      "add-knowledge-graph-core: Proposal",
    );
  });

  it("synthesizes a title for proposal.md/design.md/tasks.md, which conventionally have no H1", () => {
    expect(deriveTitle("openspec/changes/add-knowledge-graph-core/proposal.md", "## Why\n")).toBe(
      "add-knowledge-graph-core: Proposal",
    );
    expect(deriveTitle("openspec/changes/add-knowledge-graph-core/design.md", "## Context\n")).toBe(
      "add-knowledge-graph-core: Design",
    );
    expect(deriveTitle("openspec/changes/add-knowledge-graph-core/tasks.md", "## 1. Workspace\n")).toBe(
      "add-knowledge-graph-core: Tasks",
    );
  });

  it("synthesizes a title for a capability spec, including its capability name", () => {
    expect(deriveTitle("openspec/changes/add-knowledge-graph-core/specs/retrieval/spec.md", "## Purpose\n")).toBe(
      "add-knowledge-graph-core: retrieval spec",
    );
  });

  it("synthesizes a title for an archived spec", () => {
    expect(deriveTitle("openspec/specs/retrieval/spec.md", "## Purpose\n")).toBe("retrieval spec");
  });

  it("falls back to the path itself when nothing else applies", () => {
    expect(deriveTitle("docs/notes.md", "no heading here")).toBe("docs/notes.md");
  });
});

describe("extractMarkdownLinkTargets", () => {
  it("resolves a relative link against the source file's directory", () => {
    const content = "See [the design](../../design.md) for details.";
    expect(extractMarkdownLinkTargets("openspec/changes/x/specs/y/spec.md", content)).toEqual([
      "openspec/changes/x/design.md",
    ]);
  });

  it("resolves a same-directory link", () => {
    const content = "See [tasks](tasks.md).";
    expect(extractMarkdownLinkTargets("openspec/changes/x/proposal.md", content)).toEqual([
      "openspec/changes/x/tasks.md",
    ]);
  });

  it("treats a leading slash as repo-root-relative", () => {
    const content = "See [handoff](/docs/architecture-handoff.md).";
    expect(extractMarkdownLinkTargets("openspec/changes/x/design.md", content)).toEqual([
      "docs/architecture-handoff.md",
    ]);
  });

  it("ignores external links (http/https/mailto)", () => {
    const content = "[web](https://example.com/x.md) and [mail](mailto:a@b.com)";
    expect(extractMarkdownLinkTargets("docs/a.md", content)).toEqual([]);
  });

  it("ignores pure same-document anchors", () => {
    expect(extractMarkdownLinkTargets("docs/a.md", "[section](#some-section)")).toEqual([]);
  });

  it("strips a fragment or query suffix off an otherwise-relative link", () => {
    const content = "[design](../../design.md#decisions) and [q](../../design.md?x=1)";
    const targets = extractMarkdownLinkTargets("openspec/changes/x/specs/y/spec.md", content);
    expect(targets).toEqual(["openspec/changes/x/design.md"]);
  });

  it("drops a link that resolves above the repo root", () => {
    expect(extractMarkdownLinkTargets("docs/a.md", "[up](../../../outside.md)")).toEqual([]);
  });

  it("dedupes repeated links to the same target", () => {
    const content = "[a](tasks.md) and again [b](tasks.md)";
    expect(extractMarkdownLinkTargets("openspec/changes/x/proposal.md", content)).toEqual([
      "openspec/changes/x/tasks.md",
    ]);
  });

  it("returns nothing for a document with no links", () => {
    expect(extractMarkdownLinkTargets("docs/a.md", "# Title\n\nJust prose, no links.")).toEqual([]);
  });
});

describe("deriveStructuralEdges", () => {
  const corpus = [
    "docs/architecture-handoff.md",
    "docs/retrieval-query-design.md",
    "openspec/changes/add-knowledge-graph-core/README.md",
    "openspec/changes/add-knowledge-graph-core/proposal.md",
    "openspec/changes/add-knowledge-graph-core/design.md",
    "openspec/changes/add-knowledge-graph-core/tasks.md",
    "openspec/changes/add-knowledge-graph-core/specs/brain-mcp/spec.md",
    "openspec/changes/add-knowledge-graph-core/specs/knowledge-store/spec.md",
    "openspec/changes/add-knowledge-graph-core/specs/retrieval/spec.md",
  ];

  function has(edges: EdgeCandidate[], a: string, b: string, edgeType: string): boolean {
    return edges.some(
      (e) => e.edgeType === edgeType && ((e.srcPath === a && e.dstPath === b) || (e.srcPath === b && e.dstPath === a)),
    );
  }

  it("connects every pair of the change's top-level artifacts (README/proposal/design/tasks)", () => {
    const edges = deriveStructuralEdges(corpus);
    const topLevel = [
      "openspec/changes/add-knowledge-graph-core/README.md",
      "openspec/changes/add-knowledge-graph-core/proposal.md",
      "openspec/changes/add-knowledge-graph-core/design.md",
      "openspec/changes/add-knowledge-graph-core/tasks.md",
    ];
    for (let i = 0; i < topLevel.length; i += 1) {
      for (let j = i + 1; j < topLevel.length; j += 1) {
        expect(has(edges, topLevel[i]!, topLevel[j]!, "part-of-change")).toBe(true);
      }
    }
  });

  it("links each capability spec to the change's proposal, design, and tasks — not to README or other specs", () => {
    const edges = deriveStructuralEdges(corpus);
    const spec = "openspec/changes/add-knowledge-graph-core/specs/retrieval/spec.md";
    expect(has(edges, spec, "openspec/changes/add-knowledge-graph-core/proposal.md", "part-of-change")).toBe(true);
    expect(has(edges, spec, "openspec/changes/add-knowledge-graph-core/design.md", "part-of-change")).toBe(true);
    expect(has(edges, spec, "openspec/changes/add-knowledge-graph-core/tasks.md", "part-of-change")).toBe(true);
    expect(has(edges, spec, "openspec/changes/add-knowledge-graph-core/README.md", "part-of-change")).toBe(false);
    expect(
      has(edges, spec, "openspec/changes/add-knowledge-graph-core/specs/brain-mcp/spec.md", "part-of-change"),
    ).toBe(false);
  });

  it("links the two docs/ files as siblings, since they share no OpenSpec change", () => {
    const edges = deriveStructuralEdges(corpus);
    expect(has(edges, "docs/architecture-handoff.md", "docs/retrieval-query-design.md", "sibling")).toBe(true);
  });

  it("never gives a pair both a part-of-change and a sibling edge", () => {
    const edges = deriveStructuralEdges(corpus);
    const seen = new Set<string>();
    for (const e of edges) {
      const key = [e.srcPath, e.dstPath].sort().join("|");
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it("produces exactly the expected edge count and weights for the real corpus shape", () => {
    const edges = deriveStructuralEdges(corpus);
    // 6 pairs among {README, proposal, design, tasks} + 3 specs * 3 hubs each + 1 docs sibling pair.
    expect(edges.length).toBe(6 + 3 * 3 + 1);
    expect(edges.filter((e) => e.edgeType === "part-of-change")).toHaveLength(15);
    expect(edges.filter((e) => e.edgeType === "sibling")).toHaveLength(1);
    for (const e of edges) {
      expect(e.weight).toBe(e.edgeType === "part-of-change" ? PART_OF_CHANGE_WEIGHT : SIBLING_WEIGHT);
    }
  });

  it("does not cross-link two different OpenSpec changes", () => {
    const twoChanges = [
      "openspec/changes/a/proposal.md",
      "openspec/changes/a/design.md",
      "openspec/changes/b/proposal.md",
      "openspec/changes/b/design.md",
    ];
    const edges = deriveStructuralEdges(twoChanges);
    expect(has(edges, "openspec/changes/a/proposal.md", "openspec/changes/b/proposal.md", "part-of-change")).toBe(
      false,
    );
    expect(edges).toHaveLength(2); // one pair within "a", one within "b"
  });

  it("degrades without crashing when a change has no proposal.md", () => {
    const noProposal = ["openspec/changes/x/design.md", "openspec/changes/x/specs/y/spec.md"];
    const edges = deriveStructuralEdges(noProposal);
    expect(has(edges, "openspec/changes/x/design.md", "openspec/changes/x/specs/y/spec.md", "part-of-change")).toBe(
      true,
    );
  });

  it("produces no edges for a single isolated file", () => {
    expect(deriveStructuralEdges(["docs/only-file.md"])).toEqual([]);
  });
});

describe("combineEdgeCandidates", () => {
  it("keeps every explicit link, in whichever direction it was written", () => {
    const links: EdgeCandidate[] = [
      { srcPath: "a.md", dstPath: "b.md", edgeType: "links-to", weight: LINKS_TO_WEIGHT },
      { srcPath: "b.md", dstPath: "a.md", edgeType: "links-to", weight: LINKS_TO_WEIGHT },
    ];
    const combined = combineEdgeCandidates(links, []);
    expect(combined).toEqual(links);
  });

  it("drops a structural edge for a pair an explicit link already connects", () => {
    const links: EdgeCandidate[] = [{ srcPath: "a.md", dstPath: "b.md", edgeType: "links-to", weight: LINKS_TO_WEIGHT }];
    const structural: EdgeCandidate[] = [
      { srcPath: "b.md", dstPath: "a.md", edgeType: "sibling", weight: SIBLING_WEIGHT },
      { srcPath: "a.md", dstPath: "c.md", edgeType: "sibling", weight: SIBLING_WEIGHT },
    ];
    const combined = combineEdgeCandidates(links, structural);
    expect(combined).toEqual([links[0], structural[1]]);
  });

  it("returns only structural edges when there are no links", () => {
    const structural: EdgeCandidate[] = [{ srcPath: "a.md", dstPath: "b.md", edgeType: "sibling", weight: SIBLING_WEIGHT }];
    expect(combineEdgeCandidates([], structural)).toEqual(structural);
  });
});
