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
//
// With a `project` key, every item is stamped `project` and a registry
// node `{ beads_project, external_id 'project:<key>', metadata { project,
// path } }` is written in the SAME `upsertNodes` batch as the items, so
// registration and load commit together (the batch is all-or-nothing). The
// registry metadata holds no timestamps or outcomes, so a re-load leaves
// it `unchanged` and records no revision. Without `project` the load
// behaves as it always did: no stamp, no registration.
//
// Collision guard: before any write the function reads the export's
// external ids (`getNodesByExternalId`, chunked to its cap, then `getNodes`
// for their metadata) and the key's registry node. An item already owned
// by another project, or the key registered at another path, throws
// `BeadsProjectConflictError` naming both sides, with no ingest run opened
// and nothing written. An item with no `project` is adopted. The guard read
// and the upsert are not one transaction: the server serializes loads per
// project, and a racing CLI load of the same project can at worst pass the
// guard twice, which is harmless.
//
// `changedNodeIds` is every row the upsert did not report `unchanged` —
// `content_hash` already decided that, so nothing is diffed here. The
// registry node counts in `nodes` and `changedNodeIds` like any other row.

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { Database } from "@breakdown/db";
import {
  BEADS_SOURCE_SYSTEM,
  deriveBeadsEdges,
  mapBeadsIssueToNode,
  resolveBeadsEdges,
  type BeadsIssue,
} from "./beads.js";
import { upsertEdges } from "./edges.js";
import { BeadsProjectConflictError } from "./errors.js";
import { closeIngestRun, openIngestRun } from "./ingest-runs.js";
import { getNodes, getNodesByExternalId, MAX_EXTERNAL_ID_LOOKUPS } from "./lookup.js";
import { upsertNodes, type NodeInput } from "./nodes.js";

export const BEADS_PROJECT_NODE_TYPE = "beads_project";
export const BEADS_INGEST_ACTOR = "ingest:beads";

const execFileAsync = promisify(execFile);

/** Runs `bd <args>` in `cwd` and returns stdout. */
export type RunBd = (args: readonly string[], cwd: string) => Promise<string>;

export interface IngestBeadsCheckoutOptions {
  /** The checkout `bd` runs in; resolved to an absolute path. */
  dir: string;
  /** Registers and stamps this project key (contract form `[a-z0-9._-]{1,64}`). Omit for a project-less load. */
  project?: string;
  /** Replaces the `bd` invocation (tests). Default: `execFile("bd", …)`. */
  runBd?: RunBd;
}

export interface IngestBeadsCheckoutResult {
  project: string | null;
  /** The absolute checkout path. */
  path: string;
  nodes: { created: number; updated: number; unchanged: number };
  edges: { created: number; updated: number };
  changedNodeIds: string[];
  ingestRunId: string;
  issuesFetched: number;
  edgesDerived: number;
  skippedUnknownIssue: number;
  skippedUnknownType: number;
}

/** The default runner: `bd`'s own stderr is attached to the failure. */
export const defaultRunBd: RunBd = async (args, cwd) => {
  try {
    const { stdout } = await execFileAsync("bd", [...args], { cwd, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    const stderr = typeof (err as { stderr?: unknown }).stderr === "string" ? (err as { stderr: string }).stderr.trim() : "";
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`bd ${args.join(" ")} failed in ${cwd}: ${stderr || message}`);
  }
};

async function fetchIssues(runBd: RunBd, cwd: string): Promise<BeadsIssue[]> {
  const stdout = await runBd(["list", "--status=all", "--limit=0", "--json"], cwd);
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

/** Throws `BeadsProjectConflictError` when the load would take over another project's item or registry key; reads only. */
async function assertNoProjectConflict(db: Database, project: string, checkoutPath: string, issueIds: readonly string[]): Promise<void> {
  const registry = await getNodesByExternalId(db, [{ sourceSystem: BEADS_SOURCE_SYSTEM, externalId: `project:${project}` }]);
  const registryNodeId = registry.found[0]?.id;
  if (registryNodeId) {
    const { nodes } = await getNodes(db, [registryNodeId]);
    const registeredPath = nodes[0]?.metadata["path"];
    if (typeof registeredPath === "string" && registeredPath !== checkoutPath) {
      throw new BeadsProjectConflictError(project, "path", checkoutPath, registeredPath);
    }
  }

  for (let i = 0; i < issueIds.length; i += MAX_EXTERNAL_ID_LOOKUPS) {
    const chunk = issueIds.slice(i, i + MAX_EXTERNAL_ID_LOOKUPS);
    const { found } = await getNodesByExternalId(db, chunk.map((externalId) => ({ sourceSystem: BEADS_SOURCE_SYSTEM, externalId })));
    if (found.length === 0) continue;
    const { nodes } = await getNodes(db, found.map((f) => f.id));
    for (const node of nodes) {
      const owner = node.metadata["project"];
      if (typeof owner === "string" && owner !== project) {
        throw new BeadsProjectConflictError(project, "item", node.externalId, owner);
      }
    }
  }
}

/**
 * Loads one beads checkout. See the module header. Throws
 * `InvalidWorkItemError` (a bad `project` key, naming `project`, or a row
 * violating the contract), `BeadsProjectConflictError`, or the write
 * path's own errors; a failed `bd` or an empty export throws a plain
 * `Error`.
 */
export async function ingestBeadsCheckout(db: Database, options: IngestBeadsCheckoutOptions): Promise<IngestBeadsCheckoutResult> {
  const checkoutPath = path.resolve(options.dir);
  const project = options.project;
  const issues = await fetchIssues(options.runBd ?? defaultRunBd, checkoutPath);
  if (issues.length === 0) {
    throw new Error("no issues to ingest");
  }

  const nodeInputs: NodeInput[] = issues.map((issue, index) => mapBeadsIssueToNode(issue, index, project === undefined ? {} : { project }));
  if (project !== undefined) {
    nodeInputs.push({
      nodeType: BEADS_PROJECT_NODE_TYPE,
      sourceSystem: BEADS_SOURCE_SYSTEM,
      externalId: `project:${project}`,
      title: project,
      content: "",
      metadata: { project, path: checkoutPath },
    });
    await assertNoProjectConflict(db, project, checkoutPath, issues.map((i) => i.id));
  }
  const derived = deriveBeadsEdges(issues, new Set(issues.map((i) => i.id)));

  const run = await openIngestRun(db, BEADS_SOURCE_SYSTEM, { actor: BEADS_INGEST_ACTOR });
  const nodeResult = await upsertNodes(db, run, nodeInputs);
  const nodeIdByExternalId = new Map(nodeResult.rows.map((r) => [r.externalId, r.id]));
  const edgeResult = await upsertEdges(db, run, resolveBeadsEdges(derived.edges, nodeIdByExternalId));
  await closeIngestRun(db, run, {
    cwd: checkoutPath,
    project: project ?? null,
    issuesFetched: issues.length,
    edgesDerived: derived.edges.length,
    skippedUnknownIssue: derived.skippedUnknownIssue,
    skippedUnknownType: derived.skippedUnknownType,
  });

  return {
    project: project ?? null,
    path: checkoutPath,
    nodes: { created: nodeResult.created, updated: nodeResult.updated, unchanged: nodeResult.unchanged },
    edges: { created: edgeResult.created, updated: edgeResult.updated },
    changedNodeIds: nodeResult.rows.filter((r) => r.action !== "unchanged").map((r) => r.id),
    ingestRunId: run.id,
    issuesFetched: issues.length,
    edgesDerived: derived.edges.length,
    skippedUnknownIssue: derived.skippedUnknownIssue,
    skippedUnknownType: derived.skippedUnknownType,
  };
}
