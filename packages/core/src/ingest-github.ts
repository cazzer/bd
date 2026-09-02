// `pnpm ingest:github` (bd-5hd): loads this user's GitHub repositories and
// their open issues into the knowledge store, `source_system = 'github'`
// — a second source system, deliberately distinct from the markdown
// seed's `'repo'` so edges from real, semantic content (`mentions`,
// parsed from actual issue prose) render in more than one colour and can
// never collide with the doc corpus on the `(source_system, external_id)`
// dedup key.
//
// A script, not a library — reusable logic (reference parsing, node/edge
// type names and weights) lives in github.ts and is exported from the
// package's public API; this file only shells out to `gh`, walks its
// JSON, and calls the public write-path API
// (openIngestRun/upsertNodes/upsertEdges/closeIngestRun) — matching
// seed.ts's split for the markdown loader. Nothing below connects to `gh`
// or the database at module scope; every side effect happens inside
// main().

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createDb, createPool, resolveDatabaseUrl } from "@breakdown/db";
import {
  BELONGS_TO_EDGE_TYPE,
  BELONGS_TO_WEIGHT,
  closeIngestRun,
  deriveMentionEdges,
  getStoreSummary,
  GITHUB_SOURCE_SYSTEM,
  ISSUE_NODE_TYPE,
  MENTIONS_EDGE_TYPE,
  MENTIONS_WEIGHT,
  openIngestRun,
  REPO_NODE_TYPE,
  upsertEdges,
  upsertNodes,
  type EdgeInput,
  type IssueRefSource,
  type NodeInput,
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

const REPO_JSON_FIELDS = "name,nameWithOwner,owner,description,url,visibility,isPrivate,defaultBranchRef,primaryLanguage,createdAt,updatedAt";
const ISSUE_JSON_FIELDS = "number,title,body,labels,author,createdAt,updatedAt,url,state";

interface GhOwner {
  login: string;
}

interface GhRepo {
  name: string;
  nameWithOwner: string;
  owner: GhOwner;
  description: string | null;
  url: string;
  visibility: string;
  isPrivate: boolean;
  defaultBranchRef: { name: string } | null;
  primaryLanguage: { name: string } | null;
  createdAt: string;
  updatedAt: string;
}

interface GhLabel {
  name: string;
}

interface GhAuthor {
  login: string;
}

interface GhIssue {
  number: number;
  title: string;
  body: string | null;
  labels: GhLabel[];
  author: GhAuthor | null;
  createdAt: string;
  updatedAt: string;
  url: string;
  state: string;
}

interface GhDiscoveryRepo {
  nameWithOwner: string;
  issues: { totalCount: number };
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

/** Repo slugs (`owner/repo`) with at least one open issue, for the authenticated `gh` user — the default when no slugs are given on the command line. */
async function discoverRepoSlugs(): Promise<string[]> {
  const stdout = await gh(["repo", "list", "--limit", String(DISCOVERY_REPO_LIMIT), "--json", "nameWithOwner,issues"]);
  const rows = JSON.parse(stdout) as GhDiscoveryRepo[];
  return rows.filter((r) => r.issues.totalCount > 0).map((r) => r.nameWithOwner);
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
      `[ingest:github] discovered ${repoSlugs.length} repo(s) with open issues via \`gh repo list\`: ${repoSlugs.join(", ") || "(none)"}`,
    );
  }
  if (repoSlugs.length === 0) {
    throw new Error("no repos to ingest — pass repo slugs as arguments, or ensure the authenticated gh user has repos with open issues");
  }

  const repos = await Promise.all(repoSlugs.map(fetchRepo));
  const issuesBySlug = new Map<string, GhIssue[]>();
  await Promise.all(
    repoSlugs.map(async (slug) => {
      issuesBySlug.set(slug, await fetchOpenIssues(slug));
    }),
  );
  const totalIssues = [...issuesBySlug.values()].reduce((sum, issues) => sum + issues.length, 0);
  console.log(`[ingest:github] fetched ${repos.length} repo(s), ${totalIssues} open issue(s) total`);

  const databaseUrl = resolveDatabaseUrl();
  const pool = createPool(databaseUrl);
  const db = createDb(pool);

  try {
    // actor = the pnpm script name a person actually types.
    const run = await openIngestRun(db, GITHUB_SOURCE_SYSTEM, { actor: "ingest:github" });

    const repoNodeInputs: NodeInput[] = repos.map((repo) => ({
      nodeType: REPO_NODE_TYPE,
      sourceSystem: GITHUB_SOURCE_SYSTEM,
      externalId: repo.nameWithOwner,
      title: repo.name,
      // A repo can genuinely have no description — `gh` reports that as
      // `""`, not `null`, but handle both rather than assume the shape.
      content: repo.description ?? "",
      metadata: {
        visibility: repo.visibility,
        isPrivate: repo.isPrivate,
        url: repo.url,
        defaultBranch: repo.defaultBranchRef?.name ?? null,
        primaryLanguage: repo.primaryLanguage?.name ?? null,
        owner: repo.owner.login,
        createdAt: repo.createdAt,
        updatedAt: repo.updatedAt,
      },
    }));

    const issueNodeInputs: NodeInput[] = [];
    for (const slug of repoSlugs) {
      for (const issue of issuesBySlug.get(slug) ?? []) {
        issueNodeInputs.push({
          nodeType: ISSUE_NODE_TYPE,
          sourceSystem: GITHUB_SOURCE_SYSTEM,
          externalId: `${slug}#${issue.number}`,
          title: issue.title,
          // Content is the issue body — this is the point of this loader
          // (bd-5hd: "this matters, it's what finally gives search real
          // prose to match against"). A body can be null (no description
          // given) — handled explicitly, not assumed present.
          content: issue.body ?? "",
          metadata: {
            state: issue.state,
            labels: issue.labels.map((l) => l.name),
            author: issue.author?.login ?? null,
            createdAt: issue.createdAt,
            updatedAt: issue.updatedAt,
            url: issue.url,
          },
        });
      }
    }

    const nodeResult = await upsertNodes(db, run, [...repoNodeInputs, ...issueNodeInputs]);

    const nodeIdByExternalId = new Map<string, string>();
    for (const row of nodeResult.rows) nodeIdByExternalId.set(row.externalId, row.id);

    // --- belongs-to: issue -> repo, structural, weight 1.0 ---
    const belongsToEdges: EdgeInput[] = [];
    for (const slug of repoSlugs) {
      const repoId = nodeIdByExternalId.get(slug);
      if (!repoId) continue; // repo node write failed to resolve; upsertNodes would already have thrown before this point in practice
      for (const issue of issuesBySlug.get(slug) ?? []) {
        const issueId = nodeIdByExternalId.get(`${slug}#${issue.number}`);
        if (!issueId) continue;
        belongsToEdges.push({
          srcId: issueId,
          dstId: repoId,
          edgeType: BELONGS_TO_EDGE_TYPE,
          sourceSystem: GITHUB_SOURCE_SYSTEM,
          weight: BELONGS_TO_WEIGHT,
        });
      }
    }

    // --- mentions: issue -> issue, parsed from #N / owner/repo#N in title+body ---
    const issueRefSources: IssueRefSource[] = [];
    for (const slug of repoSlugs) {
      for (const issue of issuesBySlug.get(slug) ?? []) {
        issueRefSources.push({
          externalId: `${slug}#${issue.number}`,
          ownerRepo: slug,
          text: `${issue.title}\n\n${issue.body ?? ""}`,
        });
      }
    }
    const knownIssueExternalIds = new Set(issueNodeInputs.map((n) => n.externalId));
    const mentionCandidates = deriveMentionEdges(issueRefSources, knownIssueExternalIds);
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

    const edgeResult = await upsertEdges(db, run, [...belongsToEdges, ...mentionsEdges]);

    const closed = await closeIngestRun(db, run, {
      repoSlugs,
      reposFetched: repos.length,
      issuesFetched: totalIssues,
      mentionsFound: mentionCandidates.length,
    });

    const summary = await getStoreSummary(db);

    console.log(`[ingest:github] nodes: ${nodeResult.created} created, ${nodeResult.updated} updated, ${nodeResult.unchanged} unchanged`);
    console.log(`[ingest:github] edges: ${edgeResult.created} created, ${edgeResult.updated} updated`);
    console.log(
      `[ingest:github]   belongs-to: ${belongsToEdges.length} candidate(s); mentions: ${mentionCandidates.length} found`,
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
