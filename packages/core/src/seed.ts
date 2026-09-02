// `pnpm db:seed` (bd-vt2.6, task 6.1): loads this repo's own markdown
// (docs/, openspec/) into the brain as nodes, with edges derived from real
// structure — markdown links where they exist, and OpenSpec's directory
// convention otherwise (see corpus.ts for the derivation and weighting
// scheme). Gives the brain its first real corpus, self-describing: a
// query about "merge invariant" or "why no embeddings" should surface the
// actual design documents.
//
// A script, not a library — reusable logic (node typing, title
// derivation, link/structural edge derivation) lives in corpus.ts and is
// exported from the package's public API; this file only walks the
// filesystem, calls that logic plus the public write-path API
// (openIngestRun/upsertNodes/upsertEdges/closeIngestRun), and reports
// what happened. Nothing below connects or reads the environment at
// module scope — every side effect happens inside main(), matching
// migrate.ts and apps/mcp/src/index.ts.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, createPool, resolveDatabaseUrl } from "@breakdown/db";
import {
  combineEdgeCandidates,
  deriveNodeType,
  deriveStructuralEdges,
  deriveTitle,
  extractMarkdownLinkTargets,
  LINKS_TO_WEIGHT,
  closeIngestRun,
  getStoreSummary,
  openIngestRun,
  upsertEdges,
  upsertNodes,
  type EdgeCandidate,
  type EdgeInput,
  type NodeInput,
} from "./index.js";

/** Directories under the repo root this seed loads markdown from. */
const CORPUS_DIRS = ["docs", "openspec"];
const SOURCE_SYSTEM = "repo";

interface CorpusFile {
  /** Repo-relative, forward-slash path — the node's externalId. */
  relPath: string;
  content: string;
}

/** Repo root: this file lives at packages/core/src/seed.ts. */
function findRepoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../..");
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/** Recursively collects every `*.md` file under `dir`, skipping dotfiles/dirs. */
async function walkMarkdown(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkMarkdown(full)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(full);
    }
  }
  return files;
}

async function loadCorpus(repoRoot: string): Promise<CorpusFile[]> {
  const files: CorpusFile[] = [];
  for (const dir of CORPUS_DIRS) {
    const absDir = path.join(repoRoot, dir);
    const absPaths = await walkMarkdown(absDir);
    for (const absPath of absPaths) {
      const relPath = toPosix(path.relative(repoRoot, absPath));
      const content = await readFile(absPath, "utf8");
      files.push({ relPath, content });
    }
  }
  files.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return files;
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
  const repoRoot = findRepoRoot();
  const files = await loadCorpus(repoRoot);
  if (files.length === 0) {
    throw new Error(`no markdown files found under ${CORPUS_DIRS.join(", ")} (repo root: ${repoRoot})`);
  }
  console.log(`[seed] found ${files.length} markdown file(s) under ${CORPUS_DIRS.join("/, ")}/`);

  const databaseUrl = resolveDatabaseUrl();
  const pool = createPool(databaseUrl);
  const db = createDb(pool);

  try {
    // actor = the pnpm script name a person actually types.
    const run = await openIngestRun(db, SOURCE_SYSTEM, { actor: "db:seed" });

    const nodeInputs: NodeInput[] = files.map((f) => ({
      nodeType: deriveNodeType(f.relPath),
      sourceSystem: SOURCE_SYSTEM,
      externalId: f.relPath,
      title: deriveTitle(f.relPath, f.content),
      content: f.content,
    }));
    const nodeResult = await upsertNodes(db, run, nodeInputs);

    const nodeIdByPath = new Map<string, string>();
    for (const row of nodeResult.rows) nodeIdByPath.set(row.externalId, row.id);

    // Explicit markdown links, resolved to repo-relative targets and kept
    // only where the target is itself part of this corpus — see
    // extractMarkdownLinkTargets's own doc comment on why an
    // out-of-corpus or dead link is silently not an edge.
    let linkTargetsFound = 0;
    const linkEdgeCandidates: EdgeCandidate[] = [];
    for (const f of files) {
      const targets = extractMarkdownLinkTargets(f.relPath, f.content);
      linkTargetsFound += targets.length;
      for (const target of targets) {
        if (target === f.relPath) continue;
        if (!nodeIdByPath.has(target)) continue;
        linkEdgeCandidates.push({ srcPath: f.relPath, dstPath: target, edgeType: "links-to", weight: LINKS_TO_WEIGHT });
      }
    }

    const structuralEdgeCandidates = deriveStructuralEdges(files.map((f) => f.relPath));
    const edgeCandidates = combineEdgeCandidates(linkEdgeCandidates, structuralEdgeCandidates);

    const edgeInputs: EdgeInput[] = edgeCandidates.map((e) => ({
      srcId: nodeIdByPath.get(e.srcPath)!,
      dstId: nodeIdByPath.get(e.dstPath)!,
      edgeType: e.edgeType,
      sourceSystem: SOURCE_SYSTEM,
      weight: e.weight,
    }));
    const edgeResult = await upsertEdges(db, run, edgeInputs);

    const closed = await closeIngestRun(db, run, {
      filesRead: files.length,
      corpusDirs: CORPUS_DIRS,
    });

    const summary = await getStoreSummary(db);

    console.log(`[seed] nodes: ${nodeResult.created} created, ${nodeResult.updated} updated, ${nodeResult.unchanged} unchanged`);
    console.log(
      `[seed] edges: ${edgeResult.created} created, ${edgeResult.updated} updated ` +
        `(${linkTargetsFound} markdown link target(s) found, ${linkEdgeCandidates.length} resolved to an in-corpus node)`,
    );
    console.log(`[seed]   by type: ${formatCounts(countBy(edgeCandidates, (e) => e.edgeType))}`);
    console.log(`[seed] ingest run ${closed.id} (source_system=${closed.sourceSystem}) closed: ${closed.nodeCount} nodes, ${closed.edgeCount} edges attributed`);
    console.log(`[seed] store totals: ${summary.totalNodes} nodes, ${summary.totalEdges} edges`);
    console.log(`[seed]   node types: ${formatCounts(new Map(summary.nodeTypes.map((t) => [t.nodeType, t.count])))}`);
    console.log(`[seed]   edge types: ${formatCounts(new Map(summary.edgeTypes.map((t) => [t.edgeType, t.count])))}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("[seed] failed:", err);
  process.exitCode = 1;
});
