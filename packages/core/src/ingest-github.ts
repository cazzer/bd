// `pnpm ingest:github` (bd-5hd; pull requests in github-prs-and-commits):
// loads this user's GitHub repositories, their open issues, and their pull
// requests in every state into the knowledge store, `source_system =
// 'github'` — a second source system, deliberately distinct from the
// markdown seed's `'repo'` so edges from real, semantic content
// (`mentions`, parsed from actual issue and PR prose; `closes`, from
// GitHub's own record of what a PR closes) render in more than one colour
// and can never collide with the doc corpus on the `(source_system,
// external_id)` dedup key.
//
// A script, not a library — reusable logic (reference parsing, closing-
// reference resolution, node/edge type names and weights) lives in
// github.ts and is exported from the package's public API; this file only
// shells out to `gh`, walks its JSON, and calls the public write-path API
// (openIngestRun/upsertNodes/upsertEdges/closeIngestRun) — matching
// seed.ts's split for the markdown loader. Nothing below connects to `gh`
// or the database at module scope; every side effect happens inside
// main().
//
// One run, one `upsertNodes`, one `upsertEdges`, and no transaction around
// the pair: `upsertNodes` opens its own, the whole write is idempotent on
// `(source_system, external_id)`, and an edge-step failure leaves nodes
// the next run re-links (design.md decision 1) — a wrapper would guard
// against a failure that has not happened at the cost of holding every
// row lock across two statements.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createDb, createPool, resolveDatabaseUrl } from "@breakdown/db";
import {
  BELONGS_TO_EDGE_TYPE,
  BELONGS_TO_WEIGHT,
  CLOSES_EDGE_TYPE,
  CLOSES_WEIGHT,
  closeIngestRun,
  deriveClosesEdges,
  deriveMentionEdges,
  getStoreSummary,
  GITHUB_SOURCE_SYSTEM,
  mapGhIssueToNode,
  mapGhPrToNode,
  mapGhRepoToNode,
  MENTIONS_EDGE_TYPE,
  MENTIONS_WEIGHT,
  openIngestRun,
  upsertEdges,
  upsertNodes,
  type EdgeInput,
  type GhIssue,
  type GhPullRequest,
  type GhRepo,
  type IssueRefSource,
  type NodeInput,
  type PrClosesSource,
} from "./index.js";

const execFileAsync = promisify(execFile);

/**
 * How many repos `gh repo list` fetches when the caller gives no explicit
 * repo slugs (discovery mode). Comfortably above this account's repo
 * count (in the ~90s as of writing) so discovery never silently
 * truncates; not meant to be tuned per run, so not a CLI flag.
 */
const DISCOVERY_REPO_LIMIT = 1000;

/**
 * How many open issues `gh issue list` fetches per repo. Generous above
 * any single repo's open-issue count seen so far (under 70); a repo with
 * more open issues than this would silently lose the overflow, which is
 * why this is generous rather than tight.
 */
const ISSUES_PER_REPO_LIMIT = 2000;

/**
 * How many pull requests `gh pr list --state all` fetches per repo — every
 * state, so this bounds a repository's whole PR history, not its open
 * set. Above the largest repository seen so far (a few hundred) for the
 * same reason as `ISSUES_PER_REPO_LIMIT`: an overflow would be lost
 * silently. `gh` pages the fetch itself.
 */
const PRS_PER_REPO_LIMIT = 2000;

const REPO_JSON_FIELDS = "name,nameWithOwner,owner,description,url,visibility,isPrivate,defaultBranchRef,primaryLanguage,createdAt,updatedAt";
const ISSUE_JSON_FIELDS = "number,title,body,labels,author,createdAt,updatedAt,url,state";
const PR_JSON_FIELDS = "number,title,body,state,isDraft,mergedAt,closedAt,createdAt,updatedAt,author,headRefName,baseRefName,url,labels,closingIssuesReferences";

interface GhDiscoveryRepo {
  nameWithOwner: string;
  issues: { totalCount: number };
  pullRequests: { totalCount: number };
}

/** Runs `gh <args>` and returns stdout, or throws with `gh`'s own stderr attached — actionable, not a bare exit-code failure. */
async function gh(args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("gh", args, { maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    const stderr = typeof (err as { stderr?: unknown }).stderr === "string" ? (err as { stderr: string }).stderr.trim() : "";
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`gh ${args.join(" ")} failed: ${stderr || message}`);
  }
}

/** Repo slugs (`owner/repo`) with at least one issue or one pull request, for the authenticated `gh` user — the default when no slugs are given on the command line. A repository with neither has nothing this loader writes beyond its own node, so it is left out (github-ingest spec, "Discovery covers repositories with pull requests"). */
async function discoverRepoSlugs(): Promise<string[]> {
  const stdout = await gh(["repo", "list", "--limit", String(DISCOVERY_REPO_LIMIT), "--json", "nameWithOwner,issues,pullRequests"]);
  const rows = JSON.parse(stdout) as GhDiscoveryRepo[];
  return rows.filter((r) => r.issues.totalCount > 0 || r.pullRequests.totalCount > 0).map((r) => r.nameWithOwner);
}

async function fetchRepo(slug: string): Promise<GhRepo> {
  const stdout = await gh(["repo", "view", slug, "--json", REPO_JSON_FIELDS]);
  return JSON.parse(stdout) as GhRepo;
}

async function fetchOpenIssues(slug: string): Promise<GhIssue[]> {
  const stdout = await gh([
    "issue",
    "list",
    "-R",
    slug,
    "--state",
    "open",
    "--limit",
    String(ISSUES_PER_REPO_LIMIT),
    "--json",
    ISSUE_JSON_FIELDS,
  ]);
  return JSON.parse(stdout) as GhIssue[];
}

async function fetchPullRequests(slug: string): Promise<GhPullRequest[]> {
  const stdout = await gh([
    "pr",
    "list",
    "-R",
    slug,
    "--state",
    "all",
    "--limit",
    String(PRS_PER_REPO_LIMIT),
    "--json",
    PR_JSON_FIELDS,
  ]);
  return JSON.parse(stdout) as GhPullRequest[];
}

const REPO_SLUG_RE = /^[^/\s]+\/[^/\s]+$/;

/** Validates CLI-argument repo slugs are shaped like `owner/repo` — fails loudly on a typo'd argument rather than passing it through to `gh` and getting a confusing downstream error. */
function parseRepoArgs(argv: readonly string[]): string[] {
  for (const arg of argv) {
    if (!REPO_SLUG_RE.test(arg)) {
      throw new Error(`invalid repo argument ${JSON.stringify(arg)} — expected "owner/repo"`);
    }
  }
  return [...argv];
}

function countBy<T>(items: readonly T[], key: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const k = key(item);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}

function formatCounts(counts: Map<string, number>): string {
  if (counts.size === 0) return "(none)";
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const explicitSlugs = parseRepoArgs(argv);

  const repoSlugs = explicitSlugs.length > 0 ? explicitSlugs : await discoverRepoSlugs();
  if (explicitSlugs.length > 0) {
    console.log(`[ingest:github] using ${repoSlugs.length} repo(s) from arguments: ${repoSlugs.join(", ")}`);
  } else {
    console.log(
      `[ingest:github] discovered ${repoSlugs.length} repo(s) with issues or pull requests via \`gh repo list\`: ${repoSlugs.join(", ") || "(none)"}`,
    );
  }
  if (repoSlugs.length === 0) {
    throw new Error("no repos to ingest — pass repo slugs as arguments, or ensure the authenticated gh user has repos with issues or pull requests");
  }

  const repos = await Promise.all(repoSlugs.map(fetchRepo));
  const issuesBySlug = new Map<string, GhIssue[]>();
  const prsBySlug = new Map<string, GhPullRequest[]>();
  await Promise.all(
    repoSlugs.map(async (slug) => {
      const [issues, prs] = await Promise.all([fetchOpenIssues(slug), fetchPullRequests(slug)]);
      issuesBySlug.set(slug, issues);
      prsBySlug.set(slug, prs);
    }),
  );
  const totalIssues = [...issuesBySlug.values()].reduce((sum, issues) => sum + issues.length, 0);
  const totalPrs = [...prsBySlug.values()].reduce((sum, prs) => sum + prs.length, 0);
  console.log(`[ingest:github] fetched ${repos.length} repo(s), ${totalIssues} open issue(s), ${totalPrs} pull request(s) total`);

  const databaseUrl = resolveDatabaseUrl();
  const pool = createPool(databaseUrl);
  const db = createDb(pool);

  try {
    // actor = the pnpm script name a person actually types.
    const run = await openIngestRun(db, GITHUB_SOURCE_SYSTEM, { actor: "ingest:github" });

    const repoNodeInputs: NodeInput[] = repos.map(mapGhRepoToNode);

    const issueNodeInputs: NodeInput[] = [];
    for (const slug of repoSlugs) {
      for (const issue of issuesBySlug.get(slug) ?? []) {
        issueNodeInputs.push(mapGhIssueToNode(slug, issue));
      }
    }

    const prNodeInputs: NodeInput[] = [];
    for (const slug of repoSlugs) {
      for (const pr of prsBySlug.get(slug) ?? []) {
        prNodeInputs.push(mapGhPrToNode(slug, pr));
      }
    }

    const nodeResult = await upsertNodes(db, run, [...repoNodeInputs, ...issueNodeInputs, ...prNodeInputs]);

    const nodeIdByExternalId = new Map<string, string>();
    for (const row of nodeResult.rows) nodeIdByExternalId.set(row.externalId, row.id);

    // --- belongs-to: issue -> repo and PR -> repo, structural, weight 1.0 ---
    const belongsToEdges: EdgeInput[] = [];
    for (const slug of repoSlugs) {
      const repoId = nodeIdByExternalId.get(slug);
      if (!repoId) continue; // repo node write failed to resolve; upsertNodes would already have thrown before this point in practice
      const numbers = [
        ...(issuesBySlug.get(slug) ?? []).map((issue) => issue.number),
        ...(prsBySlug.get(slug) ?? []).map((pr) => pr.number),
      ];
      for (const number of numbers) {
        const itemId = nodeIdByExternalId.get(`${slug}#${number}`);
        if (!itemId) continue;
        belongsToEdges.push({
          srcId: itemId,
          dstId: repoId,
          edgeType: BELONGS_TO_EDGE_TYPE,
          sourceSystem: GITHUB_SOURCE_SYSTEM,
          weight: BELONGS_TO_WEIGHT,
        });
      }
    }

    // Every issue and PR id this run wrote — what a closing reference or a
    // `#N` resolves against. One set for both kinds: they share the id
    // scheme, so a `#N` lands on whichever exists.
    const knownExternalIds = new Set([...issueNodeInputs, ...prNodeInputs].map((n) => n.externalId));

    // --- closes: PR -> issue, from GitHub's own closingIssuesReferences, weight 1.0 ---
    // Only open issues are loaded, so a reference to an issue the PR
    // already closed resolves to nothing and is counted, not written; the
    // day closed issues are loaded, the edges appear on the next run.
    const prClosesSources: PrClosesSource[] = [];
    for (const slug of repoSlugs) {
      for (const pr of prsBySlug.get(slug) ?? []) {
        prClosesSources.push({ externalId: `${slug}#${pr.number}`, closingIssuesReferences: pr.closingIssuesReferences });
      }
    }
    const closes = deriveClosesEdges(prClosesSources, knownExternalIds);
    const closesEdges: EdgeInput[] = [];
    for (const candidate of closes.edges) {
      const srcId = nodeIdByExternalId.get(candidate.srcExternalId);
      const dstId = nodeIdByExternalId.get(candidate.dstExternalId);
      if (!srcId || !dstId) continue;
      closesEdges.push({
        srcId,
        dstId,
        edgeType: CLOSES_EDGE_TYPE,
        sourceSystem: GITHUB_SOURCE_SYSTEM,
        weight: CLOSES_WEIGHT,
      });
    }

    // --- mentions: issue/PR -> issue/PR, parsed from #N / owner/repo#N in title+body ---
    const refSources: IssueRefSource[] = [];
    for (const slug of repoSlugs) {
      for (const issue of issuesBySlug.get(slug) ?? []) {
        refSources.push({
          externalId: `${slug}#${issue.number}`,
          ownerRepo: slug,
          text: `${issue.title}\n\n${issue.body ?? ""}`,
        });
      }
      for (const pr of prsBySlug.get(slug) ?? []) {
        refSources.push({
          externalId: `${slug}#${pr.number}`,
          ownerRepo: slug,
          text: `${pr.title}\n\n${pr.body ?? ""}`,
        });
      }
    }
    const mentionCandidates = deriveMentionEdges(refSources, knownExternalIds);
    const mentionsEdges: EdgeInput[] = [];
    for (const candidate of mentionCandidates) {
      const srcId = nodeIdByExternalId.get(candidate.srcExternalId);
      const dstId = nodeIdByExternalId.get(candidate.dstExternalId);
      if (!srcId || !dstId) continue;
      mentionsEdges.push({
        srcId,
        dstId,
        edgeType: MENTIONS_EDGE_TYPE,
        sourceSystem: GITHUB_SOURCE_SYSTEM,
        weight: MENTIONS_WEIGHT,
      });
    }

    const edgeResult = await upsertEdges(db, run, [...belongsToEdges, ...closesEdges, ...mentionsEdges]);

    const closed = await closeIngestRun(db, run, {
      repoSlugs,
      reposFetched: repos.length,
      issuesFetched: totalIssues,
      pullRequestsFetched: totalPrs,
      closesFound: closes.edges.length,
      closesSkipped: closes.skipped,
      mentionsFound: mentionCandidates.length,
    });

    const summary = await getStoreSummary(db);

    // PR nodes per repository, fetched and newly created — the number a
    // dogfood run records, read off the upsert's own result rather than
    // re-counted.
    const prExternalIds = new Set(prNodeInputs.map((n) => n.externalId));
    const prsCreatedBySlug = new Map<string, number>();
    for (const row of nodeResult.rows) {
      if (row.action !== "created" || !prExternalIds.has(row.externalId)) continue;
      const slug = row.externalId.slice(0, row.externalId.lastIndexOf("#"));
      prsCreatedBySlug.set(slug, (prsCreatedBySlug.get(slug) ?? 0) + 1);
    }

    console.log(`[ingest:github] nodes: ${nodeResult.created} created, ${nodeResult.updated} updated, ${nodeResult.unchanged} unchanged`);
    console.log(
      `[ingest:github]   pull requests by repo: ${
        repoSlugs.map((slug) => `${slug}=${(prsBySlug.get(slug) ?? []).length} (${prsCreatedBySlug.get(slug) ?? 0} created)`).join(", ") || "(none)"
      }`,
    );
    console.log(`[ingest:github] edges: ${edgeResult.created} created, ${edgeResult.updated} updated`);
    console.log(
      `[ingest:github]   belongs-to: ${belongsToEdges.length} candidate(s); closes: ${closesEdges.length} written, ${closes.skipped} skipped (issue not loaded); mentions: ${mentionCandidates.length} found`,
    );
    if (mentionCandidates.length > 0) {
      const examples = mentionCandidates.slice(0, 5);
      console.log(`[ingest:github]   mentions examples: ${examples.map((e) => `${e.srcExternalId} -> ${e.dstExternalId}`).join(", ")}`);
    }
    console.log(
      `[ingest:github] ingest run ${closed.id} (source_system=${closed.sourceSystem}) closed: ${closed.nodeCount} nodes, ${closed.edgeCount} edges attributed`,
    );
    console.log(`[ingest:github] store totals: ${summary.totalNodes} nodes, ${summary.totalEdges} edges`);
    console.log(`[ingest:github]   node types: ${formatCounts(new Map(summary.nodeTypes.map((t) => [t.nodeType, t.count])))}`);
    console.log(`[ingest:github]   edge types: ${formatCounts(new Map(summary.edgeTypes.map((t) => [t.edgeType, t.count])))}`);
    console.log(`[ingest:github]   source systems: ${formatCounts(new Map(summary.sourceSystems.map((s) => [s.sourceSystem, s.count])))}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("[ingest:github] failed:", err);
  process.exitCode = 1;
});
