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
// With no `bd` on PATH (a container) the default runner throws
// HostBinaryUnavailableError("bd") rather than a spawn error.
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
// `changed` is the one flag a caller gates on: changed nodes, created edges,
// or removed stale edges. `edges.updated` must NEVER count as change:
// `upsertEdges` has no unchanged state and reports `updated` for every
// re-asserted edge, so it equals the derived edge count on every re-load.
//
// If a failure follows `openIngestRun`, the run is closed with the error
// recorded in its `stats` (best effort) before the failure is rethrown, so
// a failed load leaves no run open forever.
//
// The load is two halves (laptop-relay decisions 4 and 9), composed by
// `ingestBeadsCheckout` in the order above:
//   - `computeBeadsIngest(runBd, cwd, { priorThreads })` runs `bd` and
//     returns the raw `issues` and review `comments` as plain data. It
//     touches no database: which stored threads may be carried forward is
//     an injected `priorThreads` lookup (the store locally, an in-memory
//     cache on the relay); without one every thread is fetched.
//   - `applyBeadsIngest(db, { project, path, issues, comments, actor })`
//     builds every node itself (`mapBeadsIssueToNode`, and the registry
//     node from `path`), runs the collision guard, and writes the run. The
//     relay's push (`POST /relay/v1/beads-ingest`) calls it with the path
//     Breakdown already has registered and the relay's client as `actor`,
//     so a pushed batch can never re-point the registry.

import { execFile } from "node:child_process";
import { realpath, statSync } from "node:fs";
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
import { reconcileEdges } from "./edges.js";
import { BeadsProjectConflictError, InvalidWorkItemError } from "./errors.js";
import { HostBinaryUnavailableError } from "./host-binaries.js";
import { closeIngestRun, openIngestRun } from "./ingest-runs.js";
import { upsertNodes, type NodeInput } from "./nodes.js";
import { BLOCKS_EDGE_TYPE, CHILD_OF_EDGE_TYPE, PROJECT_KEY_PATTERN } from "./work-items.js";

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
  edgesDeleted: number;
  changedNodeIds: string[];
  /** Something a reader could see moved: changed nodes or created/deleted edges. Never `edges.updated`. */
  changed: boolean;
  ingestRunId: string;
  issuesFetched: number;
  edgesDerived: number;
  skippedUnknownIssue: number;
  skippedUnknownType: number;
}

export interface IngestBdRunnerOptions {
  /** The executable to run. Default `bd` (resolved on PATH). */
  command?: string;
}

/** A runner over `execFile`, never a shell: `bd`'s own stderr is attached to the failure. BEADS_DIR / BEADS_DB are dropped from its environment: either would point `bd` at another database than the checkout's, whatever `cwd` says. */
export function createIngestBdRunner({ command = "bd" }: IngestBdRunnerOptions = {}): RunBd {
  return async (args, cwd, signal) => {
    const env = { ...process.env };
    delete env["BEADS_DIR"];
    delete env["BEADS_DB"];
    try {
      const { stdout } = await execFileAsync(command, [...args], {
        cwd,
        env,
        maxBuffer: 64 * 1024 * 1024,
        timeout: BD_TIMEOUT_MS,
        killSignal: "SIGKILL",
        ...(signal ? { signal } : {}),
      });
      return stdout;
    } catch (err) {
      // spawn reports a missing cwd as ENOENT too; only a real cwd means bd itself is missing.
      if ((err as NodeJS.ErrnoException).code === "ENOENT" && isDirectory(cwd)) throw new HostBinaryUnavailableError("bd");
      const stderr = typeof (err as { stderr?: unknown }).stderr === "string" ? (err as { stderr: string }).stderr.trim() : "";
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`bd ${args.join(" ")} failed in ${cwd}: ${stderr || message}`);
    }
  };
}

/** The default runner: `bd` on PATH. */
export const defaultRunBd: RunBd = createIngestBdRunner();

function isDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * `bd list --json` output, already JSON-parsed, checked to be an array of
 * rows each carrying a string `id`, `title`, and `status`; anything else
 * throws a plain `Error` naming the first bad row.
 */
export function parseBeadsIssues(parsed: unknown): BeadsIssue[] {
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

async function fetchIssues(runBd: RunBd, cwd: string, signal?: AbortSignal): Promise<BeadsIssue[]> {
  const stdout = await runBd(["list", "--status=all", "--limit=0", "--json"], cwd, signal);
  return parseBeadsIssues(JSON.parse(stdout));
}

/** A review's thread as last stored: what `priorThreads` answers per issue id. */
export interface PriorReviewThread {
  /** The stored `review_comment_count`, as stored (any JSON). */
  count: unknown;
  /** The stored `review_comments`, as stored (any JSON). */
  comments: unknown;
}

/**
 * The stored threads that may be carried forward for these review issues,
 * keyed by issue id; an issue missing from the answer is fetched. Only a
 * thread belonging to the project being loaded may be answered.
 */
export type PriorReviewThreads = (issues: readonly BeadsIssue[]) => Promise<ReadonlyMap<string, PriorReviewThread>>;

export interface ComputeBeadsIngestOptions {
  /** Stored threads to carry forward (module header). Omitted: every thread is fetched. */
  priorThreads?: PriorReviewThreads;
  /** Aborts the `bd` invocations. */
  signal?: AbortSignal;
}

export interface ComputedBeadsIngest {
  /** `bd list --json`'s rows, checked by `parseBeadsIssues`; never empty. */
  issues: BeadsIssue[];
  /** Each review issue's comment thread, keyed by issue id: only reviews with comments appear. */
  comments: Record<string, unknown[]>;
}

/**
 * Runs the checkout's `bd` reads and returns them as plain data (module
 * header). The comment thread of every review issue with comments is
 * carried forward from `priorThreads` when its stored count equals the
 * issue's `comment_count` (normalization is idempotent, so the reload is
 * `unchanged`); the rest are fetched with `bd comments <id> --json`, one at
 * a time. An empty export, or a failed or malformed `bd` call, throws a
 * plain `Error`.
 */
export async function computeBeadsIngest(runBd: RunBd, cwd: string, options: ComputeBeadsIngestOptions = {}): Promise<ComputedBeadsIngest> {
  const { signal } = options;
  const issues = await fetchIssues(runBd, cwd, signal);
  if (issues.length === 0) {
    throw new Error("no issues to ingest");
  }
  const byIssue = new Map<string, unknown[]>();
  const wanted = issues.filter((i) => isReviewIssue(i) && typeof i.comment_count === "number" && i.comment_count > 0);
  if (wanted.length > 0) {
    const stored = options.priorThreads === undefined ? new Map<string, PriorReviewThread>() : await options.priorThreads(wanted);
    for (const issue of wanted) {
      const prior = stored.get(issue.id);
      if (prior && prior.count === issue.comment_count) {
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
  }
  // fromEntries defines own properties, so no issue id can reach the prototype.
  return { issues, comments: Object.fromEntries(byIssue) };
}

/** The store's threads for `priorThreads`: one read of the exact `(beads, id)` rows, keeping those of `project` (null: project-less rows). */
function storedReviewThreads(db: Database, project: string | undefined): PriorReviewThreads {
  return async (issues) => {
    const stored = await db
      .select({
        externalId: nodes.externalId,
        project: sql<string | null>`${nodes.metadata}->>'project'`,
        count: sql<unknown>`${nodes.metadata}->'review_comment_count'`,
        comments: sql<unknown>`${nodes.metadata}->'review_comments'`,
      })
      .from(nodes)
      .where(and(eq(nodes.sourceSystem, BEADS_SOURCE_SYSTEM), inArray(nodes.externalId, issues.map((i) => i.id))));
    return new Map(stored.filter((row) => row.project === (project ?? null)).map((row) => [row.externalId, { count: row.count, comments: row.comments }]));
  };
}

/** Canonical key: trimmed and valid, else `InvalidWorkItemError` naming `project` (an explicit empty key included). */
export function canonicalProject(project: string | undefined): string | undefined {
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

export interface ApplyBeadsIngestOptions {
  /** The canonical project key (already through `canonicalProject`); undefined for a project-less load. */
  project?: string | undefined;
  /** The real absolute checkout path: stored on the registry node and compared by the guard. */
  path: string;
  issues: readonly BeadsIssue[];
  /** Review threads keyed by issue id (`ComputedBeadsIngest.comments`); an issue missing here has none. */
  comments: Readonly<Record<string, readonly unknown[]>>;
  /** The run's actor. Default `BEADS_INGEST_ACTOR`; a relay push names its client. */
  actor?: string;
}

/**
 * Writes one computed load (module header): maps every issue, adds the
 * registry node, runs the collision guard, derives the edges, then upserts
 * and reconciles inside one `beads` ingest run attributed to `actor`, closed
 * with the error on failure. Throws `InvalidWorkItemError` (a row violating
 * the contract), `BeadsProjectConflictError`, or the write path's own errors.
 */
export async function applyBeadsIngest(db: Database, options: ApplyBeadsIngestOptions): Promise<IngestBeadsCheckoutResult> {
  const { project, path: checkoutPath, issues, comments } = options;
  const nodeInputs: NodeInput[] = issues.map((issue, index) =>
    mapBeadsIssueToNode(issue, index, {
      ...(project === undefined ? {} : { project }),
      comments: Object.hasOwn(comments, issue.id) ? comments[issue.id]! : [],
    }),
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

  const run = await openIngestRun(db, BEADS_SOURCE_SYSTEM, { actor: options.actor ?? BEADS_INGEST_ACTOR });
  try {
    const nodeResult = await upsertNodes(db, run, nodeInputs);
    const nodeIdByExternalId = new Map(nodeResult.rows.map((r) => [r.externalId, r.id]));
    const scopeNodeIds = project === undefined
      ? nodeResult.rows.map((r) => r.id)
      : (await db.select({ id: nodes.id }).from(nodes).where(and(
          eq(nodes.sourceSystem, BEADS_SOURCE_SYSTEM),
          eq(nodes.nodeType, "work_item"),
          sql`${nodes.metadata}->>'project' = ${project}`,
        ))).map((r) => r.id);
    const edgeResult = await reconcileEdges(
      db, run, resolveBeadsEdges(derived.edges, nodeIdByExternalId), scopeNodeIds,
      BEADS_SOURCE_SYSTEM, [BLOCKS_EDGE_TYPE, CHILD_OF_EDGE_TYPE],
    );
    await closeIngestRun(db, run, { ...stats, edgesDeleted: edgeResult.deleted });
    const changedNodeIds = nodeResult.rows.filter((r) => r.action !== "unchanged").map((r) => r.id);
    return {
      project: project ?? null,
      path: checkoutPath,
      nodes: { created: nodeResult.created, updated: nodeResult.updated, unchanged: nodeResult.unchanged },
      edges: { created: edgeResult.created, updated: edgeResult.updated },
      edgesDeleted: edgeResult.deleted,
      changedNodeIds,
      changed: changedNodeIds.length > 0 || edgeResult.created > 0 || edgeResult.deleted > 0,
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

/**
 * Loads one beads checkout: `computeBeadsIngest` then `applyBeadsIngest`
 * (module header). Throws `InvalidWorkItemError` (a bad `project` key,
 * naming `project`, or a row violating the contract),
 * `BeadsProjectConflictError`, or the write path's own errors; a failed
 * `bd`, a missing directory, or an empty export throws a plain `Error`.
 */
export async function ingestBeadsCheckout(db: Database, options: IngestBeadsCheckoutOptions): Promise<IngestBeadsCheckoutResult> {
  const project = canonicalProject(options.project);
  const checkoutPath = await resolveCheckoutPath(options.dir);
  const { issues, comments } = await computeBeadsIngest(options.runBd ?? defaultRunBd, checkoutPath, {
    priorThreads: storedReviewThreads(db, project),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return applyBeadsIngest(db, { project, path: checkoutPath, issues, comments });
}
