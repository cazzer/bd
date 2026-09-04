// Pure helpers for the GitHub repos/issues loader (bd-5hd) — turning `gh`
// JSON output into knowledge-store node/edge shapes, and parsing issue
// cross-references (`#N`, `owner/repo#N`) out of issue text. Orchestration
// (invoking `gh`, opening an ingest run, calling
// upsertNodes/upsertEdges/closeIngestRun) stays in src/ingest-github.ts,
// which is a script, not a library; everything here is a pure function
// over already-fetched strings, unit-testable without a database or `gh`
// itself — the same split corpus.ts uses for the markdown seed loader.
//
// A repository's and an issue's `createdAt` are also written as
// `occurred_at` through `normalizeOccurredAt` (timeline-view design.md
// decision 2), the existing `createdAt`/`updatedAt` keys kept beside it.

import { normalizeOccurredAt, OCCURRED_AT_KEY } from "./event-time.js";
import type { NodeInput } from "./nodes.js";

/** `source_system` for every node/edge this loader writes — deliberately distinct from the markdown seed's `"repo"`, per bd-5hd: a second source system means edges finally render in more than one colour, and this loader's writes can never collide with the doc corpus on the `(source_system, external_id)` dedup key. */
export const GITHUB_SOURCE_SYSTEM = "github";

export const REPO_NODE_TYPE = "repo";
export const ISSUE_NODE_TYPE = "gh-issue";

/** issue -> its repo. Structural, so weight 1.0. */
export const BELONGS_TO_EDGE_TYPE = "belongs-to";
export const BELONGS_TO_WEIGHT = 1.0;

/** issue -> issue, parsed from a `#N` / `owner/repo#N` cross-reference. An explicit citation is strong evidence, but not a declaration of equivalence — weight 0.8, not 1.0. */
export const MENTIONS_EDGE_TYPE = "mentions";
export const MENTIONS_WEIGHT = 0.8;

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

/** One ingested issue's identity and the text to scan for references, as `deriveMentionEdges` needs it. */
export interface IssueRefSource {
  /** This issue's own `owner/repo#N` external id. */
  externalId: string;
  /** This issue's own repo, as `owner/repo` — what a same-repo `#N` reference resolves against. */
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
 * Resolves every issue's parsed references against the set of issue
 * external ids actually ingested (`knownIssueExternalIds`), producing
 * `mentions` edge candidates. A reference that doesn't resolve to a known
 * node — most commonly a pull request or a closed issue, neither written
 * by this loader — is silently skipped, per bd-5hd: "skip a reference
 * that doesn't resolve to a node you wrote, rather than erroring or
 * creating a dangling edge." A self-reference (an issue citing its own
 * number) and a repeated reference to the same target within one issue
 * are both collapsed rather than duplicated — `upsertEdges` would reject
 * a literal duplicate `(src, dst, edgeType, sourceSystem)` pair within one
 * batch.
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
