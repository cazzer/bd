import { describe, expect, it } from "vitest";
import { InvalidEventTimeError } from "./errors.js";
import {
  deriveClosesEdges,
  deriveMentionEdges,
  extractIssueReferences,
  mapGhIssueToNode,
  mapGhPrToNode,
  mapGhRepoToNode,
  type GhClosingIssueReference,
  type GhIssue,
  type GhPullRequest,
  type GhRepo,
  type IssueRefSource,
  type PrClosesSource,
} from "./github.js";

const repo: GhRepo = {
  name: "toastd",
  nameWithOwner: "cazzer/toastd",
  owner: { login: "cazzer" },
  description: null,
  url: "https://github.com/cazzer/toastd",
  visibility: "PUBLIC",
  isPrivate: false,
  defaultBranchRef: { name: "main" },
  primaryLanguage: null,
  createdAt: "2024-05-06T07:08:09Z",
  updatedAt: "2026-01-02T03:04:05Z",
};

const issue: GhIssue = {
  number: 12,
  title: "Toast falls butter side down",
  body: null,
  labels: [{ name: "bug" }],
  author: { login: "cazzer" },
  createdAt: "2026-03-04T10:00:00+02:00",
  updatedAt: "2026-03-05T10:00:00Z",
  url: "https://github.com/cazzer/toastd/issues/12",
  state: "OPEN",
};

describe("mapGhRepoToNode and mapGhIssueToNode", () => {
  it("map a repository and an issue with a canonical occurred_at beside the source's createdAt (spec: loaders write the source's time)", () => {
    expect(mapGhRepoToNode(repo)).toEqual({
      nodeType: "repo",
      sourceSystem: "github",
      externalId: "cazzer/toastd",
      title: "toastd",
      content: "",
      metadata: {
        visibility: "PUBLIC",
        isPrivate: false,
        url: "https://github.com/cazzer/toastd",
        defaultBranch: "main",
        primaryLanguage: null,
        owner: "cazzer",
        createdAt: "2024-05-06T07:08:09Z",
        updatedAt: "2026-01-02T03:04:05Z",
        occurred_at: "2024-05-06T07:08:09.000Z",
      },
    });
    expect(mapGhIssueToNode("cazzer/toastd", issue)).toEqual({
      nodeType: "gh-issue",
      sourceSystem: "github",
      externalId: "cazzer/toastd#12",
      title: "Toast falls butter side down",
      content: "",
      metadata: {
        state: "OPEN",
        labels: ["bug"],
        author: "cazzer",
        createdAt: "2026-03-04T10:00:00+02:00",
        updatedAt: "2026-03-05T10:00:00Z",
        url: "https://github.com/cazzer/toastd/issues/12",
        occurred_at: "2026-03-04T08:00:00.000Z",
      },
    });
  });

  it("keep the body and description when present, and reject an unparseable createdAt naming occurred_at and the item", () => {
    expect(mapGhIssueToNode("cazzer/toastd", { ...issue, body: "See #1." }).content).toBe("See #1.");
    expect(mapGhRepoToNode({ ...repo, description: "Toast, daemonized." }).content).toBe("Toast, daemonized.");
    let thrown: unknown;
    try {
      mapGhIssueToNode("cazzer/toastd", { ...issue, createdAt: "yesterday" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(InvalidEventTimeError);
    expect((thrown as InvalidEventTimeError).message).toBe('invalid event time (github/cazzer/toastd#12): occurred_at (got "yesterday") must parse as an instant (an ISO-8601 timestamp such as 2026-03-04T08:00:00.000Z)');
    expect(() => mapGhRepoToNode({ ...repo, createdAt: "" })).toThrow(/\(github\/cazzer\/toastd\): occurred_at/);
  });
});

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

// --- Pull requests (github-prs-and-commits): one test per github-ingest scenario ---

const pr: GhPullRequest = {
  number: 40,
  title: "Butter the other side",
  body: "Fixes #12.",
  state: "MERGED",
  isDraft: false,
  mergedAt: "2026-03-06T09:00:00Z",
  closedAt: "2026-03-06T09:00:00Z",
  createdAt: "2026-03-05T12:30:00+02:00",
  updatedAt: "2026-03-06T09:00:01Z",
  author: { login: "cazzer" },
  headRefName: "fix/butter-side",
  baseRefName: "main",
  url: "https://github.com/cazzer/toastd/pull/40",
  labels: [{ name: "bug" }],
  closingIssuesReferences: [{ number: 12, repository: { name: "toastd", owner: { login: "cazzer" } } }],
};

/** A closing reference as `gh` shapes it, into `cazzer/<repo>#<number>`. */
function closing(repo: string, number: number): GhClosingIssueReference {
  return { number, repository: { name: repo, owner: { login: "cazzer" } } };
}

describe("mapGhPrToNode", () => {
  it("maps a merged pull request under the issue id scheme, its merge instant in metadata and occurred_at at its creation, canonical (spec: A merged pull request that closes an issue)", () => {
    expect(mapGhPrToNode("cazzer/toastd", pr)).toEqual({
      nodeType: "gh-pr",
      sourceSystem: "github",
      externalId: "cazzer/toastd#40",
      title: "Butter the other side",
      content: "Fixes #12.",
      metadata: {
        state: "MERGED",
        isDraft: false,
        mergedAt: "2026-03-06T09:00:00Z",
        closedAt: "2026-03-06T09:00:00Z",
        createdAt: "2026-03-05T12:30:00+02:00",
        updatedAt: "2026-03-06T09:00:01Z",
        author: "cazzer",
        headRefName: "fix/butter-side",
        baseRefName: "main",
        url: "https://github.com/cazzer/toastd/pull/40",
        labels: ["bug"],
        occurred_at: "2026-03-05T10:30:00.000Z",
      },
    });
  });

  it("keeps an open draft's null merge and close instants and absent body and author, and rejects an unparseable createdAt naming the pull request", () => {
    const open = mapGhPrToNode("cazzer/toastd", { ...pr, state: "OPEN", isDraft: true, mergedAt: null, closedAt: null, body: null, author: null, labels: [] });
    expect(open.content).toBe("");
    expect(open.metadata).toMatchObject({ state: "OPEN", isDraft: true, mergedAt: null, closedAt: null, author: null, labels: [], occurred_at: "2026-03-05T10:30:00.000Z" });
    expect(() => mapGhPrToNode("cazzer/toastd", { ...pr, createdAt: "yesterday" })).toThrow(InvalidEventTimeError);
    expect(() => mapGhPrToNode("cazzer/toastd", { ...pr, createdAt: "yesterday" })).toThrow(/\(github\/cazzer\/toastd#40\): occurred_at/);
  });

  it("gives issue #12 and pull request #40 ids that cannot collide, owner/name#12 and owner/name#40 (spec: Numbers do not collide)", () => {
    expect(mapGhIssueToNode("cazzer/toastd", issue).externalId).toBe("cazzer/toastd#12");
    expect(mapGhPrToNode("cazzer/toastd", pr).externalId).toBe("cazzer/toastd#40");
  });
});

describe("deriveClosesEdges", () => {
  const known = new Set(["cazzer/toastd#12", "cazzer/toastd#40", "cazzer/traitor#5"]);

  it("writes one closes edge per reference naming a loaded issue and counts a reference to an unloaded one as skipped (spec: A pull request closing an issue that is not loaded)", () => {
    const prs: PrClosesSource[] = [
      { externalId: "cazzer/toastd#40", closingIssuesReferences: [closing("toastd", 12), closing("toastd", 9999)] },
      { externalId: "cazzer/toastd#41", closingIssuesReferences: [closing("toastd", 9998)] },
      { externalId: "cazzer/toastd#42", closingIssuesReferences: [] },
    ];
    expect(deriveClosesEdges(prs, known)).toEqual({
      edges: [{ srcExternalId: "cazzer/toastd#40", dstExternalId: "cazzer/toastd#12" }],
      skipped: 2,
    });
  });

  it("resolves a reference by the repository GitHub names on it, case-insensitively, never by the pull request's own repository", () => {
    const prs: PrClosesSource[] = [
      {
        externalId: "cazzer/toastd#40",
        closingIssuesReferences: [
          { number: 5, repository: { name: "Traitor", owner: { login: "Cazzer" } } },
          // Same number in the PR's own repository: not loaded, so skipped.
          closing("toastd", 5),
        ],
      },
    ];
    expect(deriveClosesEdges(prs, known)).toEqual({
      edges: [{ srcExternalId: "cazzer/toastd#40", dstExternalId: "cazzer/traitor#5" }],
      skipped: 1,
    });
  });

  it("collapses a repeated reference to one target into one edge, and produces nothing for no pull requests", () => {
    const prs: PrClosesSource[] = [{ externalId: "cazzer/toastd#40", closingIssuesReferences: [closing("toastd", 12), closing("toastd", 12)] }];
    expect(deriveClosesEdges(prs, known)).toEqual({
      edges: [{ srcExternalId: "cazzer/toastd#40", dstExternalId: "cazzer/toastd#12" }],
      skipped: 0,
    });
    expect(deriveClosesEdges([], known)).toEqual({ edges: [], skipped: 0 });
  });
});

describe("deriveMentionEdges over issues and pull requests together", () => {
  const known = new Set(["cazzer/toastd#12", "cazzer/toastd#40"]);

  it("resolves an issue mentioning a pull request and a pull request mentioning an issue, each to whichever #N names (spec: An issue mentions a pull request; Numbers do not collide)", () => {
    const sources: IssueRefSource[] = [
      { externalId: "cazzer/toastd#12", ownerRepo: "cazzer/toastd", text: "Toast falls butter side down\n\nfixed by #40" },
      { externalId: "cazzer/toastd#40", ownerRepo: "cazzer/toastd", text: "Butter the other side\n\nFixes #12." },
    ];
    expect(deriveMentionEdges(sources, known)).toEqual([
      { srcExternalId: "cazzer/toastd#12", dstExternalId: "cazzer/toastd#40" },
      { srcExternalId: "cazzer/toastd#40", dstExternalId: "cazzer/toastd#12" },
    ]);
  });

  it("skips a pull request's self-reference and repeated references, and a #N inside a code span (spec: A reference in a code span)", () => {
    const sources: IssueRefSource[] = [
      { externalId: "cazzer/toastd#40", ownerRepo: "cazzer/toastd", text: "See #12, #12 again, and #40 itself." },
      { externalId: "cazzer/toastd#12", ownerRepo: "cazzer/toastd", text: "Run `#40` — quoted as code, not cited." },
    ];
    expect(deriveMentionEdges(sources, known)).toEqual([{ srcExternalId: "cazzer/toastd#40", dstExternalId: "cazzer/toastd#12" }]);
  });

  it("skips a reference to a number that is neither an issue nor a pull request the loader wrote (spec: A reference to something not loaded)", () => {
    const sources: IssueRefSource[] = [{ externalId: "cazzer/toastd#12", ownerRepo: "cazzer/toastd", text: "Blocked on #9999." }];
    expect(deriveMentionEdges(sources, known)).toEqual([]);
  });
});
