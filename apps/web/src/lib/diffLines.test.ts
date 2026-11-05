import { describe, expect, test } from "vitest";
import { classifyDiffLines, diffStats } from "./diffLines.js";

const kinds = (source: string) => classifyDiffLines(source).map((l) => l.kind);

describe("classifyDiffLines", () => {
  test("a fence without hunks marks every leading + and -", () => {
    expect(classifyDiffLines("+a\n-b\n c\n")).toEqual([
      { kind: "added", text: "+a" },
      { kind: "removed", text: "-b" },
      { kind: "context", text: " c" },
    ]);
  });

  test("git: file lines, headers as meta, and a removed SQL comment inside a hunk stays removed", () => {
    const source = ["diff --git a/x.sql b/x.sql", "--- a/x.sql", "+++ b/x.sql", "@@ -1,2 +1,2 @@", "--- old note", "+-- new note", " select 1;", "diff --git a/y b/y", "--- a/y", "+++ b/y", "@@ -1 +1 @@", "-y", "+z"].join("\n");
    expect(kinds(source)).toEqual(["file", "meta", "meta", "hunk", "removed", "added", "context", "file", "meta", "meta", "hunk", "removed", "added"]);
  });

  test("the hunk ends when its counts are used up, so the next file's headers are meta", () => {
    const source = ["Index: a.txt", "===================================================================", "--- a.txt (revision 1)", "+++ a.txt (working copy)", "@@ -1,2 +1,1 @@", "-gone", " kept", "Index: b.txt", "--- b.txt", "+++ b.txt", "@@ -0,0 +1 @@", "+new"].join("\n");
    expect(kinds(source)).toEqual(["file", "meta", "meta", "meta", "hunk", "removed", "context", "file", "meta", "meta", "hunk", "added"]);
  });

  test("a line starting --- that the counts say is removed stays removed, even right before the next header", () => {
    expect(kinds(["@@ -1,2 +1 @@", "--- not a header", "-also removed", "+kept", "@@ -9 +8 @@", " ctx"].join("\n"))).toEqual(["hunk", "removed", "removed", "added", "hunk", "context"]);
  });

  test("'\\ No newline at end of file' is meta and uses no count", () => {
    expect(kinds(["@@ -1 +1 @@", "-a", "\\ No newline at end of file", "+b", "\\ No newline at end of file"].join("\n"))).toEqual(["hunk", "removed", "meta", "added", "meta"]);
    expect(kinds("+a\n\\ No newline at end of file")).toEqual(["added", "meta"]);
  });

  test("a hunk header without counts runs to the next header", () => {
    expect(kinds(["@@ sketch @@", "-a", "+b", "@@ more @@", " c"].join("\n"))).toEqual(["hunk", "removed", "added", "hunk", "context"]);
  });

  test("an empty source is one empty context line", () => {
    expect(classifyDiffLines("")).toEqual([{ kind: "context", text: "" }]);
  });
});

describe("diffStats", () => {
  test("counts added and removed lines", () => {
    expect(diffStats(classifyDiffLines("@@ -1,2 +1,3 @@\n-a\n+b\n+c\n d"))).toEqual({ added: 2, removed: 1 });
  });
});
