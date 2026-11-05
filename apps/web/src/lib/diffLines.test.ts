import { describe, expect, test } from "vitest";
import { classifyDiffLines } from "./diffLines.js";

describe("classifyDiffLines", () => {
  test("a fence without hunks marks every leading + and -", () => {
    expect(classifyDiffLines("+a\n-b\n c\n")).toEqual([
      { kind: "added", text: "+a" },
      { kind: "removed", text: "-b" },
      { kind: "context", text: " c" },
    ]);
  });

  test("file headers before a hunk are meta, and a removed SQL comment inside one is removed", () => {
    const source = ["diff --git a/x.sql b/x.sql", "--- a/x.sql", "+++ b/x.sql", "@@ -1,2 +1,2 @@", "--- old note", "+-- new note", " select 1;", "diff --git a/y b/y", "--- a/y", "+++ b/y", "@@ -1 +1 @@", "-y", "+z"].join("\n");
    expect(classifyDiffLines(source).map((l) => l.kind)).toEqual(["meta", "meta", "meta", "hunk", "removed", "added", "context", "meta", "meta", "meta", "hunk", "removed", "added"]);
  });

  test("an empty source is one empty context line", () => {
    expect(classifyDiffLines("")).toEqual([{ kind: "context", text: "" }]);
  });
});
