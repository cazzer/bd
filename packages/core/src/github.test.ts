import { describe, expect, it } from "vitest";
import { deriveMentionEdges, extractIssueReferences, type IssueRefSource } from "./github.js";

describe("extractIssueReferences", () => {
  it("finds a same-repo #N reference", () => {
    expect(extractIssueReferences("Follow-up from #68.")).toEqual([{ ownerRepo: null, number: 68 }]);
  });

  it("finds a cross-repo owner/repo#N reference", () => {
    expect(extractIssueReferences("Blocked by cazzer/toastd#12.")).toEqual([
      { ownerRepo: "cazzer/toastd", number: 12 },
    ]);
  });

  it("finds multiple references of both kinds in one body", () => {
    expect(extractIssueReferences("See #1, #2, and cazzer/traitor#3 for context.")).toEqual([
      { ownerRepo: "cazzer/traitor", number: 3 },
      { ownerRepo: null, number: 1 },
      { ownerRepo: null, number: 2 },
    ]);
  });

  it("ignores a reference inside an inline code span", () => {
    expect(extractIssueReferences("Not a real ref: `#42` in this sentence.")).toEqual([]);
  });

  it("ignores a reference inside a fenced code block", () => {
    const text = "Before.\n```\nsee #42 and cazzer/toastd#7\n```\nAfter, for real: #99.";
    expect(extractIssueReferences(text)).toEqual([{ ownerRepo: null, number: 99 }]);
  });

  it("ignores a reference embedded in a URL", () => {
    const text = "Full link: https://github.com/cazzer/toastd/issues/42#issuecomment-99 has no bare ref.";
    expect(extractIssueReferences(text)).toEqual([]);
  });

  it("does not double-count a cross-repo ref's trailing #N as a same-repo ref", () => {
    expect(extractIssueReferences("cazzer/toastd#12")).toEqual([{ ownerRepo: "cazzer/toastd", number: 12 }]);
  });

  it("does not match a bare number preceded by a word character", () => {
    expect(extractIssueReferences("build#42 is not a reference")).toEqual([]);
  });

  it("returns nothing for text with no references", () => {
    expect(extractIssueReferences("Plain prose, no citations at all.")).toEqual([]);
  });

  it("handles empty text", () => {
    expect(extractIssueReferences("")).toEqual([]);
  });
});

describe("deriveMentionEdges", () => {
  const known = new Set(["cazzer/toastd#1", "cazzer/toastd#2", "cazzer/traitor#5"]);

  it("resolves a same-repo reference against the issue's own repo", () => {
    const issues: IssueRefSource[] = [{ externalId: "cazzer/toastd#2", ownerRepo: "cazzer/toastd", text: "Follow-up from #1." }];
    expect(deriveMentionEdges(issues, known)).toEqual([{ srcExternalId: "cazzer/toastd#2", dstExternalId: "cazzer/toastd#1" }]);
  });

  it("resolves a cross-repo reference", () => {
    const issues: IssueRefSource[] = [
      { externalId: "cazzer/toastd#2", ownerRepo: "cazzer/toastd", text: "Blocked by cazzer/traitor#5." },
    ];
    expect(deriveMentionEdges(issues, known)).toEqual([{ srcExternalId: "cazzer/toastd#2", dstExternalId: "cazzer/traitor#5" }]);
  });

  it("skips a reference to a number that doesn't resolve to a known node (e.g. a PR or a closed issue)", () => {
    const issues: IssueRefSource[] = [
      { externalId: "cazzer/toastd#2", ownerRepo: "cazzer/toastd", text: "See #1 and #999 (not ingested) and cazzer/traitor#404." },
    ];
    expect(deriveMentionEdges(issues, known)).toEqual([{ srcExternalId: "cazzer/toastd#2", dstExternalId: "cazzer/toastd#1" }]);
  });

  it("skips a self-reference", () => {
    const issues: IssueRefSource[] = [
      { externalId: "cazzer/toastd#1", ownerRepo: "cazzer/toastd", text: "As noted in #1 already." },
    ];
    expect(deriveMentionEdges(issues, known)).toEqual([]);
  });

  it("collapses a repeated reference to the same target into one edge", () => {
    const issues: IssueRefSource[] = [
      { externalId: "cazzer/toastd#2", ownerRepo: "cazzer/toastd", text: "See #1. Really, #1 again, and once more: #1." },
    ];
    expect(deriveMentionEdges(issues, known)).toEqual([{ srcExternalId: "cazzer/toastd#2", dstExternalId: "cazzer/toastd#1" }]);
  });

  it("resolves case-insensitively but returns the known node's own casing", () => {
    const knownMixedCase = new Set(["cazzer/Tick.Dog#1"]);
    const issues: IssueRefSource[] = [
      { externalId: "cazzer/toastd#2", ownerRepo: "cazzer/toastd", text: "See cazzer/tick.dog#1." },
    ];
    expect(deriveMentionEdges(issues, knownMixedCase)).toEqual([
      { srcExternalId: "cazzer/toastd#2", dstExternalId: "cazzer/Tick.Dog#1" },
    ]);
  });

  it("produces no edges when there are no issues", () => {
    expect(deriveMentionEdges([], known)).toEqual([]);
  });
});
