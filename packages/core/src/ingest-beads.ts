// `pnpm ingest:beads [dir] [--project <key>]` (work-items change, task group
// 4; project registration in live-beads-board): mirrors the beads tracker
// into the knowledge store as `work_item` nodes under
// `source_system = 'beads'`, with `blocks` and `child_of` edges from its
// dependencies — the dogfood that lets `brain_ready` be checked against
// `bd ready` on this project's real backlog.
//
// A thin script: the load itself is `ingestBeadsCheckout` in
// beads-ingest.ts (the web server calls the same function); this file only
// parses arguments, owns the pool's lifecycle, and prints the summary.
// Nothing below runs `bd` or connects to the database at module scope
// beyond `main()`, and nothing imports this file.
//
// <dir> is the directory to run `bd` in (default: the directory the command
// was typed in), because beads keeps its store next to the checkout it
// belongs to and a worktree does not carry one. A relative <dir> resolves
// against that directory: the root `ingest:beads` script is a nested
// `pnpm --filter`, which resets INIT_CWD to the workspace package, so it
// captures its own INIT_CWD into INGEST_BEADS_CWD first (the same device
// `ingest:repo` uses, see ingest-git-repo.ts). `--project <key>` registers
// the checkout under that key and stamps its items; without it the load
// behaves as it always has.

import path from "node:path";
import { createDb, createPool, resolveDatabaseUrl } from "@breakdown/db";
import { getStoreSummary, ingestBeadsCheckout } from "./index.js";

const USAGE = "usage: pnpm ingest:beads [dir] [--project <key>]";

function parseArgs(argv: readonly string[]): { dir: string; project: string | undefined } {
  let dir: string | undefined;
  let project: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--project") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`--project needs a key. ${USAGE}`);
      project = value;
      i += 1;
    } else if (arg.startsWith("--project=")) {
      project = arg.slice("--project=".length);
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown option ${arg}. ${USAGE}`);
    } else if (dir === undefined) {
      dir = arg;
    } else {
      throw new Error(`unexpected argument ${arg}. ${USAGE}`);
    }
  }
  const base = process.env["INGEST_BEADS_CWD"] || process.env["INIT_CWD"] || process.cwd();
  return { dir: path.resolve(base, dir ?? "."), project };
}

async function main(): Promise<void> {
  const { dir, project } = parseArgs(process.argv.slice(2));
  const pool = createPool(resolveDatabaseUrl());
  const db = createDb(pool);
  try {
    const result = await ingestBeadsCheckout(db, { dir, ...(project === undefined ? {} : { project }) });
    const summary = await getStoreSummary(db);

    console.log(`[ingest:beads] fetched ${result.issuesFetched} issue(s) via \`bd list --status=all --limit=0 --json\` in ${result.path}${result.project === null ? "" : ` (project ${result.project})`}`);
    console.log(`[ingest:beads] nodes: ${result.nodes.created} created, ${result.nodes.updated} updated, ${result.nodes.unchanged} unchanged`);
    console.log(
      `[ingest:beads] edges: ${result.edges.created} created, ${result.edges.updated} updated, ${result.edgesDeleted} deleted ` +
        `(${result.edgesDerived} derived; skipped ${result.skippedUnknownIssue} naming an unknown issue, ${result.skippedUnknownType} of an unmapped type)`,
    );
    console.log(`[ingest:beads] ingest run ${result.ingestRunId} (source_system=beads, actor=ingest:beads) closed`);
    console.log(`[ingest:beads] store totals: ${summary.totalNodes} nodes, ${summary.totalEdges} edges`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("[ingest:beads] failed:", err);
  process.exitCode = 1;
});
