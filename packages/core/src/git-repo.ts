// Git repository loader (git-repo-ingestor change; commits in
// github-prs-and-commits): the pure mapping from `git ls-files` records
// and file bytes to `NodeInput`s and `child_of` edge candidates, the pure
// parse of `git log` records into commits and commit nodes, plus the two
// pieces of I/O the loader needs — `readWorkingTree`, which stats,
// classifies, and reads each tracked entry (here rather than in the
// script so the decisions that depend on the filesystem, a missing file
// or a control byte, are tested against a temp directory without git or a
// database), and the one write-path composition, nodes then edges inside
// a single transaction. The script in ingest-git-repo.ts runs `git`,
// opens the ingest run, and prints the summary. Same split as beads.ts /
// ingest-beads.ts and github.ts / ingest-github.ts.
//
// Shapes (design.md): the root is a `repo` node with external id `<key>`;
// every directory on the path from a loaded file to the root is a
// `directory` node and every loaded file a `file` node, both with external
// id `<key>:<path>`. Each non-root node has exactly one `child_of` edge to
// its containing directory (the root's children point at the `repo`
// node), so a tree walk upward is one indexed probe per level. Titles are
// base names; a directory's content lists its direct children; a file's
// content is its text and its metadata is flat scalars so `listNodes`'s
// predicates can select on `language`, `size_bytes`, and the rest.
//
// Commits (github-prs-and-commits design.md decision 2) are a second
// record kind in the same batch: one `commit` node per `git log` record,
// keyed `<key>@<sha>`, subject as title, the whole message as content,
// `occurred_at` at the committer instant — the moment the commit entered
// the history the timeline shows; a rebase rewrites it and leaves the
// author date, which is kept beside it. Each commit is joined
// `belongs-to` the root, `touches` each changed path that is a `file` row
// of the same load, and `mentions` each GitHub issue or pull request its
// message names, resolved through `getNodesByExternalId`. A path with no
// row and a reference that resolves to nothing are counted, never fatal:
// history is allowed to name what the tree no longer holds and what the
// store has not loaded.

import type { Stats } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Database } from "@breakdown/db";
import {
  DEFAULT_EDGE_CHUNK_SIZE,
  unsafeBuildUpsertEdgesQuery,
  unsafePrepareEdges,
  unsafeWrapEdgeWriteError,
  type EdgeInput,
  type UpsertEdgeRow,
  type UpsertEdgesResult,
} from "./edges.js";
import { normalizeOccurredAt, OCCURRED_AT_KEY } from "./event-time.js";
import {
  BELONGS_TO_EDGE_TYPE,
  BELONGS_TO_WEIGHT,
  extractIssueReferences,
  GITHUB_SOURCE_SYSTEM,
  MENTIONS_EDGE_TYPE,
  MENTIONS_WEIGHT,
  REPO_NODE_TYPE,
  type ParsedReference,
} from "./github.js";
import type { IngestRunHandle } from "./ingest-runs.js";
import { getNodesByExternalId, MAX_EXTERNAL_ID_LOOKUPS, type ExternalIdPair } from "./lookup.js";
import {
  CONTROL_CHAR_CODE_POINTS,
  DEFAULT_MAX_CONTENT_LENGTH,
  DEFAULT_MAX_METADATA_LENGTH,
  DEFAULT_MAX_TITLE_LENGTH,
  DEFAULT_NODE_CHUNK_SIZE,
  unsafeBuildUpsertNodesQuery,
  unsafePrepareNodes,
  unsafeWrapNodeWriteError,
  type NodeInput,
  type UpsertNodeRow,
  type UpsertNodesResult,
} from "./nodes.js";
import { chunk } from "./sql-helpers.js";
import { CHILD_OF_EDGE_TYPE } from "./work-items.js";

/** `source_system` for every node and edge this loader writes. Distinct from the markdown seed's `"repo"` on purpose (proposal.md): reusing it would retype every seeded doc to `file`. */
export const GIT_SOURCE_SYSTEM = "git";

export const FILE_NODE_TYPE = "file";
export const DIRECTORY_NODE_TYPE = "directory";

/** Containment is structural, not inferred: weight 1.0. */
export const GIT_EDGE_WEIGHT = 1.0;

/**
 * Largest file that gets a node, in bytes. Far below `upsertNodes`'s
 * 1,000,000-character content cap on purpose: the generated tsvector over
 * a 1 MB source file can exceed Postgres's 1 MB tsvector limit and fail
 * the whole batch with an error that names no path (design.md).
 */
export const MAX_FILE_BYTES = 256 * 1024;

/**
 * Byte-indexed view of `CONTROL_CHAR_CODE_POINTS` (nodes.ts): the set
 * `unsafePrepareNodes` refuses anywhere in a node's content — NUL, the
 * other C0 controls except tab, LF, and CR, and DEL. Every member is
 * below 0x80, and a UTF-8 byte below 0x80 is its own code point, so a
 * scan over the raw bytes finds exactly the characters the decoded text
 * would be rejected for. Built from the store's set rather than
 * restated so the two cannot drift.
 */
const CONTROL_BYTES = new Uint8Array(256);
for (const codePoint of CONTROL_CHAR_CODE_POINTS) CONTROL_BYTES[codePoint] = 1;

/** Exact base names that are generated artifacts, never worth a node. */
export const GENERATED_FILE_NAMES: readonly string[] = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lockb"];

/** Base-name suffixes that mark minified bundles and source maps. */
export const GENERATED_FILE_SUFFIXES: readonly string[] = [".min.js", ".min.css", ".map"];

/** Lower-cased extension → `language`. Anything not listed gets no `language` key at all, so `equals`/`oneOf` predicates on it never see a null. */
export const LANGUAGE_BY_EXTENSION: ReadonlyMap<string, string> = new Map([
  ["ts", "typescript"],
  ["tsx", "typescript"],
  ["js", "javascript"],
  ["mjs", "javascript"],
  ["cjs", "javascript"],
  ["jsx", "javascript"],
  ["md", "markdown"],
  ["json", "json"],
  ["yaml", "yaml"],
  ["yml", "yaml"],
  ["sql", "sql"],
  ["css", "css"],
  ["html", "html"],
  ["sh", "shell"],
  ["py", "python"],
  ["go", "go"],
  ["rs", "rust"],
  ["toml", "toml"],
]);

/** `git ls-files -s` mode bits for entries that are not regular files and are never read. */
export const SYMLINK_MODE = "120000";
export const SUBMODULE_MODE = "160000";

// --- git ls-files ------------------------------------------------------

/** One tracked regular file, as `git ls-files -s -z` reports it. */
export interface LsFilesEntry {
  /** Repository-relative, forward-slash, exactly as git printed it. */
  path: string;
  /** Git's blob id for the tracked content — what a future incremental run compares against. */
  blobSha: string;
  /** The entry's mode bits (`100644`, `100755`). */
  mode: string;
}

const LS_FILES_META_RE = /^([0-7]{6}) ([0-9a-f]+) ([0-3])$/;

/**
 * Parses `git ls-files -s -z` output: NUL-terminated
 * `<mode> <sha> <stage>\t<path>` records. Symlinks (`120000`) and
 * submodules (`160000`) are dropped here so nothing downstream ever
 * reads them from disk. A path listed at several merge stages (an
 * unresolved conflict) is kept once, at the first stage seen — the
 * working tree holds one file either way. Throws on a record that is
 * not in this shape, which is what feeding it plain `git ls-files`
 * output looks like.
 */
export function parseLsFiles(stdout: string): LsFilesEntry[] {
  const entries: LsFilesEntry[] = [];
  const seen = new Set<string>();
  for (const record of stdout.split("\0")) {
    if (record.length === 0) continue;
    const tab = record.indexOf("\t");
    const meta = tab === -1 ? null : LS_FILES_META_RE.exec(record.slice(0, tab));
    const path = tab === -1 ? "" : record.slice(tab + 1);
    if (!meta || path.length === 0) {
      throw new Error(`parseLsFiles: malformed \`git ls-files -s -z\` record ${JSON.stringify(record.slice(0, 200))}`);
    }
    const [, mode, blobSha] = meta;
    if (mode === SYMLINK_MODE || mode === SUBMODULE_MODE) continue;
    if (seen.has(path)) continue;
    seen.add(path);
    entries.push({ path, blobSha: blobSha!, mode: mode! });
  }
  return entries;
}

// --- Repository key ----------------------------------------------------

/**
 * `owner/name` from a remote URL, or null when the URL has fewer than
 * two path segments. A trailing `.git` and trailing slashes are stripped,
 * then the last two segments are taken splitting on both `/` and `:`, so
 * the scp-like ssh form (`git@github.com:owner/name.git`), the https form
 * with or without `.git`, and `ssh://git@github.com/owner/name.git` all
 * reduce the same way.
 */
function repoSlugFromRemoteUrl(url: string): string | null {
  let trimmed = url.replace(/\/+$/, "");
  if (trimmed.endsWith(".git")) trimmed = trimmed.slice(0, -".git".length);
  trimmed = trimmed.replace(/\/+$/, "");
  const segments = trimmed.split(/[/:]/).filter((s) => s.length > 0);
  const name = segments[segments.length - 1];
  const owner = segments[segments.length - 2];
  if (!name || !owner) return null;
  return `${owner}/${name}`;
}

/**
 * The repository key that prefixes every external id this loader writes
 * (design.md): `override` when given, else `owner/name` from the `origin`
 * remote when there is one, else the checkout directory's base name. A
 * checkout with no remote therefore loads under its directory name and
 * would load a second time under the derived key once it gains one —
 * the script's usage text documents `--key` for exactly that.
 */
export function deriveRepoKey(originUrl: string | null, dirName: string, override?: string | null): string {
  const forced = override?.trim();
  if (forced) return forced;
  const url = originUrl?.trim();
  if (url) {
    const slug = repoSlugFromRemoteUrl(url);
    if (slug) return slug;
  }
  const dir = dirName.trim();
  if (!dir) {
    throw new Error("deriveRepoKey: the checkout directory name is empty and no remote or override supplied a key");
  }
  return dir;
}

// --- Classification -----------------------------------------------------

/**
 * Why a tracked entry got no node. `missing` is an index entry with no
 * file in the working tree — a sparse checkout, or a file removed with
 * `rm` rather than `git rm`. The loader mirrors the working tree, and a
 * sparse checkout lists absent files by design, so that is "not in the
 * checkout", counted and reported, not a failure (design.md).
 */
export type SkipReason = "generated" | "size" | "binary" | "missing";
export type FileClassification = "load" | SkipReason;

/** Every `SkipReason`, in the order the summary reports them. */
export const SKIP_REASONS: readonly SkipReason[] = ["generated", "size", "binary", "missing"];

export type SkipCounts = Record<SkipReason, number>;

export function emptySkipCounts(): SkipCounts {
  return { generated: 0, size: 0, binary: 0, missing: 0 };
}

export interface ClassifyFileInput {
  path: string;
  /** From `stat`, before anything is read. */
  sizeBytes: number;
  /** The file's whole content — at most `MAX_FILE_BYTES` once the size check has passed. Every byte is inspected. */
  bytes: Uint8Array;
}

function baseName(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

function isGeneratedFileName(name: string): boolean {
  return GENERATED_FILE_NAMES.includes(name) || GENERATED_FILE_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

function containsControlByte(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; i += 1) {
    if (CONTROL_BYTES[bytes[i]!] === 1) return true;
  }
  return false;
}

/**
 * Decides whether a tracked file gets a node. Reasons are checked in a
 * fixed order — generated name, then size against `MAX_FILE_BYTES`, then
 * any byte in the store's control set anywhere in the content — so a
 * lockfile over the size cap reports `generated`, the reason a person
 * would act on, not `size`. The name and size checks need nothing read
 * from disk; the caller can pass empty `bytes` when either of those
 * already decides, and read the file only once they have not.
 *
 * The control scan covers the whole file, not git's 8 KiB NUL window,
 * because `unsafePrepareNodes` rejects the same set at any position and
 * one rejected node aborts the whole load: a form feed in a Python file
 * or an ANSI escape in a test snapshot would otherwise fail every file in
 * the run. Such a file is reported `binary` — not text the store holds.
 */
export function classifyFile({ path, sizeBytes, bytes }: ClassifyFileInput): FileClassification {
  if (isGeneratedFileName(baseName(path))) return "generated";
  if (sizeBytes > MAX_FILE_BYTES) return "size";
  if (containsControlByte(bytes)) return "binary";
  return "load";
}

/** `language` from the extension alone (lower-cased); undefined when the map has no entry, or the name has no extension (`Makefile`, `.gitignore`). */
export function deriveLanguage(path: string): string | undefined {
  const name = baseName(path);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return undefined;
  return LANGUAGE_BY_EXTENSION.get(name.slice(dot + 1).toLowerCase());
}

/** Newline count, plus one when the text is non-empty and does not end in a newline. Empty text has no lines. */
export function countLines(text: string): number {
  if (text.length === 0) return 0;
  let newlines = 0;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) newlines += 1;
  return text.endsWith("\n") ? newlines : newlines + 1;
}

// --- Working tree ------------------------------------------------------

/** A file that passed `classifyFile`, read from the working tree. */
export interface LoadableFile {
  path: string;
  blobSha: string;
  /** From `stat` — the byte length on disk, not `text.length`. */
  sizeBytes: number;
  text: string;
}

export interface WorkingTreeRead {
  /** Every entry that gets a node, in `entries` order. */
  files: LoadableFile[];
  skipped: SkipCounts;
}

const NO_BYTES = new Uint8Array(0);
const utf8 = new TextDecoder();

function errnoCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Stats, classifies, and reads each `git ls-files` entry under
 * `rootPath`. Name and size are decided from `stat` alone; only an entry
 * that passes both is read, and then its whole content is scanned. An
 * entry with no file on disk (`ENOENT`) is counted as `missing` and
 * skipped — see `SkipReason`. Any other failure — a permission error, or
 * a directory where a regular file is tracked — is not a state of the
 * checkout this loader mirrors, so it throws naming the path rather than
 * leaving a hole the summary would not explain.
 */
export async function readWorkingTree(rootPath: string, entries: readonly LsFilesEntry[]): Promise<WorkingTreeRead> {
  const files: LoadableFile[] = [];
  const skipped = emptySkipCounts();
  for (const entry of entries) {
    const absolute = join(rootPath, entry.path);
    let stats: Stats;
    try {
      stats = await stat(absolute);
    } catch (err) {
      if (errnoCode(err) === "ENOENT") {
        skipped.missing += 1;
        continue;
      }
      throw new Error(`readWorkingTree: cannot stat ${entry.path}: ${describe(err)}`, { cause: err });
    }
    if (!stats.isFile()) {
      throw new Error(`readWorkingTree: ${entry.path} is tracked as a regular file but is not one in the working tree`);
    }
    const beforeRead = classifyFile({ path: entry.path, sizeBytes: stats.size, bytes: NO_BYTES });
    if (beforeRead !== "load") {
      skipped[beforeRead] += 1;
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = await readFile(absolute);
    } catch (err) {
      throw new Error(`readWorkingTree: cannot read ${entry.path}: ${describe(err)}`, { cause: err });
    }
    const decision = classifyFile({ path: entry.path, sizeBytes: stats.size, bytes });
    if (decision !== "load") {
      skipped[decision] += 1;
      continue;
    }
    files.push({ path: entry.path, blobSha: entry.blobSha, sizeBytes: stats.size, text: utf8.decode(bytes) });
  }
  return { files, skipped };
}

// --- Tree ----------------------------------------------------------------

/** A `child_of` edge by external id: `src` is the child. Resolved to node ids after the node upsert returns. */
export interface GitRepoEdgeCandidate {
  srcExternalId: string;
  dstExternalId: string;
}

export interface GitRepoTree {
  key: string;
  rootPath: string;
  /** The `repo` node first, then directories and files, each group sorted by path. */
  nodes: NodeInput[];
  /** Exactly one per non-root node, in the same order as `nodes` minus the root. */
  edges: GitRepoEdgeCandidate[];
}

/** External id for an entry (`<key>:<path>`), or for the root when `path` is omitted (`<key>`). */
export function gitExternalId(key: string, path?: string): string {
  return path ? `${key}:${path}` : key;
}

function validateRelativePath(path: string): string[] {
  const segments = path.split("/");
  if (path.length === 0 || segments.some((s) => s.length === 0 || s === "." || s === "..")) {
    throw new Error(`buildRepoTree: ${JSON.stringify(path)} is not a normalized repository-relative path`);
  }
  // `unsafePrepareNodes` trims every external id, so a path with trailing
  // whitespace would be stored under a different id than the one its
  // `child_of` candidate names and fail inside the transaction. The same
  // holds per segment: `dir /a.ts` stores the directory as `<key>:dir`
  // while the file's candidate still names `<key>:dir `. Refused here,
  // before any run is opened, naming the path.
  if (path !== path.trim() || segments.some((s) => s !== s.trim())) {
    throw new Error(`buildRepoTree: ${JSON.stringify(path)} has leading or trailing whitespace, which the store trims from external ids`);
  }
  return segments;
}

/**
 * Builds every node and edge candidate for one load. Each file's
 * ancestor directories are materialized once (a directory with no loaded
 * file beneath it does not appear), and every directory and file gets
 * one `child_of` candidate to its parent — the root's children point at
 * the `repo` node. Output order is deterministic (root, then directories
 * by path, then files by path) so two runs over the same input produce
 * the same batch.
 */
export function buildRepoTree(key: string, rootPath: string, files: readonly LoadableFile[]): GitRepoTree {
  const trimmedKey = key.trim();
  if (!trimmedKey) throw new Error("buildRepoTree: key must be a non-empty string");

  // Direct children by directory path; "" is the root.
  const childrenOf = new Map<string, Set<string>>([["", new Set<string>()]]);
  const seenFiles = new Set<string>();
  for (const file of files) {
    const segments = validateRelativePath(file.path);
    if (seenFiles.has(file.path)) throw new Error(`buildRepoTree: ${JSON.stringify(file.path)} is listed twice`);
    seenFiles.add(file.path);
    let parent = "";
    for (const [i, segment] of segments.entries()) {
      childrenOf.get(parent)!.add(segment);
      if (i === segments.length - 1) break;
      const dir = parent ? `${parent}/${segment}` : segment;
      if (!childrenOf.has(dir)) childrenOf.set(dir, new Set<string>());
      parent = dir;
    }
  }

  const listing = (dir: string): string => [...childrenOf.get(dir)!].sort().join("\n");
  const parentOf = (path: string): string => {
    const slash = path.lastIndexOf("/");
    return slash === -1 ? "" : path.slice(0, slash);
  };

  const nodes: NodeInput[] = [
    {
      nodeType: REPO_NODE_TYPE,
      sourceSystem: GIT_SOURCE_SYSTEM,
      externalId: gitExternalId(trimmedKey),
      title: trimmedKey,
      content: listing(""),
      metadata: { key: trimmedKey, root_path: rootPath },
    },
  ];
  const edges: GitRepoEdgeCandidate[] = [];

  const directories = [...childrenOf.keys()].filter((dir) => dir !== "").sort();
  for (const dir of directories) {
    nodes.push({
      nodeType: DIRECTORY_NODE_TYPE,
      sourceSystem: GIT_SOURCE_SYSTEM,
      externalId: gitExternalId(trimmedKey, dir),
      title: baseName(dir),
      content: listing(dir),
      metadata: { path: dir },
    });
    edges.push({ srcExternalId: gitExternalId(trimmedKey, dir), dstExternalId: gitExternalId(trimmedKey, parentOf(dir)) });
  }

  const sortedFiles = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const file of sortedFiles) {
    const language = deriveLanguage(file.path);
    nodes.push({
      nodeType: FILE_NODE_TYPE,
      sourceSystem: GIT_SOURCE_SYSTEM,
      externalId: gitExternalId(trimmedKey, file.path),
      title: baseName(file.path),
      content: file.text,
      metadata: {
        path: file.path,
        size_bytes: file.sizeBytes,
        line_count: countLines(file.text),
        blob_sha: file.blobSha,
        ...(language === undefined ? {} : { language }),
      },
    });
    edges.push({ srcExternalId: gitExternalId(trimmedKey, file.path), dstExternalId: gitExternalId(trimmedKey, parentOf(file.path)) });
  }

  return { key: trimmedKey, rootPath, nodes, edges };
}

// --- git log ---------------------------------------------------------------

export const COMMIT_NODE_TYPE = "commit";

/**
 * commit -> a file it changed that this load wrote. Git's own diff names
 * the path, but a commit is about the repository first and the file second:
 * 0.8, below `belongs-to`, so a commit reads `belongs-to` on the
 * repository's timeline and `touches` on a file's (design.md decision 5).
 */
export const TOUCHES_EDGE_TYPE = "touches";
export const TOUCHES_WEIGHT = 0.8;

/** Commits loaded when `--commits` is not given: the newest 500. `0` disables commits entirely. */
export const COMMITS_DEFAULT = 500;

/**
 * `--format` for `git log --name-only`: a record separator (0x1e) opens
 * each commit, then sha, parents, author instant, committer instant,
 * author name, subject, and body, each terminated by NUL; the paths
 * `--name-only` appends run until the next separator. Git refuses a NUL
 * in a commit message, so the seven fields split exactly; `parseGitLog`
 * counts them and rejects a record that does not, rather than
 * misattributing a body to the wrong field.
 */
export const GIT_LOG_FORMAT = "%x1e%H%x00%P%x00%aI%x00%cI%x00%an%x00%s%x00%b%x00";

const GIT_LOG_RECORD_SEPARATOR = "\x1e";
const GIT_LOG_FIELD_SEPARATOR = "\x00";
const GIT_LOG_FIELD_COUNT = 7;

/** A full object name: 40 hex digits (SHA-1) or 64 (SHA-256 repositories). */
const COMMIT_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** One commit as `parseGitLog` reads it from `GIT_LOG_FORMAT` output. */
export interface GitCommit {
  sha: string;
  /** Parent shas in `%P` order: none for a root commit, two or more for a merge. */
  parents: string[];
  /** `%aI` — the author instant, ISO-8601 with its zone. */
  authoredAt: string;
  /** `%cI` — the committer instant, ISO-8601 with its zone; where `occurred_at` comes from. */
  committedAt: string;
  /** `%an` — the author's name. No e-mail is read. */
  author: string;
  subject: string;
  /** `%b` without the trailing newline git stores; `""` when the message is its subject alone. Blank lines inside the body are kept. */
  body: string;
  /** The paths the commit changed, as `--name-only` lists them: none for a merge commit, which `git log` shows without a diff. */
  paths: string[];
}

/**
 * Parses `git log -n <N> --name-only --format=<GIT_LOG_FORMAT>` output.
 * Pure. Records split on the record separator (the text before the first
 * one is empty for real output and rejected otherwise); each record's
 * first seven NUL-terminated fields are the commit and what follows is
 * `--name-only`'s listing — git's line break, a blank line, then one path
 * per line — read as the non-empty lines. A record with the wrong field
 * count (a message carrying a stray record separator, or output not in
 * this format at all) throws naming the sha when the first field is one
 * and the record's index otherwise. Empty output is no commits.
 */
export function parseGitLog(stdout: string): GitCommit[] {
  const records = stdout.split(GIT_LOG_RECORD_SEPARATOR);
  if (records[0]!.length > 0) {
    throw new Error(
      `parseGitLog: output before the first record separator ${JSON.stringify(records[0]!.slice(0, 200))}; is this \`git log --format=<GIT_LOG_FORMAT> --name-only\` output?`,
    );
  }
  const commits: GitCommit[] = [];
  for (const [index, record] of records.slice(1).entries()) {
    const parts = record.split(GIT_LOG_FIELD_SEPARATOR);
    const sha = parts[0]!;
    const name = COMMIT_SHA_RE.test(sha) ? `commit ${sha}` : `record ${index}`;
    if (parts.length !== GIT_LOG_FIELD_COUNT + 1) {
      throw new Error(`parseGitLog: malformed ${name}: expected ${GIT_LOG_FIELD_COUNT} NUL-terminated fields, found ${parts.length - 1}`);
    }
    if (!COMMIT_SHA_RE.test(sha)) {
      throw new Error(`parseGitLog: malformed ${name}: ${JSON.stringify(sha.slice(0, 80))} is not a commit sha`);
    }
    const [, parentField, authoredAt, committedAt, author, subject, body, listing] = parts as [string, string, string, string, string, string, string, string];
    commits.push({
      sha,
      parents: parentField.split(" ").filter((p) => p.length > 0),
      authoredAt,
      committedAt,
      author,
      subject,
      body: body.replace(/\n+$/, ""),
      paths: listing.split("\n").filter((line) => line.length > 0),
    });
  }
  return commits;
}

/** External id for a commit: `<key>@<sha>`. `@` rather than `:` so a commit can never collide with an entry's `<key>:<path>`, and reads as "the repository at this commit". */
export function commitExternalId(key: string, sha: string): string {
  return `${key}@${sha}`;
}

/** The whole message, as git would print it: subject, a blank line, body — the subject alone when there is no body. Content of the node and the text scanned for references. */
function commitMessage(commit: GitCommit): string {
  return commit.body.length === 0 ? commit.subject : `${commit.subject}\n\n${commit.body}`;
}

/**
 * One `commit` node per commit: subject as title, the whole message as
 * content, metadata carrying the sha, parents, author name, both instants
 * as git printed them, and the changed-path count, and `occurred_at` from
 * the committer instant through `normalizeOccurredAt` (`%cI` carries a
 * zone, so it canonicalizes; an instant that does not parse rejects
 * naming `(git/<key>@<sha>)`). Pure; the key is trimmed as
 * `buildRepoTree` trims it, so the two agree on every external id.
 */
export function buildCommitNodes(key: string, commits: readonly GitCommit[]): NodeInput[] {
  const trimmedKey = key.trim();
  if (!trimmedKey) throw new Error("buildCommitNodes: key must be a non-empty string");
  return commits.map((commit) => {
    const externalId = commitExternalId(trimmedKey, commit.sha);
    return {
      nodeType: COMMIT_NODE_TYPE,
      sourceSystem: GIT_SOURCE_SYSTEM,
      externalId,
      title: commit.subject,
      content: commitMessage(commit),
      metadata: normalizeOccurredAt(
        {
          sha: commit.sha,
          parents: commit.parents,
          author: commit.author,
          authored_at: commit.authoredAt,
          committed_at: commit.committedAt,
          files_changed: commit.paths.length,
          [OCCURRED_AT_KEY]: commit.committedAt,
        },
        { itemLabel: `(${GIT_SOURCE_SYSTEM}/${externalId})` },
      ),
    };
  });
}

// One segment of a GitHub `owner/name` slug — the grammar
// `extractIssueReferences` accepts for the slug half of a cross-repository
// reference, restated here because that pattern is private to github.ts
// and anchored differently (it matches inside prose; this matches a whole
// key).
const REPO_SLUG_SEGMENT = "[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?";
const REPO_SLUG_RE = new RegExp(`^${REPO_SLUG_SEGMENT}/${REPO_SLUG_SEGMENT}$`);

/**
 * Whether a repository key is an `owner/name` slug — what `deriveRepoKey`
 * makes of a GitHub remote and what the GitHub loader keys its nodes by —
 * so a same-repo `#N` in a commit message can be resolved as `<key>#N`
 * under `github`. A key that is not (`bd`, a directory name) names no
 * store identity, and the loader counts every reference unresolved
 * instead of asking.
 */
export function isRepoSlug(key: string): boolean {
  return REPO_SLUG_RE.test(key);
}

/** The `github` external id a reference names: `owner/repo#N` as written, or `<key>#N` for a same-repo `#N`. */
function referenceExternalId(key: string, ref: ParsedReference): string {
  return `${ref.ownerRepo ?? key}#${ref.number}`;
}

/**
 * Every distinct GitHub identity the commit messages reference, in first
 * seen order, as `getNodesByExternalId` pairs under `github` — what
 * `loadGitRepoTree` resolves before its transaction opens. Meaningful when
 * `key` is a slug (`isRepoSlug`); the caller decides whether to ask.
 */
export function collectCommitReferences(key: string, commits: readonly GitCommit[]): ExternalIdPair[] {
  const seen = new Set<string>();
  const pairs: ExternalIdPair[] = [];
  for (const commit of commits) {
    for (const ref of extractIssueReferences(commitMessage(commit))) {
      const externalId = referenceExternalId(key, ref);
      if (seen.has(externalId)) continue;
      seen.add(externalId);
      pairs.push({ sourceSystem: GITHUB_SOURCE_SYSTEM, externalId });
    }
  }
  return pairs;
}

/** What a load wrote and skipped for its commits — zero across the board when the load carried none. */
export interface CommitEdgeCounts {
  /** Commits in the batch; each has one `belongs-to` edge to the root. */
  loaded: number;
  /** `touches` edges written. */
  touches: number;
  /** Changed paths with no `file` row in this load — deleted since, or skipped as generated, oversized, binary, or missing. Counted, never fatal. */
  skippedPaths: number;
  /** `mentions` edges written. */
  mentions: number;
  /** Distinct references per commit that resolved to no `github` node: the key is not a slug, or the issue or pull request is not loaded. */
  unresolvedReferences: number;
}

export function emptyCommitEdgeCounts(): CommitEdgeCounts {
  return { loaded: 0, touches: 0, skippedPaths: 0, mentions: 0, unresolvedReferences: 0 };
}

export interface ResolveCommitEdgesInput {
  key: string;
  commits: readonly GitCommit[];
  /** Every node id the upsert returned, by external id — root, directories, files, and commits of this batch. */
  nodeIdByExternalId: ReadonlyMap<string, string>;
  /** External ids of the `file` rows in this load. `touches` is written to these alone — never to a directory that now stands where a commit once changed a file of the same path. */
  fileExternalIds: ReadonlySet<string>;
  /** Canonical `github` node id by referenced external id, from `getNodesByExternalId`; a reference absent from the map is counted unresolved. Empty when the key is not a slug. */
  referenceIdByExternalId: ReadonlyMap<string, string>;
}

export interface ResolveCommitEdgesResult {
  edges: EdgeInput[];
  counts: CommitEdgeCounts;
}

function requireNodeId(nodeIdByExternalId: ReadonlyMap<string, string>, externalId: string): string {
  const id = nodeIdByExternalId.get(externalId);
  if (!id) throw new Error(`resolveCommitEdges: ${externalId} has no node id in this batch`);
  return id;
}

/**
 * Resolves each commit's edges from the node ids the upsert returned:
 * `belongs-to` the root, `touches` each changed path that is a `file` row
 * of this load, `mentions` each reference that resolved. Like
 * `resolveGitRepoEdges`, a commit or root with no id in the batch is a
 * loader bug and throws; unlike it, a changed path with no file row and a
 * reference with no node are properties of history rather than of the
 * load, so each is counted and skipped (spec: "skipped and counted, never
 * fatal"). References are deduplicated per commit on the identity named
 * and again on the node resolved, so `#12` twice, or `#12` beside
 * `owner/name#12`, is one edge and one count.
 */
export function resolveCommitEdges(input: ResolveCommitEdgesInput): ResolveCommitEdgesResult {
  const { key, commits, nodeIdByExternalId, fileExternalIds, referenceIdByExternalId } = input;
  const edges: EdgeInput[] = [];
  const counts = emptyCommitEdgeCounts();
  if (commits.length === 0) return { edges, counts };

  const rootId = requireNodeId(nodeIdByExternalId, gitExternalId(key));
  for (const commit of commits) {
    const commitId = requireNodeId(nodeIdByExternalId, commitExternalId(key, commit.sha));
    counts.loaded += 1;
    edges.push({ srcId: commitId, dstId: rootId, edgeType: BELONGS_TO_EDGE_TYPE, sourceSystem: GIT_SOURCE_SYSTEM, weight: BELONGS_TO_WEIGHT });

    for (const path of commit.paths) {
      const externalId = gitExternalId(key, path);
      if (!fileExternalIds.has(externalId)) {
        counts.skippedPaths += 1;
        continue;
      }
      edges.push({ srcId: commitId, dstId: requireNodeId(nodeIdByExternalId, externalId), edgeType: TOUCHES_EDGE_TYPE, sourceSystem: GIT_SOURCE_SYSTEM, weight: TOUCHES_WEIGHT });
      counts.touches += 1;
    }

    const seenReferences = new Set<string>();
    const mentionedIds = new Set<string>();
    for (const ref of extractIssueReferences(commitMessage(commit))) {
      const externalId = referenceExternalId(key, ref);
      if (seenReferences.has(externalId)) continue;
      seenReferences.add(externalId);
      const targetId = referenceIdByExternalId.get(externalId);
      if (!targetId) {
        counts.unresolvedReferences += 1;
        continue;
      }
      if (mentionedIds.has(targetId)) continue;
      mentionedIds.add(targetId);
      edges.push({ srcId: commitId, dstId: targetId, edgeType: MENTIONS_EDGE_TYPE, sourceSystem: GIT_SOURCE_SYSTEM, weight: MENTIONS_WEIGHT });
      counts.mentions += 1;
    }
  }
  return { edges, counts };
}

/**
 * Resolves every GitHub identity the commit messages name to a canonical
 * node id through `getNodesByExternalId`, in chunks of its bound. Runs
 * before the transaction opens rather than inside it — a deviation from
 * design.md decision 2 recorded in tasks.md 2.2: the read takes a
 * `Database`, not a transaction handle, and it reads `github` rows the git
 * transaction never writes, so the answer is exactly as fresh either way.
 * A key that is not an `owner/name` slug asks nothing (see `isRepoSlug`).
 */
async function resolveCommitReferences(db: Database, key: string, commits: readonly GitCommit[]): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  if (commits.length === 0 || !isRepoSlug(key)) return resolved;
  for (const pairs of chunk(collectCommitReferences(key, commits), MAX_EXTERNAL_ID_LOOKUPS)) {
    const { found } = await getNodesByExternalId(db, pairs);
    for (const row of found) resolved.set(row.externalId, row.id);
  }
  return resolved;
}

// --- Write path ------------------------------------------------------------

/**
 * Resolves edge candidates to `EdgeInput`s given the node ids the upsert
 * returned. Unlike `resolveBeadsEdges`, an unresolvable candidate is an
 * error, not a skip: a beads dependency can legitimately name an issue
 * outside the export, but every candidate `buildRepoTree` emits names a
 * node in the same batch, and a node silently left without its `child_of`
 * edge would be invisible to the tree walk — indistinguishable from a
 * loader bug (design.md, "Nodes and edges are written under one
 * transaction").
 */
export function resolveGitRepoEdges(candidates: readonly GitRepoEdgeCandidate[], nodeIdByExternalId: ReadonlyMap<string, string>): EdgeInput[] {
  const edges: EdgeInput[] = [];
  for (const c of candidates) {
    const srcId = nodeIdByExternalId.get(c.srcExternalId);
    const dstId = nodeIdByExternalId.get(c.dstExternalId);
    if (!srcId || !dstId) {
      throw new Error(
        `resolveGitRepoEdges: ${!srcId ? c.srcExternalId : c.dstExternalId} has no node id in this batch (edge ${c.srcExternalId} -[${CHILD_OF_EDGE_TYPE}]-> ${c.dstExternalId})`,
      );
    }
    edges.push({ srcId, dstId, edgeType: CHILD_OF_EDGE_TYPE, sourceSystem: GIT_SOURCE_SYSTEM, weight: GIT_EDGE_WEIGHT });
  }
  return edges;
}

export interface LoadGitRepoTreeOptions {
  /** Commits to write in the tree's batch, newest first as `parseGitLog` returns them. Absent or empty, the tree loads exactly as it did before commits existed. */
  commits?: readonly GitCommit[];
}

export interface LoadGitRepoTreeResult {
  nodes: UpsertNodesResult;
  edges: UpsertEdgesResult;
  /** Commit counts (`loaded`, `touches`, `skippedPaths`, `mentions`, `unresolvedReferences`); all zero without commits. */
  commits: CommitEdgeCounts;
}

/**
 * Writes a tree's nodes — and its commits' — and then every edge under
 * `run`, inside one transaction, so an edge batch failure leaves no
 * half-loaded tree — a file with no `child_of` edge is invisible to the
 * tree walk (design.md). Composed the way `annotateNode` is: the same
 * `unsafePrepareNodes` / `unsafePrepareEdges` validation and the same
 * query builders `upsertNodes` / `upsertEdges` run, chunked at their
 * default sizes, on one transaction handle rather than two. Node
 * validation, tree and commit nodes together, runs before the transaction
 * opens, so an oversized or control-character file rejects naming its
 * external id (`<key>:<path>`, `<key>@<sha>`) with nothing written under
 * the run — the run itself is already open by then, as in
 * `ingest-beads.ts`. So does the reference lookup (`resolveCommitReferences`
 * says why). Counts are classified by SQL exactly as `upsertNodes` reports
 * them: a re-run over an unchanged checkout reports every node, commits
 * included, `unchanged`; the upsert never sets `merged_into`, so a root
 * merged into another repository node keeps its pointer across re-loads.
 */
export async function loadGitRepoTree(
  db: Database,
  run: IngestRunHandle,
  tree: GitRepoTree,
  options: LoadGitRepoTreeOptions = {},
): Promise<LoadGitRepoTreeResult> {
  const commits = options.commits ?? [];
  const preparedNodes = unsafePrepareNodes(
    [...tree.nodes, ...buildCommitNodes(tree.key, commits)],
    DEFAULT_MAX_CONTENT_LENGTH,
    DEFAULT_MAX_METADATA_LENGTH,
    DEFAULT_MAX_TITLE_LENGTH,
  );
  const referenceIdByExternalId = await resolveCommitReferences(db, tree.key, commits);

  return db.transaction(async (tx) => {
    const nodeResult: UpsertNodesResult = { created: 0, updated: 0, unchanged: 0, rows: [] };
    for (const rows of chunk(preparedNodes, DEFAULT_NODE_CHUNK_SIZE)) {
      let queryResult: { rows: UpsertNodeRow[] };
      try {
        queryResult = await tx.execute<UpsertNodeRow>(unsafeBuildUpsertNodesQuery(rows, run.id));
      } catch (err) {
        throw unsafeWrapNodeWriteError(err, rows);
      }
      for (const row of queryResult.rows) {
        nodeResult.rows.push({ id: row.id, sourceSystem: row.source_system, externalId: row.external_id, action: row.action });
        nodeResult[row.action] += 1;
      }
    }

    const nodeIdByExternalId = new Map(nodeResult.rows.map((r) => [r.externalId, r.id]));
    const commitEdges = resolveCommitEdges({
      key: tree.key,
      commits,
      nodeIdByExternalId,
      fileExternalIds: new Set(tree.nodes.filter((n) => n.nodeType === FILE_NODE_TYPE).map((n) => n.externalId)),
      referenceIdByExternalId,
    });
    const preparedEdges = unsafePrepareEdges([...resolveGitRepoEdges(tree.edges, nodeIdByExternalId), ...commitEdges.edges]);

    const edgeResult: UpsertEdgesResult = { created: 0, updated: 0, rows: [] };
    for (const rows of chunk(preparedEdges, DEFAULT_EDGE_CHUNK_SIZE)) {
      let queryResult: { rows: UpsertEdgeRow[] };
      try {
        queryResult = await tx.execute<UpsertEdgeRow>(unsafeBuildUpsertEdgesQuery(rows, run.id));
      } catch (err) {
        // Rethrown so the surrounding transaction rolls back the node
        // chunks above with it.
        throw unsafeWrapEdgeWriteError(err, rows);
      }
      for (const row of queryResult.rows) {
        edgeResult.rows.push({
          id: row.id,
          srcId: row.src_id,
          dstId: row.dst_id,
          edgeType: row.edge_type,
          sourceSystem: row.source_system,
          action: row.action,
        });
        edgeResult[row.action] += 1;
      }
    }

    return { nodes: nodeResult, edges: edgeResult, commits: commitEdges.counts };
  });
}
