// The beads loader as a library (live-beads-board, task group 1; design.md
// decisions 2 and 3): `ingestBeadsCheckout(db, { dir, project?, runBd? })`
// mirrors one beads checkout into the store as `work_item` nodes under
// `source_system = 'beads'` with `blocks` / `child_of` edges, in one
// attributed ingest run (`actor: 'ingest:beads'`). It was the body of the
// `ingest-beads.ts` script, whose `main()` ran at import and owned its own
// pool; the web server's watcher needs to call it, so the script is now
// argument parsing, pool lifecycle, and printing around this function.
//
// The function takes `db` and never creates or ends a pool. `runBd` is
// injectable so tests feed fixture JSON with no `bd` binary; the default
// shells out to `bd list --status=all --limit=0 --json` in `dir`
// (`--limit=0` is "unlimited": `bd list` defaults to 50 rows, which would
// silently truncate the export the moment the tracker outgrows that).
// For each issue labelled `review` with `comment_count > 0`, it then runs
// `bd comments <id> --json` through the same runner, serially, so the
// thread lands on the review's work item (board-visual-reviews) — unless
// the stored row's `review_comment_count` still matches, in which case the
// stored thread is carried forward (one read for all of them), so a reload
// spawns a process only for reviews whose comments changed. A failed or
// malformed comments call fails the load before anything is written.
//
// With a `project` key, every item is stamped `project` and a registry
// node `{ beads_project, external_id 'project:<key>', metadata { project,
// path } }` is written in the SAME `upsertNodes` batch as the items, so
// registration and load commit together (the batch is all-or-nothing). The
// registry metadata holds no timestamps or outcomes, so a re-load leaves
// it `unchanged` and records no revision. Without `project` the load
// behaves as it always did: no stamp, no registration.
//
// The key is canonicalized first (trimmed, checked against
// `PROJECT_KEY_PATTERN`; an explicitly passed empty key is an error naming
// `project`) and the canonical value is what items, the registry node, its
// external id, and the guard all use. The checkout path is `realpath`ed
// (native, so APFS case folding agrees) before it is stored or compared, so
// a symlinked and a real path to one checkout are the same registration; a
// missing directory is an error saying so.
//
// Collision guard: before any write, one statement reads the exact
// `(beads, external_id)` rows the upsert is about to touch — no merge
// folding, because `upsertNodes` writes those rows as they are, so the
// owner that matters is the one on the row itself — plus the key's registry
// row. An item already owned by another project, the key registered at
// another real path, or (with no project given) ANY owned item throws
// `BeadsProjectConflictError` naming the bead id and both sides, with no
// ingest run opened and nothing written. A project-less load must not
// proceed over an owned item because a node upsert replaces metadata
// wholesale and would strip `project`. An item with no `project` is
// adopted. The guard read and the upsert are not one transaction: the
// server serializes loads per project, and a racing CLI load of the same
// project can at worst pass the guard twice, which is harmless.
//
// `changedNodeIds` is every row the upsert did not report `unchanged` —
// `content_hash` already decided that, so nothing is diffed here. The
// registry node counts in `nodes` and `changedNodeIds` like any other row.
// `changed` is the one flag a caller gates on: `changedNodeIds` non-empty or
// `edges.created > 0`. `edges.updated` must NEVER count as change:
// `upsertEdges` has no unchanged state and reports `updated` for every
// re-asserted edge, so it equals the derived edge count on every re-load.
//
// If a failure follows `openIngestRun`, the run is closed with the error
// recorded in its `stats` (best effort) before the failure is rethrown, so
// a failed load leaves no run open forever.

import { execFile } from "node:child_process";
import { realpath } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { nodes, type Database } from "@breakdown/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  BEADS_SOURCE_SYSTEM,
  deriveBeadsEdges,
  isReviewIssue,
  mapBeadsIssueToNode,
  resolveBeadsEdges,
  type BeadsIssue,
} from "./beads.js";
import { upsertEdges } from "./edges.js";
import { BeadsProjectConflictError, InvalidWorkItemError } from "./errors.js";
import { closeIngestRun, openIngestRun } from "./ingest-runs.js";
import { upsertNodes, type NodeInput } from "./nodes.js";
import { PROJECT_KEY_PATTERN } from "./work-items.js";

export const BEADS_PROJECT_NODE_TYPE = "beads_project";
export const BEADS_INGEST_ACTOR = "ingest:beads";

const execFileAsync = promisify(execFile);
const realpathNative = promisify(realpath.native);

/** Runs `bd <args>` in `cwd` and returns stdout. */
export type RunBd = (args: readonly string[], cwd: string, signal?: AbortSignal) => Promise<string>;

/** A hung `bd` must not wedge a project, a refresh, or shutdown: the default runner kills it after this long. */
export const BD_TIMEOUT_MS = 60_000;

export interface IngestBeadsCheckoutOptions {
  /** The checkout `bd` runs in; resolved to its real absolute path. */
  dir: string;
  /** Registers and stamps this project key (contract form `[a-z0-9._-]{1,64}`, trimmed). Omit for a project-less load. */
  project?: string;
  /** Replaces the `bd` invocation (tests). Default: `execFile("bd", …)`. */
  runBd?: RunBd;
  /** Aborts the `bd` invocation (the server's shutdown). */
  signal?: AbortSignal;
}

export interface IngestBeadsCheckoutResult {
  project: string | null;
  /** The real absolute checkout path. */
  path: string;
  nodes: { created: number; updated: number; unchanged: number };
  edges: { created: number; updated: number };
  changedNodeIds: string[];
  /** Something a reader could see moved: `changedNodeIds` non-empty or `edges.created > 0`. Never `edges.updated`. */
  changed: boolean;
  ingestRunId: string;
  issuesFetched: number;
  edgesDerived: number;
  skippedUnknownIssue: number;
  skippedUnknownType: number;
}

/** The default runner: `bd`'s own stderr is attached to the failure. BEADS_DIR / BEADS_DB are dropped from its environment: either would point `bd` at another database than the checkout's, whatever `cwd` says. */
export const defaultRunBd: RunBd = async (args, cwd, signal) => {
  const env = { ...process.env };
  delete env["BEADS_DIR"];
  delete env["BEADS_DB"];
  try {
    const { stdout } = await execFileAsync("bd", [...args], {
      cwd,
      env,
      maxBuffer: 64 * 1024 * 1024,
      timeout: BD_TIMEOUT_MS,
      killSignal: "SIGKILL",
      ...(signal ? { signal } : {}),
    });
    return stdout;
  } catch (err) {
    const stderr = typeof (err as { stderr?: unknown }).stderr === "string" ? (err as { stderr: string }).stderr.trim() : "";
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`bd ${args.join(" ")} failed in ${cwd}: ${stderr || message}`);
  }
};

async function fetchIssues(runBd: RunBd, cwd: string, signal?: AbortSignal): Promise<BeadsIssue[]> {
  const stdout = await runBd(["list", "--status=all", "--limit=0", "--json"], cwd, signal);
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) {
    throw new Error("bd list --json did not return an array");
  }
  for (const [i, row] of parsed.entries()) {
    const r = row as Partial<BeadsIssue>;
    if (typeof r.id !== "string" || typeof r.title !== "string" || typeof r.status !== "string") {
      throw new Error(`bd list --json row ${i} is missing id, title, or status: ${JSON.stringify(row).slice(0, 200)}`);
    }
  }
  return parsed as BeadsIssue[];
}

/**
 * The comment thread of every review issue with comments, keyed by issue id.
 * One read first: a stored row of this project whose `review_comment_count`
 * equals the issue's `comment_count` has its stored thread carried forward
 * (normalization is idempotent, so the reload is `unchanged`); the rest are
 * fetched with `bd comments <id> --json`, one at a time.
 */
async function fetchReviewComments(
  db: Database,
  runBd: RunBd,
  cwd: string,
  project: string | undefined,
  issues: readonly BeadsIssue[],
  signal?: AbortSignal,
): Promise<Map<string, unknown[]>> {
  const byIssue = new Map<string, unknown[]>();
  const wanted = issues.filter((i) => isReviewIssue(i) && typeof i.comment_count === "number" && i.comment_count > 0);
  if (wanted.length === 0) return byIssue;
  const stored = await db
    .select({
      externalId: nodes.externalId,
      project: sql<string | null>`${nodes.metadata}->>'project'`,
      count: sql<unknown>`${nodes.metadata}->'review_comment_count'`,
      comments: sql<unknown>`${nodes.metadata}->'review_comments'`,
    })
    .from(nodes)
    .where(and(eq(nodes.sourceSystem, BEADS_SOURCE_SYSTEM), inArray(nodes.externalId, wanted.map((i) => i.id))));
  const storedById = new Map(stored.map((row) => [row.externalId, row]));
  for (const issue of wanted) {
    const prior = storedById.get(issue.id);
    if (prior && prior.project === (project ?? null) && prior.count === issue.comment_count) {
      byIssue.set(issue.id, Array.isArray(prior.comments) ? prior.comments : []);
      continue;
    }
    const stdout = await runBd(["comments", issue.id, "--json"], cwd, signal);
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch (err) {
      throw new Error(`bd comments ${issue.id} --json returned invalid JSON`, { cause: err });
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`bd comments ${issue.id} --json did not return an array`);
    }
    byIssue.set(issue.id, parsed);
  }
  return byIssue;
}

/** Canonical key: trimmed and valid, else `InvalidWorkItemError` naming `project` (an explicit empty key included). */
function canonicalProject(project: string | undefined): string | undefined {
  if (project === undefined) return undefined;
  const key = typeof project === "string" ? project.trim() : project;
  if (typeof key !== "string" || key.length === 0) {
    throw new InvalidWorkItemError("project", project, "must not be empty when given");
  }
  if (!PROJECT_KEY_PATTERN.test(key)) {
    throw new InvalidWorkItemError("project", project, "must be 1 to 64 characters of lowercase letters, digits, '.', '_' or '-'");
  }
  return key;
}

async function resolveCheckoutPath(dir: string): Promise<string> {
  try {
    return await realpathNative(path.resolve(dir));
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new Error(`beads checkout directory does not exist: ${path.resolve(dir)}`);
    }
    throw err;
  }
}

/** Throws `BeadsProjectConflictError` when the load would take over or strip another project's item, or re-point a registry key; reads only, one statement. */
async function assertNoProjectConflict(db: Database, project: string | undefined, checkoutPath: string, issueIds: readonly string[]): Promise<void> {
  const registryId = project === undefined ? null : `project:${project}`;
  const rows = await db
    .select({
      externalId: nodes.externalId,
      project: sql<string | null>`${nodes.metadata}->>'project'`,
      path: sql<string | null>`${nodes.metadata}->>'path'`,
    })
    .from(nodes)
    .where(and(eq(nodes.sourceSystem, BEADS_SOURCE_SYSTEM), inArray(nodes.externalId, registryId === null ? [...issueIds] : [...issueIds, registryId])));

  for (const row of rows) {
    if (row.externalId === registryId) {
      if (row.path !== null && row.path !== checkoutPath) {
        throw new BeadsProjectConflictError(project ?? null, "path", checkoutPath, row.path);
      }
    } else if (row.project !== null && row.project !== project) {
      throw new BeadsProjectConflictError(project ?? null, "item", row.externalId, row.project);
    }
  }
}

/**
 * Loads one beads checkout. See the module header. Throws
 * `InvalidWorkItemError` (a bad `project` key, naming `project`, or a row
 * violating the contract), `BeadsProjectConflictError`, or the write
 * path's own errors; a failed `bd`, a missing directory, or an empty export
 * throws a plain `Error`.
 */
export async function ingestBeadsCheckout(db: Database, options: IngestBeadsCheckoutOptions): Promise<IngestBeadsCheckoutResult> {
  const project = canonicalProject(options.project);
  const checkoutPath = await resolveCheckoutPath(options.dir);
  const runBd = options.runBd ?? defaultRunBd;
  const issues = await fetchIssues(runBd, checkoutPath, options.signal);
  if (issues.length === 0) {
    throw new Error("no issues to ingest");
  }
  const comments = await fetchReviewComments(db, runBd, checkoutPath, project, issues, options.signal);

  const nodeInputs: NodeInput[] = issues.map((issue, index) =>
    mapBeadsIssueToNode(issue, index, { ...(project === undefined ? {} : { project }), comments: comments.get(issue.id) ?? [] }),
  );
  if (project !== undefined) {
    nodeInputs.push({
      nodeType: BEADS_PROJECT_NODE_TYPE,
      sourceSystem: BEADS_SOURCE_SYSTEM,
      externalId: `project:${project}`,
      title: project,
      content: "",
      metadata: { project, path: checkoutPath },
    });
  }
  await assertNoProjectConflict(db, project, checkoutPath, issues.map((i) => i.id));
  const derived = deriveBeadsEdges(issues, new Set(issues.map((i) => i.id)));
  const stats = {
    cwd: checkoutPath,
    project: project ?? null,
    issuesFetched: issues.length,
    edgesDerived: derived.edges.length,
    skippedUnknownIssue: derived.skippedUnknownIssue,
    skippedUnknownType: derived.skippedUnknownType,
  };

  const run = await openIngestRun(db, BEADS_SOURCE_SYSTEM, { actor: BEADS_INGEST_ACTOR });
  try {
    const nodeResult = await upsertNodes(db, run, nodeInputs);
    const nodeIdByExternalId = new Map(nodeResult.rows.map((r) => [r.externalId, r.id]));
    const edgeResult = await upsertEdges(db, run, resolveBeadsEdges(derived.edges, nodeIdByExternalId));
    await closeIngestRun(db, run, stats);
    const changedNodeIds = nodeResult.rows.filter((r) => r.action !== "unchanged").map((r) => r.id);
    return {
      project: project ?? null,
      path: checkoutPath,
      nodes: { created: nodeResult.created, updated: nodeResult.updated, unchanged: nodeResult.unchanged },
      edges: { created: edgeResult.created, updated: edgeResult.updated },
      changedNodeIds,
      changed: changedNodeIds.length > 0 || edgeResult.created > 0,
      ingestRunId: run.id,
      issuesFetched: issues.length,
      edgesDerived: derived.edges.length,
      skippedUnknownIssue: derived.skippedUnknownIssue,
      skippedUnknownType: derived.skippedUnknownType,
    };
  } catch (err) {
    await closeIngestRun(db, run, { ...stats, error: err instanceof Error ? err.message : String(err) }).catch(() => undefined);
    throw err;
  }
}
