// `pnpm ingest:repo <path> [--key <k>]` (git-repo-ingestor change, task
// 2.1): mirrors a local git checkout into the knowledge store as a tree
// of `file` and `directory` nodes joined by `child_of` edges under
// `source_system = 'git'`, so source code is full-text searchable and a
// code view has a tree to render.
//
// A script, not a library: the mapping and the working-tree read live in
// git-repo.ts (tested without git or a database); this file shells out
// to `git`, derives the key, opens one ingest run, hands the tree to
// `loadGitRepoTree`, and prints a summary — the same split as
// ingest-beads.ts and ingest-github.ts. Nothing below runs `git` or
// connects to the database at module scope.
//
// <path> is any directory inside the checkout: `git rev-parse
// --show-toplevel` resolves the checkout root, and that root is what is
// loaded, so `pnpm ingest:repo .` from the workspace root loads this
// repository even though pnpm runs the script from packages/core. A
// relative <path> resolves against the directory the command was typed
// in. pnpm exposes that as INIT_CWD, but `pnpm run` resets INIT_CWD to
// its own cwd and the root `ingest:repo` script is a nested
// `pnpm --filter @breakdown/core ingest:repo`, so this script would only
// ever see the workspace root; the root script captures its INIT_CWD
// into INGEST_REPO_CWD before the nested run, and that is read first
// here. The key is `owner/name` from the `origin` remote, else the root
// directory's name; `--key` overrides it. A checkout with no remote that
// later gains one would load a second tree under the derived key — pass
// `--key <old>` to keep loading the first.

import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { createDb, createPool, resolveDatabaseUrl } from "@breakdown/db";
import {
  buildRepoTree,
  closeIngestRun,
  deriveRepoKey,
  DIRECTORY_NODE_TYPE,
  FILE_NODE_TYPE,
  getStoreSummary,
  GIT_SOURCE_SYSTEM,
  loadGitRepoTree,
  openIngestRun,
  parseLsFiles,
  readWorkingTree,
  SKIP_REASONS,
  type SkipCounts,
} from "./index.js";

const execFileAsync = promisify(execFile);

/**
 * Stdout cap for `git ls-files -s -z`, whose output is one ~60-byte
 * record plus the path per tracked file: execFile's 1 MiB default holds
 * a few thousand files, this holds a few million. A repository larger
 * than that is out of scope until one is measured.
 */
const GIT_STDOUT_MAX_BUFFER = 256 * 1024 * 1024;

const USAGE = "usage: pnpm ingest:repo <path> [--key <owner/name>]";

interface CliArgs {
  checkoutPath: string;
  keyOverride: string | null;
}

function parseArgs(argv: readonly string[]): CliArgs {
  let checkoutPath: string | undefined;
  let keyOverride: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    // A blank value would fall through to the derived key in deriveRepoKey
    // — the opposite of what --key asks for — so it is a usage error.
    if (arg === "--key") {
      const value = argv[i + 1];
      if (value === undefined || value.trim() === "") throw new Error(`--key needs a non-empty value\n${USAGE}`);
      keyOverride = value;
      i += 1;
    } else if (arg.startsWith("--key=")) {
      const value = arg.slice("--key=".length);
      if (value.trim() === "") throw new Error(`--key needs a non-empty value\n${USAGE}`);
      keyOverride = value;
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown option ${JSON.stringify(arg)}\n${USAGE}`);
    } else if (checkoutPath === undefined) {
      checkoutPath = arg;
    } else {
      throw new Error(`unexpected argument ${JSON.stringify(arg)}\n${USAGE}`);
    }
  }
  if (checkoutPath === undefined) throw new Error(`missing <path>\n${USAGE}`);
  return { checkoutPath, keyOverride };
}

/** Runs `git <args>` in `cwd` and returns stdout, or throws with git's own stderr attached. */
async function git(args: readonly string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: GIT_STDOUT_MAX_BUFFER });
    return stdout;
  } catch (err) {
    const stderr = typeof (err as { stderr?: unknown }).stderr === "string" ? (err as { stderr: string }).stderr.trim() : "";
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${stderr || message}`);
  }
}

function formatSkips(skipped: SkipCounts): string {
  return SKIP_REASONS.map((reason) => `${reason}=${skipped[reason]}`).join(", ");
}

async function main(): Promise<void> {
  const { checkoutPath, keyOverride } = parseArgs(process.argv.slice(2));
  // INGEST_REPO_CWD is the directory the command was typed in, captured by
  // the root script (see the header); INIT_CWD covers `pnpm ingest:repo`
  // run from packages/core itself, where no nested `pnpm run` reset it.
  // `||` rather than `??`: the root script sets the variable to "" when
  // INIT_CWD is absent, and "" must fall through, not resolve.
  const requested = path.resolve(process.env["INGEST_REPO_CWD"] || process.env["INIT_CWD"] || process.cwd(), checkoutPath);
  if (!(await stat(requested).catch(() => null))?.isDirectory()) {
    throw new Error(`${requested} is not a directory\n${USAGE}`);
  }
  // Not a checkout: this is where git says so — before anything is read
  // and before any run is opened.
  const rootPath = (await git(["rev-parse", "--show-toplevel"], requested)).trim();

  let originUrl: string | null = null;
  try {
    originUrl = (await git(["remote", "get-url", "origin"], rootPath)).trim() || null;
  } catch {
    // `git remote get-url` exits non-zero when there is no such remote.
    // git has already answered for this checkout above, so that is the
    // only thing this can mean; the key falls back to the directory name.
  }
  const key = deriveRepoKey(originUrl, path.basename(rootPath), keyOverride);
  const keySource = keyOverride?.trim() ? "--key" : originUrl ? `origin ${originUrl}` : "the directory name (no origin remote)";

  const entries = parseLsFiles(await git(["ls-files", "-s", "-z"], rootPath));
  console.log(`[ingest:repo] ${rootPath}: ${entries.length} tracked file(s) via \`git ls-files -s -z\`; key ${key} from ${keySource}`);

  const { files, skipped } = await readWorkingTree(rootPath, entries);
  console.log(`[ingest:repo] ${files.length} file(s) to load; skipped ${formatSkips(skipped)}`);
  if (files.length === 0) {
    throw new Error("no loadable files to ingest");
  }
  const tree = buildRepoTree(key, rootPath, files);
  const directoryCount = tree.nodes.filter((n) => n.nodeType === DIRECTORY_NODE_TYPE).length;
  const fileCount = tree.nodes.filter((n) => n.nodeType === FILE_NODE_TYPE).length;

  const pool = createPool(resolveDatabaseUrl());
  const db = createDb(pool);
  try {
    // actor = the pnpm script name a person actually types.
    const run = await openIngestRun(db, GIT_SOURCE_SYSTEM, { actor: "ingest:repo" });
    const result = await loadGitRepoTree(db, run, tree);
    const closed = await closeIngestRun(db, run, {
      key,
      rootPath,
      originUrl,
      filesTracked: entries.length,
      filesLoaded: files.length,
      skipped,
    });
    const summary = await getStoreSummary(db);

    console.log(
      `[ingest:repo] nodes: ${result.nodes.created} created, ${result.nodes.updated} updated, ${result.nodes.unchanged} unchanged ` +
        `(1 repo, ${directoryCount} directories, ${fileCount} files)`,
    );
    console.log(`[ingest:repo] edges: ${result.edges.created} created, ${result.edges.updated} updated (${tree.edges.length} child_of)`);
    console.log(
      `[ingest:repo] ingest run ${closed.id} (source_system=${closed.sourceSystem}, actor=${closed.actor}) closed: ${closed.nodeCount} nodes, ${closed.edgeCount} edges attributed`,
    );
    console.log(`[ingest:repo] store totals: ${summary.totalNodes} nodes, ${summary.totalEdges} edges`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("[ingest:repo] failed:", err);
  process.exitCode = 1;
});
