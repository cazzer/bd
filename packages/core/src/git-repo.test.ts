// Pure-function tests for the git repository loader's mapping module
// (git-repo-ingestor change, task 1.3). No database: everything here is a
// function over strings, byte arrays, and already-read files. The write
// path (`loadGitRepoTree`) is covered in git-repo-load.test.ts.

import { describe, expect, it } from "vitest";
import {
  buildRepoTree,
  classifyFile,
  countLines,
  deriveLanguage,
  deriveRepoKey,
  gitExternalId,
  GIT_SOURCE_SYSTEM,
  MAX_FILE_BYTES,
  NUL_PROBE_BYTES,
  parseLsFiles,
  resolveGitRepoEdges,
  type LoadableFile,
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

  it("reports a generated name before size, and size before the NUL probe", () => {
    expect(classifyFile({ path: "pnpm-lock.yaml", sizeBytes: MAX_FILE_BYTES + 1, head: text })).toBe("generated");
    expect(classifyFile({ path: "dist/app.min.js", sizeBytes: 10, head: new Uint8Array([0]) })).toBe("generated");
    expect(classifyFile({ path: "dist/app.css.map", sizeBytes: 10, head: text })).toBe("generated");
    expect(classifyFile({ path: "package-lock.json", sizeBytes: 10, head: text })).toBe("generated");
    expect(classifyFile({ path: "big.txt", sizeBytes: MAX_FILE_BYTES + 1, head: new Uint8Array([0]) })).toBe("size");
    expect(classifyFile({ path: "exact.txt", sizeBytes: MAX_FILE_BYTES, head: text })).toBe("load");
  });

  it("treats a NUL byte within the first 8 KiB as binary, and one beyond it as text", () => {
    const early = new Uint8Array(NUL_PROBE_BYTES).fill(0x61);
    early[NUL_PROBE_BYTES - 1] = 0;
    expect(classifyFile({ path: "assets/logo.png", sizeBytes: early.length, head: early })).toBe("binary");

    const late = new Uint8Array(NUL_PROBE_BYTES + 1).fill(0x61);
    late[NUL_PROBE_BYTES] = 0;
    expect(classifyFile({ path: "odd.txt", sizeBytes: late.length, head: late })).toBe("load");

    expect(classifyFile({ path: "src/a.ts", sizeBytes: text.length, head: text })).toBe("load");
    expect(classifyFile({ path: "empty.ts", sizeBytes: 0, head: new Uint8Array(0) })).toBe("load");
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
