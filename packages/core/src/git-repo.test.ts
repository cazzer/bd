// Pure-function tests for the git repository loader's mapping module
// (git-repo-ingestor change, task 1.3; commits in github-prs-and-commits
// task 2.1). No database and no git: everything here is a function over
// strings, byte arrays, already-read files, and a literal `git log`. The
// write path (`loadGitRepoTree`), and the one real `git init`, are in
// git-repo-load.test.ts.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InvalidEventTimeError } from "./errors.js";
import { DEFAULT_MAX_TITLE_LENGTH } from "./nodes.js";
import {
  buildCommitNodes,
  buildRepoTree,
  classifyFile,
  collectCommitReferences,
  commitExternalId,
  countLines,
  deriveLanguage,
  deriveRepoKey,
  gitExternalId,
  GIT_SOURCE_SYSTEM,
  isRepoSlug,
  MAX_FILE_BYTES,
  parseGitLog,
  parseLsFiles,
  readWorkingTree,
  resolveCommitEdges,
  resolveGitRepoEdges,
  type GitCommit,
  type LoadableFile,
  type LsFilesEntry,
} from "./git-repo.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function lsRecord(mode: string, sha: string, path: string, stage = 0): string {
  return `${mode} ${sha} ${stage}\t${path}\0`;
}

describe("parseLsFiles", () => {
  it("parses -s -z records, dropping symlinks and submodules", () => {
    const stdout =
      lsRecord("100644", SHA_A, "README.md") +
      lsRecord("120000", SHA_B, "link-to-readme") +
      lsRecord("100755", SHA_B, "scripts/run.sh") +
      lsRecord("160000", SHA_A, "vendor/submodule") +
      lsRecord("100644", SHA_A, "path with spaces/file name.txt");
    expect(parseLsFiles(stdout)).toEqual([
      { path: "README.md", blobSha: SHA_A, mode: "100644" },
      { path: "scripts/run.sh", blobSha: SHA_B, mode: "100755" },
      { path: "path with spaces/file name.txt", blobSha: SHA_A, mode: "100644" },
    ]);
  });

  it("keeps a path listed at several merge stages once, and tolerates empty output", () => {
    const stdout = lsRecord("100644", SHA_A, "conflicted.ts", 1) + lsRecord("100644", SHA_B, "conflicted.ts", 2) + lsRecord("100644", SHA_B, "conflicted.ts", 3);
    expect(parseLsFiles(stdout)).toEqual([{ path: "conflicted.ts", blobSha: SHA_A, mode: "100644" }]);
    expect(parseLsFiles("")).toEqual([]);
  });

  it("rejects output that is not in -s -z shape", () => {
    expect(() => parseLsFiles("README.md\0src/a.ts\0")).toThrow(/malformed/);
    expect(() => parseLsFiles(`100644 ${SHA_A} 0\t\0`)).toThrow(/malformed/);
  });
});

describe("deriveRepoKey", () => {
  it("reduces the ssh and https GitHub forms to owner/name", () => {
    expect(deriveRepoKey("git@github.com:cazzer/breakdown.git", "bd")).toBe("cazzer/breakdown");
    expect(deriveRepoKey("https://github.com/cazzer/breakdown.git", "bd")).toBe("cazzer/breakdown");
    expect(deriveRepoKey("https://github.com/cazzer/breakdown", "bd")).toBe("cazzer/breakdown");
    expect(deriveRepoKey("https://github.com/cazzer/breakdown/", "bd")).toBe("cazzer/breakdown");
    expect(deriveRepoKey("ssh://git@github.com/cazzer/breakdown.git\n", "bd")).toBe("cazzer/breakdown");
  });

  it("falls back to the directory name with no remote, and lets an override win", () => {
    expect(deriveRepoKey(null, "bd")).toBe("bd");
    expect(deriveRepoKey("", "bd")).toBe("bd");
    expect(deriveRepoKey("   ", "bd")).toBe("bd");
    expect(deriveRepoKey("https://github.com/cazzer/breakdown.git", "bd", "bd")).toBe("bd");
    expect(deriveRepoKey(null, "bd", " forced ")).toBe("forced");
    expect(deriveRepoKey(null, "bd", "   ")).toBe("bd");
    expect(() => deriveRepoKey(null, "")).toThrow(/directory name is empty/);
  });
});

describe("classifyFile", () => {
  const text = new TextEncoder().encode("export const x = 1;\n");

  it("reports a generated name before size, and size before the control scan", () => {
    expect(classifyFile({ path: "pnpm-lock.yaml", sizeBytes: MAX_FILE_BYTES + 1, bytes: text })).toBe("generated");
    expect(classifyFile({ path: "dist/app.min.js", sizeBytes: 10, bytes: new Uint8Array([0]) })).toBe("generated");
    expect(classifyFile({ path: "dist/app.css.map", sizeBytes: 10, bytes: text })).toBe("generated");
    expect(classifyFile({ path: "package-lock.json", sizeBytes: 10, bytes: text })).toBe("generated");
    expect(classifyFile({ path: "big.txt", sizeBytes: MAX_FILE_BYTES + 1, bytes: new Uint8Array([0]) })).toBe("size");
    expect(classifyFile({ path: "exact.txt", sizeBytes: MAX_FILE_BYTES, bytes: text })).toBe("load");
  });

  it("treats a byte from the store's control set anywhere in the file as binary", () => {
    // A NUL as the very last byte of a file at the size cap: past git's
    // 8 KiB heuristic window, but `unsafePrepareNodes` would reject it.
    const lateNul = new Uint8Array(MAX_FILE_BYTES).fill(0x61);
    lateNul[MAX_FILE_BYTES - 1] = 0;
    expect(classifyFile({ path: "assets/logo.png", sizeBytes: lateNul.length, bytes: lateNul })).toBe("binary");

    // The cases the 8 KiB NUL probe missed: a form feed in Python, an
    // ANSI escape in a snapshot, and DEL.
    const formFeed = new TextEncoder().encode("def a():\n    pass\n\f\ndef b():\n    pass\n");
    expect(classifyFile({ path: "lib/mod.py", sizeBytes: formFeed.length, bytes: formFeed })).toBe("binary");
    const ansi = new TextEncoder().encode("exports[`renders`] = `\u001b[31merror\u001b[0m`;\n");
    expect(classifyFile({ path: "__snapshots__/cli.snap", sizeBytes: ansi.length, bytes: ansi })).toBe("binary");
    expect(classifyFile({ path: "del.txt", sizeBytes: 3, bytes: new Uint8Array([0x61, 0x7f, 0x62]) })).toBe("binary");

    // Tab, LF, and CR are allowed; so is every non-ASCII byte, which can
    // never be a member of the (all-ASCII) control set.
    const allowed = new TextEncoder().encode("a\tb\r\nc — é 日本\n");
    expect(classifyFile({ path: "src/a.ts", sizeBytes: allowed.length, bytes: allowed })).toBe("load");
    expect(classifyFile({ path: "src/b.ts", sizeBytes: text.length, bytes: text })).toBe("load");
    expect(classifyFile({ path: "empty.ts", sizeBytes: 0, bytes: new Uint8Array(0) })).toBe("load");
  });
});

describe("readWorkingTree", () => {
  let root: string;
  const entry = (path: string): LsFilesEntry => ({ path, blobSha: SHA_A, mode: "100644" });

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "gri-working-tree-"));
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "was-a-file"));
    await writeFile(join(root, "src/a.ts"), "export const a = 1;\n");
    await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    await writeFile(join(root, "big.txt"), new Uint8Array(MAX_FILE_BYTES + 1).fill(0x61));
    await writeFile(join(root, "logo.png"), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0]));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reads loadable entries, counts each skip by reason, and treats an index entry with no file as missing", async () => {
    const read = await readWorkingTree(root, [
      entry("src/a.ts"),
      entry("pnpm-lock.yaml"),
      entry("big.txt"),
      entry("logo.png"),
      // Never written: a sparse checkout, or `rm` without `git rm`.
      entry("sparse/absent.ts"),
    ]);
    expect(read.files).toEqual([{ path: "src/a.ts", blobSha: SHA_A, sizeBytes: 20, text: "export const a = 1;\n" }]);
    expect(read.skipped).toEqual({ generated: 1, size: 1, binary: 1, missing: 1 });
  });

  it("fails naming the path when a tracked regular file is a directory on disk", async () => {
    await expect(readWorkingTree(root, [entry("src/a.ts"), entry("was-a-file")])).rejects.toThrow(/was-a-file is tracked as a regular file/);
  });
});

describe("deriveLanguage", () => {
  it("maps known extensions case-insensitively and omits unknown ones", () => {
    expect(deriveLanguage("packages/core/src/a.ts")).toBe("typescript");
    expect(deriveLanguage("App.TSX")).toBe("typescript");
    expect(deriveLanguage("x.mjs")).toBe("javascript");
    expect(deriveLanguage("docker-compose.yml")).toBe("yaml");
    expect(deriveLanguage("run.sh")).toBe("shell");
    expect(deriveLanguage(".eslintrc.json")).toBe("json");
    expect(deriveLanguage("a.unknownext")).toBeUndefined();
    expect(deriveLanguage("Makefile")).toBeUndefined();
    expect(deriveLanguage(".gitignore")).toBeUndefined();
  });
});

describe("countLines", () => {
  it("counts newlines, plus one for an unterminated last line", () => {
    expect(countLines("")).toBe(0);
    expect(countLines("a")).toBe(1);
    expect(countLines("a\n")).toBe(1);
    expect(countLines("a\nb")).toBe(2);
    expect(countLines("a\nb\n")).toBe(2);
    expect(countLines("\n")).toBe(1);
  });
});

describe("buildRepoTree", () => {
  const files: LoadableFile[] = [
    { path: "packages/core/src/a.ts", blobSha: SHA_A, sizeBytes: 20, text: "export const a = 1;\n" },
    { path: "README.md", blobSha: SHA_B, sizeBytes: 9, text: "# Readme" },
  ];
  const tree = buildRepoTree("owner/name", "/abs/checkout", files);
  const byId = new Map(tree.nodes.map((n) => [n.externalId, n]));

  it("materializes every ancestor directory once and a repo root", () => {
    expect(tree.nodes.map((n) => [n.nodeType, n.externalId])).toEqual([
      ["repo", "owner/name"],
      ["directory", "owner/name:packages"],
      ["directory", "owner/name:packages/core"],
      ["directory", "owner/name:packages/core/src"],
      ["file", "owner/name:README.md"],
      ["file", "owner/name:packages/core/src/a.ts"],
    ]);
    expect(tree.nodes.every((n) => n.sourceSystem === GIT_SOURCE_SYSTEM)).toBe(true);
    expect(byId.get("owner/name")).toMatchObject({ title: "owner/name", content: "README.md\npackages", metadata: { key: "owner/name", root_path: "/abs/checkout" } });
    expect(byId.get("owner/name:packages")).toMatchObject({ title: "packages", content: "core", metadata: { path: "packages" } });
    expect(byId.get("owner/name:packages/core/src")).toMatchObject({ title: "src", content: "a.ts", metadata: { path: "packages/core/src" } });
  });

  it("gives files their text, base-name title, and flat metadata with language only when known", () => {
    expect(byId.get("owner/name:packages/core/src/a.ts")).toEqual({
      nodeType: "file",
      sourceSystem: "git",
      externalId: "owner/name:packages/core/src/a.ts",
      title: "a.ts",
      content: "export const a = 1;\n",
      metadata: { path: "packages/core/src/a.ts", size_bytes: 20, line_count: 1, blob_sha: SHA_A, language: "typescript" },
    });
    expect(byId.get("owner/name:README.md")?.metadata).toEqual({ path: "README.md", size_bytes: 9, line_count: 1, blob_sha: SHA_B, language: "markdown" });

    const noLang = buildRepoTree("k", "/r", [{ path: "Makefile", blobSha: SHA_A, sizeBytes: 3, text: "all:" }]);
    expect(noLang.nodes[1]?.metadata).not.toHaveProperty("language");
  });

  it("emits exactly one child_of candidate per non-root node, with root entries pointing at the repo node", () => {
    const nonRoot = tree.nodes.filter((n) => n.nodeType !== "repo").map((n) => n.externalId);
    expect(tree.edges.map((e) => e.srcExternalId)).toEqual(nonRoot);
    expect(tree.edges).toEqual([
      { srcExternalId: "owner/name:packages", dstExternalId: "owner/name" },
      { srcExternalId: "owner/name:packages/core", dstExternalId: "owner/name:packages" },
      { srcExternalId: "owner/name:packages/core/src", dstExternalId: "owner/name:packages/core" },
      { srcExternalId: "owner/name:README.md", dstExternalId: "owner/name" },
      { srcExternalId: "owner/name:packages/core/src/a.ts", dstExternalId: "owner/name:packages/core/src" },
    ]);
    expect(tree.edges.some((e) => e.srcExternalId === "owner/name")).toBe(false);
  });

  it("is deterministic regardless of input order and rejects unnormalized or repeated paths", () => {
    const reversed = buildRepoTree("owner/name", "/abs/checkout", [...files].reverse());
    expect(reversed).toEqual(tree);
    expect(() => buildRepoTree("k", "/r", [{ path: "../etc/passwd", blobSha: SHA_A, sizeBytes: 1, text: "x" }])).toThrow(/not a normalized/);
    expect(() => buildRepoTree("k", "/r", [{ path: "/abs.ts", blobSha: SHA_A, sizeBytes: 1, text: "x" }])).toThrow(/not a normalized/);
    expect(() => buildRepoTree("k", "/r", [files[1]!, files[1]!])).toThrow(/listed twice/);
    expect(() => buildRepoTree("k", "/r", [{ path: "notes.md ", blobSha: SHA_A, sizeBytes: 1, text: "x" }])).toThrow(/"notes\.md " has leading or trailing whitespace/);
    expect(() => buildRepoTree("k", "/r", [{ path: " notes.md", blobSha: SHA_A, sizeBytes: 1, text: "x" }])).toThrow(/whitespace/);
    expect(() => buildRepoTree("k", "/r", [{ path: "dir /a.ts", blobSha: SHA_A, sizeBytes: 1, text: "x" }])).toThrow(/whitespace/);
    expect(() => buildRepoTree("  ", "/r", files)).toThrow(/key/);
  });

  it("names external ids as <key> for the root and <key>:<path> for entries", () => {
    expect(gitExternalId("k")).toBe("k");
    expect(gitExternalId("k", "a/b.ts")).toBe("k:a/b.ts");
  });
});

describe("resolveGitRepoEdges", () => {
  const ids = new Map([
    ["k", "11111111-1111-4111-8111-111111111111"],
    ["k:src", "22222222-2222-4222-8222-222222222222"],
    ["k:src/a.ts", "33333333-3333-4333-8333-333333333333"],
  ]);

  it("resolves candidates to child_of edges under the git source system at weight 1", () => {
    const resolved = resolveGitRepoEdges(
      [
        { srcExternalId: "k:src", dstExternalId: "k" },
        { srcExternalId: "k:src/a.ts", dstExternalId: "k:src" },
      ],
      ids,
    );
    expect(resolved).toEqual([
      { srcId: ids.get("k:src"), dstId: ids.get("k"), edgeType: "child_of", sourceSystem: "git", weight: 1 },
      { srcId: ids.get("k:src/a.ts"), dstId: ids.get("k:src"), edgeType: "child_of", sourceSystem: "git", weight: 1 },
    ]);
  });

  it("refuses a candidate whose end has no node id, naming it", () => {
    expect(() => resolveGitRepoEdges([{ srcExternalId: "k:missing.ts", dstExternalId: "k" }], ids)).toThrow(/k:missing\.ts has no node id/);
    expect(() => resolveGitRepoEdges([{ srcExternalId: "k:src", dstExternalId: "other" }], ids)).toThrow(/other has no node id/);
  });
});

// --- Commits (github-prs-and-commits task 2.1) ----------------------------

const RS = "\x1e";
const NUL = "\x00";
const SHA_C = "c".repeat(40);
const SHA_D = "d".repeat(40);

// Exactly what `git log -n 3 --name-only --format=<GIT_LOG_FORMAT>` prints
// for three commits, newest first: a normal commit with three paths and a
// body holding blank lines, a `#12`, a cross-repository reference, and a
// `#99` inside a code span; a merge commit with two parents, no body, and
// no paths (git shows a merge without a diff); and the root commit with no
// parent. After the seventh NUL git prints its own line break, a blank
// line, then one path per line — nothing but the line break for the merge.
const LITERAL_LOG =
  `${RS}${SHA_C}${NUL}${SHA_B}${NUL}2026-09-04T18:43:52-04:00${NUL}2026-09-04T19:00:00-04:00${NUL}Caleb Brewer${NUL}Drop gone.txt and touch a and b${NUL}` +
  `Closes #12 for real.\n\nAlso see cazzer/toastd#7 and \`#99\` in code.\n${NUL}\n\ngone.txt\nsrc/a.ts\nsrc/b.ts\n` +
  `${RS}${SHA_B}${NUL}${SHA_A} ${SHA_D}${NUL}2026-09-03T10:00:00+02:00${NUL}2026-09-03T10:00:00+02:00${NUL}Someone Else${NUL}Merge branch 'feature'${NUL}${NUL}\n` +
  `${RS}${SHA_A}${NUL}${NUL}2026-09-01T00:00:00Z${NUL}2026-09-01T00:00:00Z${NUL}Caleb Brewer${NUL}Initial import${NUL}${NUL}\n\nREADME.md\nsrc/a.ts\n`;

const EXPECTED_COMMITS: GitCommit[] = [
  {
    sha: SHA_C,
    parents: [SHA_B],
    authoredAt: "2026-09-04T18:43:52-04:00",
    committedAt: "2026-09-04T19:00:00-04:00",
    author: "Caleb Brewer",
    subject: "Drop gone.txt and touch a and b",
    body: "Closes #12 for real.\n\nAlso see cazzer/toastd#7 and `#99` in code.",
    paths: ["gone.txt", "src/a.ts", "src/b.ts"],
  },
  {
    sha: SHA_B,
    parents: [SHA_A, SHA_D],
    authoredAt: "2026-09-03T10:00:00+02:00",
    committedAt: "2026-09-03T10:00:00+02:00",
    author: "Someone Else",
    subject: "Merge branch 'feature'",
    body: "",
    paths: [],
  },
  {
    sha: SHA_A,
    parents: [],
    authoredAt: "2026-09-01T00:00:00Z",
    committedAt: "2026-09-01T00:00:00Z",
    author: "Caleb Brewer",
    subject: "Initial import",
    body: "",
    paths: ["README.md", "src/a.ts"],
  },
];

describe("parseGitLog", () => {
  it("reads a normal commit's paths, a merge's absence of them, a body with blank lines, and a root's absence of parents", () => {
    expect(parseGitLog(LITERAL_LOG)).toEqual(EXPECTED_COMMITS);
    expect(parseGitLog("")).toEqual([]);
  });

  it("rejects a record with the wrong field count naming the sha, or the index when the record has none", () => {
    const missingBody = `${RS}${SHA_C}${NUL}${SHA_B}${NUL}2026-09-04T18:43:52-04:00${NUL}2026-09-04T19:00:00-04:00${NUL}Caleb Brewer${NUL}subject${NUL}\n`;
    expect(() => parseGitLog(missingBody)).toThrow(`parseGitLog: malformed commit ${SHA_C}: expected 7 NUL-terminated fields, found 6`);

    // A record separator inside a body splits one commit into a short
    // record (named by its sha) and a fragment that starts with body text.
    const straySeparator = LITERAL_LOG.replace("for real.", `for${RS}real.`);
    expect(() => parseGitLog(straySeparator)).toThrow(`malformed commit ${SHA_C}: expected 7 NUL-terminated fields, found 6`);
    expect(() => parseGitLog(`${RS}real.\n${NUL}\n\ngone.txt\n`)).toThrow("malformed record 0: expected 7 NUL-terminated fields, found 1");

    // A NUL inside a body — git refuses one in a message, so this is not
    // git's output — adds an eighth field: named by the sha, never
    // misattributed to the paths.
    expect(() => parseGitLog(LITERAL_LOG.replace("for real.", `for${NUL}real.`))).toThrow(`malformed commit ${SHA_C}: expected 7 NUL-terminated fields, found 8`);

    // Seven fields whose first is not a sha: plain `git log` output would look like this.
    expect(() => parseGitLog(`${RS}commit abc${NUL}${NUL}${NUL}${NUL}${NUL}${NUL}${NUL}\n`)).toThrow(/malformed record 0: "commit abc" is not a commit sha/);
    expect(() => parseGitLog(`noise${LITERAL_LOG}`)).toThrow(/output before the first record separator "noise"/);
  });
});

describe("buildCommitNodes", () => {
  const nodes = buildCommitNodes("owner/name", EXPECTED_COMMITS);

  it("keys each commit <key>@<sha> with the subject as title, the whole message as content, and occurred_at canonical at the committer instant", () => {
    expect(nodes[0]).toEqual({
      nodeType: "commit",
      sourceSystem: GIT_SOURCE_SYSTEM,
      externalId: `owner/name@${SHA_C}`,
      title: "Drop gone.txt and touch a and b",
      content: "Drop gone.txt and touch a and b\n\nCloses #12 for real.\n\nAlso see cazzer/toastd#7 and `#99` in code.",
      metadata: {
        sha: SHA_C,
        parents: [SHA_B],
        author: "Caleb Brewer",
        authored_at: "2026-09-04T18:43:52-04:00",
        committed_at: "2026-09-04T19:00:00-04:00",
        files_changed: 3,
        occurred_at: "2026-09-04T23:00:00.000Z",
      },
    });
    // A message with no body is its subject alone — no dangling blank line.
    expect(nodes[1]).toMatchObject({
      title: "Merge branch 'feature'",
      content: "Merge branch 'feature'",
      metadata: { parents: [SHA_A, SHA_D], files_changed: 0, occurred_at: "2026-09-03T08:00:00.000Z" },
    });
    expect(nodes[2]?.metadata).toEqual({
      sha: SHA_A,
      parents: [],
      author: "Caleb Brewer",
      authored_at: "2026-09-01T00:00:00Z",
      committed_at: "2026-09-01T00:00:00Z",
      files_changed: 2,
      occurred_at: "2026-09-01T00:00:00.000Z",
    });
    expect(Object.keys(nodes[0]!.metadata!)).not.toContain("email");
  });

  it("trims the key as buildRepoTree does, and rejects a blank one or a committer instant that does not parse, naming the commit", () => {
    expect(commitExternalId("k", SHA_C)).toBe(`k@${SHA_C}`);
    expect(buildCommitNodes(" owner/name ", EXPECTED_COMMITS)[0]?.externalId).toBe(`owner/name@${SHA_C}`);
    expect(buildCommitNodes("k", [])).toEqual([]);
    expect(() => buildCommitNodes("  ", EXPECTED_COMMITS)).toThrow(/key must be a non-empty string/);

    const badInstant = [{ ...EXPECTED_COMMITS[0]!, committedAt: "yesterday" }];
    expect(() => buildCommitNodes("k", badInstant)).toThrow(InvalidEventTimeError);
    expect(() => buildCommitNodes("k", badInstant)).toThrow(`(git/k@${SHA_C})`);
    // The author instant is stored as printed and not validated: only the committer instant is the node's moment.
    expect(buildCommitNodes("k", [{ ...EXPECTED_COMMITS[0]!, authoredAt: "whenever" }])[0]?.metadata).toMatchObject({ authored_at: "whenever" });
  });

  it("fits a long subject, control characters, and an empty subject to the store while keeping the whole message", () => {
    // `git commit -m` with a long one-paragraph message: `%s` is the whole paragraph.
    const paragraph = "word ".repeat(130).trim();
    expect(paragraph.length).toBeGreaterThan(DEFAULT_MAX_TITLE_LENGTH);
    const long = buildCommitNodes("k", [{ ...EXPECTED_COMMITS[1]!, subject: paragraph, body: "" }])[0]!;
    expect(long.title).toBe(paragraph.slice(0, DEFAULT_MAX_TITLE_LENGTH));
    expect(long.title).toHaveLength(DEFAULT_MAX_TITLE_LENGTH);
    expect(long.content).toBe(paragraph);

    // A pasted ANSI escape, a NUL, and DEL become spaces; tab, CR, and LF stay.
    const escaped = buildCommitNodes("k", [{ ...EXPECTED_COMMITS[0]!, subject: "Fix\u001b[31m red\u001b[0m", body: "tab\there\r\nand \u0000 NUL, \u007f DEL" }])[0]!;
    expect(escaped.title).toBe("Fix [31m red [0m");
    expect(escaped.content).toBe("Fix [31m red [0m\n\ntab\there\r\nand   NUL,   DEL");

    // `--allow-empty-message`: the short sha stands in for the title; a blank subject the same.
    const empty = buildCommitNodes("k", [{ ...EXPECTED_COMMITS[1]!, subject: "", body: "" }])[0]!;
    expect(empty.title).toBe(SHA_B.slice(0, 7));
    expect(empty.content).toBe("");
    expect(buildCommitNodes("k", [{ ...EXPECTED_COMMITS[1]!, subject: " \t " }])[0]?.title).toBe(SHA_B.slice(0, 7));
    // With no subject the content is the body alone — no leading blank line.
    expect(buildCommitNodes("k", [{ ...EXPECTED_COMMITS[1]!, subject: "", body: "only a body" }])[0]).toMatchObject({ title: SHA_B.slice(0, 7), content: "only a body" });
  });
});

describe("isRepoSlug", () => {
  it("accepts owner/name in GitHub's grammar and nothing else", () => {
    expect(isRepoSlug("cazzer/breakdown")).toBe(true);
    expect(isRepoSlug("gri-test-0123abcd/commits.v2_x")).toBe(true);
    expect(isRepoSlug("bd")).toBe(false);
    expect(isRepoSlug("a/b/c")).toBe(false);
    expect(isRepoSlug("owner/")).toBe(false);
    expect(isRepoSlug("/name")).toBe(false);
    expect(isRepoSlug("-owner/name")).toBe(false);
    expect(isRepoSlug("owner/name-")).toBe(false);
    expect(isRepoSlug("owner /name")).toBe(false);
    expect(isRepoSlug("owner/name@sha")).toBe(false);
  });
});

describe("collectCommitReferences", () => {
  it("names each distinct GitHub identity once under github, resolving a same-repo #N against the key and skipping code spans", () => {
    // `extractIssueReferences` yields a message's cross-repository
    // references before its same-repo ones; the order is its, not the text's.
    expect(collectCommitReferences("owner/name", EXPECTED_COMMITS)).toEqual([
      { sourceSystem: "github", externalId: "cazzer/toastd#7" },
      { sourceSystem: "github", externalId: "owner/name#12" },
    ]);
    const again: GitCommit = { ...EXPECTED_COMMITS[1]!, subject: "See #12 and owner/name#12, then #12 again" };
    expect(collectCommitReferences("owner/name", [again, ...EXPECTED_COMMITS])).toEqual([
      { sourceSystem: "github", externalId: "owner/name#12" },
      { sourceSystem: "github", externalId: "cazzer/toastd#7" },
    ]);
    expect(collectCommitReferences("owner/name", [])).toEqual([]);
  });
});

describe("resolveCommitEdges", () => {
  const ROOT_ID = "11111111-1111-4111-8111-111111111111";
  const COMMIT_ID = "22222222-2222-4222-8222-222222222222";
  const A_ID = "33333333-3333-4333-8333-333333333333";
  const B_ID = "44444444-4444-4444-8444-444444444444";
  const SRC_DIR_ID = "55555555-5555-4555-8555-555555555555";
  const ISSUE_ID = "66666666-6666-4666-8666-666666666666";
  const ids = new Map([
    ["owner/name", ROOT_ID],
    [`owner/name@${SHA_C}`, COMMIT_ID],
    ["owner/name:src", SRC_DIR_ID],
    ["owner/name:src/a.ts", A_ID],
    ["owner/name:src/b.ts", B_ID],
  ]);
  const files = new Set(["owner/name:src/a.ts", "owner/name:src/b.ts"]);
  const references = new Map([["owner/name#12", ISSUE_ID]]);

  it("writes belongs-to at 1, touches at 0.8 to file rows alone, and mentions at 0.8 to what resolved, counting the rest", () => {
    // `src` was a file in this commit's day and is a directory now: no
    // `touches` to a directory, counted with the deleted `gone.txt`. The
    // repeated `src/a.ts` is one edge — git never lists a path twice, and
    // a duplicate could not be allowed to fail the batch if it did.
    const commit: GitCommit = { ...EXPECTED_COMMITS[0]!, paths: ["src/a.ts", "src/b.ts", "gone.txt", "src", "src/a.ts"] };
    const { edges, counts } = resolveCommitEdges({ key: "owner/name", commits: [commit], nodeIdByExternalId: ids, fileExternalIds: files, referenceIdByExternalId: references });
    expect(edges).toEqual([
      { srcId: COMMIT_ID, dstId: ROOT_ID, edgeType: "belongs-to", sourceSystem: "git", weight: 1 },
      { srcId: COMMIT_ID, dstId: A_ID, edgeType: "touches", sourceSystem: "git", weight: 0.8 },
      { srcId: COMMIT_ID, dstId: B_ID, edgeType: "touches", sourceSystem: "git", weight: 0.8 },
      { srcId: COMMIT_ID, dstId: ISSUE_ID, edgeType: "mentions", sourceSystem: "git", weight: 0.8 },
    ]);
    // cazzer/toastd#7 is not in the map; `#99` sat inside a code span.
    expect(counts).toEqual({ loaded: 1, touches: 2, skippedPaths: 2, mentions: 1, unresolvedReferences: 1 });
  });

  it("collapses repeated and equivalent references to one edge, and counts every reference unresolved when nothing resolved", () => {
    // `#12` three ways is one identity under this key; `#999` is a second.
    const repeated: GitCommit = { ...EXPECTED_COMMITS[0]!, subject: "Fix #12", body: "See #12 and owner/name#12, then #999.", paths: [] };
    const resolved = resolveCommitEdges({ key: "owner/name", commits: [repeated], nodeIdByExternalId: ids, fileExternalIds: files, referenceIdByExternalId: references });
    expect(resolved.edges.filter((e) => e.edgeType === "mentions")).toHaveLength(1);
    expect(resolved.counts).toEqual({ loaded: 1, touches: 0, skippedPaths: 0, mentions: 1, unresolvedReferences: 1 });

    // A key that is not a slug asks nothing: the loader passes an empty map.
    const unresolved = resolveCommitEdges({ key: "owner/name", commits: [repeated], nodeIdByExternalId: ids, fileExternalIds: files, referenceIdByExternalId: new Map() });
    expect(unresolved.edges.map((e) => e.edgeType)).toEqual(["belongs-to"]);
    expect(unresolved.counts).toEqual({ loaded: 1, touches: 0, skippedPaths: 0, mentions: 0, unresolvedReferences: 2 });
  });

  it("writes nothing for no commits, and refuses a commit or root with no id in the batch — a loader bug, not history", () => {
    expect(resolveCommitEdges({ key: "owner/name", commits: [], nodeIdByExternalId: new Map(), fileExternalIds: files, referenceIdByExternalId: references })).toEqual({
      edges: [],
      counts: { loaded: 0, touches: 0, skippedPaths: 0, mentions: 0, unresolvedReferences: 0 },
    });
    expect(() => resolveCommitEdges({ key: "owner/name", commits: [EXPECTED_COMMITS[1]!], nodeIdByExternalId: ids, fileExternalIds: files, referenceIdByExternalId: references })).toThrow(
      `owner/name@${SHA_B} has no node id in this batch`,
    );
    expect(() => resolveCommitEdges({ key: "other", commits: [EXPECTED_COMMITS[0]!], nodeIdByExternalId: ids, fileExternalIds: files, referenceIdByExternalId: references })).toThrow(
      "other has no node id in this batch",
    );
  });
});
