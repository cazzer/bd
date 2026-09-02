// `pnpm ingest:beads [dir]` (work-items change, task group 4): mirrors the
// beads tracker into the knowledge store as `work_item` nodes under
// `source_system = 'beads'`, with `blocks` and `child_of` edges from its
// dependencies — the dogfood that lets `brain_ready` be checked against
// `bd ready` on this project's real backlog.
//
// A script, not a library: the mapping lives in beads.ts (pure, tested);
// this file shells out to `bd list --status=all --json`, calls the public
// write-path API, and prints a summary — the same split as
// ingest-github.ts. It reads only from beads; nothing is written back.
// Nothing below runs `bd` or connects to the database at module scope.
//
// The optional argument is the directory to run `bd` in (default: the
// current directory), because beads keeps its store next to the checkout
// it belongs to and a worktree does not carry one.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createDb, createPool, resolveDatabaseUrl } from "@breakdown/db";
import {
  BEADS_SOURCE_SYSTEM,
  closeIngestRun,
  deriveBeadsEdges,
  getStoreSummary,
  mapBeadsIssueToNode,
  openIngestRun,
  resolveBeadsEdges,
  upsertEdges,
  upsertNodes,
  type BeadsIssue,
  type NodeInput,
} from "./index.js";

const execFileAsync = promisify(execFile);

/** Runs `bd <args>` in `cwd` and returns stdout, or throws with `bd`'s own stderr attached. */
async function bd(args: readonly string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("bd", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    const stderr = typeof (err as { stderr?: unknown }).stderr === "string" ? (err as { stderr: string }).stderr.trim() : "";
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`bd ${args.join(" ")} failed in ${cwd}: ${stderr || message}`);
  }
}

async function fetchIssues(cwd: string): Promise<BeadsIssue[]> {
  const stdout = await bd(["list", "--status=all", "--json"], cwd);
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

async function main(): Promise<void> {
  const cwd = process.argv[2] ?? process.cwd();
  const issues = await fetchIssues(cwd);
  console.log(`[ingest:beads] fetched ${issues.length} issue(s) via \`bd list --status=all --json\` in ${cwd}`);
  if (issues.length === 0) {
    throw new Error("no issues to ingest");
  }

  const nodeInputs: NodeInput[] = issues.map((issue, index) => mapBeadsIssueToNode(issue, index));
  const knownIds = new Set(issues.map((i) => i.id));
  const derived = deriveBeadsEdges(issues, knownIds);

  const pool = createPool(resolveDatabaseUrl());
  const db = createDb(pool);
  try {
    // actor = the pnpm script name a person actually types.
    const run = await openIngestRun(db, BEADS_SOURCE_SYSTEM, { actor: "ingest:beads" });

    const nodeResult = await upsertNodes(db, run, nodeInputs);
    const nodeIdByExternalId = new Map(nodeResult.rows.map((r) => [r.externalId, r.id]));
    const edgeResult = await upsertEdges(db, run, resolveBeadsEdges(derived.edges, nodeIdByExternalId));

    const closed = await closeIngestRun(db, run, {
      cwd,
      issuesFetched: issues.length,
      edgesDerived: derived.edges.length,
      skippedUnknownIssue: derived.skippedUnknownIssue,
      skippedUnknownType: derived.skippedUnknownType,
    });
    const summary = await getStoreSummary(db);

    console.log(`[ingest:beads] nodes: ${nodeResult.created} created, ${nodeResult.updated} updated, ${nodeResult.unchanged} unchanged`);
    console.log(
      `[ingest:beads] edges: ${edgeResult.created} created, ${edgeResult.updated} updated ` +
        `(${derived.edges.length} derived; skipped ${derived.skippedUnknownIssue} naming an unknown issue, ${derived.skippedUnknownType} of an unmapped type)`,
    );
    console.log(`[ingest:beads] ingest run ${closed.id} (source_system=${closed.sourceSystem}, actor=${closed.actor}) closed: ${closed.nodeCount} nodes, ${closed.edgeCount} edges attributed`);
    console.log(`[ingest:beads] store totals: ${summary.totalNodes} nodes, ${summary.totalEdges} edges`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("[ingest:beads] failed:", err);
  process.exitCode = 1;
});
