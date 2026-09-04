// Pure helpers for the GitHub repos/issues/pull-requests loader (bd-5hd;
// pull requests in github-prs-and-commits) — turning `gh` JSON output into
// knowledge-store node/edge shapes, resolving the issues GitHub records a
// pull request as closing, and parsing cross-references (`#N`,
// `owner/repo#N`) out of issue and pull-request text. Orchestration
// (invoking `gh`, opening an ingest run, calling
// upsertNodes/upsertEdges/closeIngestRun) stays in src/ingest-github.ts,
// which is a script, not a library; everything here is a pure function
// over already-fetched strings, unit-testable without a database or `gh`
// itself — the same split corpus.ts uses for the markdown seed loader.
//
// A repository's, an issue's, and a pull request's `createdAt` are also
// written as `occurred_at` through `normalizeOccurredAt` (timeline-view
// design.md decision 2), the existing `createdAt`/`updatedAt` keys kept
// beside it. A pull request sits at its creation, not its merge — a merged
// PR at its merge instant would move on merge and sort a still-open one by
// a different rule (github-prs-and-commits design.md decision 1); its
// `mergedAt`/`closedAt` are in metadata for a later per-node fan-out.

import { normalizeOccurredAt, OCCURRED_AT_KEY } from "./event-time.js";
import type { NodeInput } from "./nodes.js";

/** `source_system` for every node/edge this loader writes — deliberately distinct from the markdown seed's `"repo"`, per bd-5hd: a second source system means edges finally render in more than one colour, and this loader's writes can never collide with the doc corpus on the `(source_system, external_id)` dedup key. */
export const GITHUB_SOURCE_SYSTEM = "github";

export const REPO_NODE_TYPE = "repo";
export const ISSUE_NODE_TYPE = "gh-issue";
/** A pull request in any state, keyed exactly as an issue is (`owner/repo#N`): GitHub numbers issues and pull requests from one sequence, so the id is already unique and a `#N` in prose resolves to whichever exists. */
export const PR_NODE_TYPE = "gh-pr";

/** issue -> its repo. Structural, so weight 1.0. */
export const BELONGS_TO_EDGE_TYPE = "belongs-to";
export const BELONGS_TO_WEIGHT = 1.0;

/** issue or PR -> issue or PR, parsed from a `#N` / `owner/repo#N` cross-reference. An explicit citation is strong evidence, but not a declaration of equivalence — weight 0.8, not 1.0. */
export const MENTIONS_EDGE_TYPE = "mentions";
export const MENTIONS_WEIGHT = 0.8;

/** PR -> the issue GitHub itself records it as closing (`closingIssuesReferences`, GitHub's parse of a `closes #N` keyword). The source's own assertion, so full weight like `belongs-to` — and heavier than `mentions`, so a PR that both closes and mentions an issue reads `closes` on the issue's timeline (github-prs-and-commits design.md decision 5). */
export const CLOSES_EDGE_TYPE = "closes";
export const CLOSES_WEIGHT = 1.0;

// --- gh JSON shapes and node mappings -----------------------------------

/** The subset of `gh repo view --json` this loader reads. */
export interface GhRepo {
  name: string;
  nameWithOwner: string;
  owner: { login: string };
  description: string | null;
  url: string;
  visibility: string;
  isPrivate: boolean;
  defaultBranchRef: { name: string } | null;
  primaryLanguage: { name: string } | null;
  createdAt: string;
  updatedAt: string;
}

/** The subset of `gh issue list --json` this loader reads. */
export interface GhIssue {
  number: number;
  title: string;
  body: string | null;
  labels: { name: string }[];
  author: { login: string } | null;
  createdAt: string;
  updatedAt: string;
  url: string;
  state: string;
}

/** Maps one repository to a `repo` node keyed by its `owner/repo` slug. Throws `InvalidEventTimeError` when `createdAt` does not parse. */
export function mapGhRepoToNode(repo: GhRepo): NodeInput {
  return {
    nodeType: REPO_NODE_TYPE,
    sourceSystem: GITHUB_SOURCE_SYSTEM,
    externalId: repo.nameWithOwner,
    title: repo.name,
    // A repo can genuinely have no description — `gh` reports that as
    // `""`, not `null`, but handle both rather than assume the shape.
    content: repo.description ?? "",
    metadata: normalizeOccurredAt({
      visibility: repo.visibility,
      isPrivate: repo.isPrivate,
      url: repo.url,
      defaultBranch: repo.defaultBranchRef?.name ?? null,
      primaryLanguage: repo.primaryLanguage?.name ?? null,
      owner: repo.owner.login,
      createdAt: repo.createdAt,
      updatedAt: repo.updatedAt,
      [OCCURRED_AT_KEY]: repo.createdAt,
    }, { itemLabel: `(${GITHUB_SOURCE_SYSTEM}/${repo.nameWithOwner})` }),
  };
}

/** Maps one open issue of repository `slug` to a `gh-issue` node keyed `owner/repo#N`. Throws `InvalidEventTimeError` when `createdAt` does not parse. */
export function mapGhIssueToNode(slug: string, issue: GhIssue): NodeInput {
  const externalId = `${slug}#${issue.number}`;
  return {
    nodeType: ISSUE_NODE_TYPE,
    sourceSystem: GITHUB_SOURCE_SYSTEM,
    externalId,
    title: issue.title,
    // Content is the issue body — this is the point of this loader
    // (bd-5hd: "this matters, it's what finally gives search real
    // prose to match against"). A body can be null (no description
    // given) — handled explicitly, not assumed present.
    content: issue.body ?? "",
    metadata: normalizeOccurredAt({
      state: issue.state,
      labels: issue.labels.map((l) => l.name),
      author: issue.author?.login ?? null,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
      url: issue.url,
      [OCCURRED_AT_KEY]: issue.createdAt,
    }, { itemLabel: `(${GITHUB_SOURCE_SYSTEM}/${externalId})` }),
  };
}

/**
 * One entry of `gh pr list --json closingIssuesReferences`: the issue's
 * number and its own repository. A pull request can close an issue in
 * another repository (`closes owner/other#N`), so a reference resolves by
 * the repository it names, never by the pull request's.
 */
export interface GhClosingIssueReference {
  number: number;
  repository: { name: string; owner: { login: string } };
}

/** The subset of `gh pr list --json` this loader reads. `state` is `OPEN`, `CLOSED`, or `MERGED`; `mergedAt`/`closedAt` are `null` until they happen. */
export interface GhPullRequest {
  number: number;
  title: string;
  body: string | null;
  state: string;
  isDraft: boolean;
  mergedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
  author: { login: string } | null;
  headRefName: string;
  baseRefName: string;
  url: string;
  labels: { name: string }[];
  closingIssuesReferences: GhClosingIssueReference[];
}

/** Maps one pull request of repository `slug` to a `gh-pr` node keyed `owner/repo#N`, `occurred_at` at its creation. Throws `InvalidEventTimeError` when `createdAt` does not parse. */
export function mapGhPrToNode(slug: string, pr: GhPullRequest): NodeInput {
  const externalId = `${slug}#${pr.number}`;
  return {
    nodeType: PR_NODE_TYPE,
    sourceSystem: GITHUB_SOURCE_SYSTEM,
    externalId,
    title: pr.title,
    // The body is the content, as for an issue — and null when none was
    // given, handled the same way.
    content: pr.body ?? "",
    metadata: normalizeOccurredAt({
      state: pr.state,
      isDraft: pr.isDraft,
      mergedAt: pr.mergedAt,
      closedAt: pr.closedAt,
      createdAt: pr.createdAt,
      updatedAt: pr.updatedAt,
      author: pr.author?.login ?? null,
      headRefName: pr.headRefName,
      baseRefName: pr.baseRefName,
      url: pr.url,
      labels: pr.labels.map((l) => l.name),
      [OCCURRED_AT_KEY]: pr.createdAt,
    }, { itemLabel: `(${GITHUB_SOURCE_SYSTEM}/${externalId})` }),
  };
}

// --- Closing references -----------------------------------------------

/** One ingested pull request's identity and GitHub's closing references for it, as `deriveClosesEdges` needs it. */
export interface PrClosesSource {
  /** This pull request's own `owner/repo#N` external id. */
  externalId: string;
  /** `closingIssuesReferences` as `gh` returned them, each naming its own repository. */
  closingIssuesReferences: readonly GhClosingIssueReference[];
}

/** One resolved `closes` edge candidate, by external id (not yet a node id — the caller maps that). */
export interface ClosesEdgeCandidate {
  srcExternalId: string;
  dstExternalId: string;
}

export interface DeriveClosesEdgesResult {
  edges: ClosesEdgeCandidate[];
  /** Distinct (pull request, target) pairs whose target the loader did not write in this run — a closed issue, almost always, since only open ones are loaded. Counted per pair as `edges` is, not per occurrence; skipped, never fatal (github-ingest spec, "A pull request closing an issue that is not loaded"). */
  skipped: number;
}

/**
 * Resolves every pull request's `closingIssuesReferences` against the set
 * of external ids actually written this run (`knownExternalIds` — issues
 * and pull requests both), producing `closes` edge candidates. Each
 * reference resolves by the repository GitHub names on it, so a cross-
 * repository close lands on the right issue; case-insensitively on the
 * slug, like `deriveMentionEdges`, returning the known node's own casing.
 * A repeated reference to one target collapses first, so it is one edge
 * or one `skipped`, never two of either; a reference that resolves to
 * nothing is counted in `skipped`. No self-reference guard: GitHub cannot
 * record a pull request as closing itself.
 */
export function deriveClosesEdges(
  prs: readonly PrClosesSource[],
  knownExternalIds: ReadonlySet<string>,
): DeriveClosesEdgesResult {
  const byLower = new Map<string, string>();
  for (const id of knownExternalIds) byLower.set(id.toLowerCase(), id);

  const seenPairs = new Set<string>();
  const edges: ClosesEdgeCandidate[] = [];
  let skipped = 0;

  for (const pr of prs) {
    for (const ref of pr.closingIssuesReferences) {
      const candidateId = `${ref.repository.owner.login}/${ref.repository.name}#${ref.number}`.toLowerCase();
      const pairKey = `${pr.externalId} ${candidateId}`;
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);

      const resolved = byLower.get(candidateId);
      if (!resolved) {
        skipped += 1;
        continue;
      }

      edges.push({ srcExternalId: pr.externalId, dstExternalId: resolved });
    }
  }

  return { edges, skipped };
}

// --- Cross-reference parsing -------------------------------------------

/** A `#N` or `owner/repo#N` reference found in issue text. `ownerRepo` is `null` for a same-repo `#N` reference — the caller resolves it against whichever issue the text came from. */
export interface ParsedReference {
  ownerRepo: string | null;
  number: number;
}

// Fenced code blocks first (may themselves contain backticks/URLs), then
// inline code spans, then bare URLs — each replaced with same-length
// whitespace (not deleted) so match offsets and word boundaries elsewhere
// in the string never shift.
const FENCED_CODE_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`[^`\n]*`/g;
const URL_RE = /https?:\/\/\S+/g;

// `owner/repo#N`: a GitHub-shaped `owner/repo` slug immediately followed
// by `#` and digits. Matched (and masked out) before the same-repo
// pattern so its trailing `#N` is never double-counted as a same-repo ref.
const CROSS_REPO_REF_RE = /\b([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)#(\d+)\b/g;

// `#N` not preceded by a word character or `/` — the `/` exclusion is
// what keeps a cross-repo ref's `#N` tail from also matching here even if
// masking above somehow missed it; the word-character exclusion keeps
// something like `abc#42` (not a GitHub reference syntax) from counting.
const SAME_REPO_REF_RE = /(?<![\w/])#(\d+)\b/g;

function blank(match: string): string {
  return " ".repeat(match.length);
}

/**
 * Extracts every `#N` and `owner/repo#N` reference from free-form issue
 * text (title, body, or both concatenated). Ignores:
 * - anything inside a fenced (```) or inline (`) code span — a reference
 *   quoted as code, not asserted as a real citation;
 * - anything inside a bare `http(s)://` URL — a reference embedded in a
 *   link target rather than written as prose.
 *
 * Does not check that the referenced issue exists or was ingested — that
 * resolution (and the "skip a reference that doesn't resolve to a node we
 * wrote" rule) is `deriveMentionEdges`'s job, not this function's.
 */
export function extractIssueReferences(text: string): ParsedReference[] {
  let sanitized = text.replace(FENCED_CODE_RE, blank).replace(INLINE_CODE_RE, blank).replace(URL_RE, blank);

  const refs: ParsedReference[] = [];
  const claimed: Array<[number, number]> = [];

  for (const m of sanitized.matchAll(CROSS_REPO_REF_RE)) {
    refs.push({ ownerRepo: m[1]!, number: Number(m[2]) });
    claimed.push([m.index!, m.index! + m[0].length]);
  }
  for (const [start, end] of claimed) {
    sanitized = sanitized.slice(0, start) + " ".repeat(end - start) + sanitized.slice(end);
  }

  for (const m of sanitized.matchAll(SAME_REPO_REF_RE)) {
    refs.push({ ownerRepo: null, number: Number(m[1]) });
  }

  return refs;
}

/** One ingested issue's or pull request's identity and the text to scan for references, as `deriveMentionEdges` needs it — the two share the id scheme, so one shape serves both. */
export interface IssueRefSource {
  /** This item's own `owner/repo#N` external id. */
  externalId: string;
  /** This item's own repo, as `owner/repo` — what a same-repo `#N` reference resolves against. */
  ownerRepo: string;
  /** Text to scan — title and body concatenated is the intended use. */
  text: string;
}

/** One resolved `mentions` edge candidate, by external id (not yet a node id — the caller maps that). */
export interface MentionEdgeCandidate {
  srcExternalId: string;
  dstExternalId: string;
}

/**
 * Resolves every item's parsed references against the set of external ids
 * actually ingested (`knownIssueExternalIds` — issues and pull requests
 * both, since github-prs-and-commits; the parameter keeps its name), producing
 * `mentions` edge candidates. A reference that doesn't resolve to a known
 * node — most commonly a closed issue, which this loader does not write —
 * is silently skipped, per bd-5hd: "skip a reference that doesn't resolve
 * to a node you wrote, rather than erroring or creating a dangling edge."
 * A self-reference (an item citing its own number) and a repeated
 * reference to the same target within one item are both collapsed rather
 * than duplicated — `upsertEdges` would reject a literal duplicate
 * `(src, dst, edgeType, sourceSystem)` pair within one batch.
 *
 * Resolution is case-insensitive on `owner/repo` (GitHub slugs are), but
 * the returned `dstExternalId` always uses the known node's own casing.
 */
export function deriveMentionEdges(
  issues: readonly IssueRefSource[],
  knownIssueExternalIds: ReadonlySet<string>,
): MentionEdgeCandidate[] {
  const byLower = new Map<string, string>();
  for (const id of knownIssueExternalIds) byLower.set(id.toLowerCase(), id);

  const seenPairs = new Set<string>();
  const result: MentionEdgeCandidate[] = [];

  for (const issue of issues) {
    for (const ref of extractIssueReferences(issue.text)) {
      const ownerRepo = ref.ownerRepo ?? issue.ownerRepo;
      const candidateId = `${ownerRepo}#${ref.number}`;
      const resolved = byLower.get(candidateId.toLowerCase());
      if (!resolved) continue;
      if (resolved === issue.externalId) continue;

      const pairKey = `${issue.externalId} ${resolved}`;
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);

      result.push({ srcExternalId: issue.externalId, dstExternalId: resolved });
    }
  }

  return result;
}
