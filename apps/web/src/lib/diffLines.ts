// Classifies the lines of a unified diff for DiffBlock (decision-card-reviews,
// design.md decision 3).
//
// A hunk header `@@ -a,b +c,d @@` says how many old (b) and new (d) lines
// follow, so a hunk ends exactly when both counts are used up — not at a line
// that merely looks like a header. That keeps a removed SQL comment (`-` +
// `-- note`, which reads `--- note`) removed inside a hunk, and lets the
// `--- a/x` / `+++ b/x` lines between hunks be headers. Outside a hunk,
// `diff …` (git) and `Index: …` (svn) start a file; everything else there is
// meta. `\ No newline at end of file` is meta wherever it appears. A hunk
// header without counts runs until the next header or file line. A fence with
// no `@@` at all (a hand-written `+a` / `-b` sketch) uses the bare rule: a
// leading `+` is added, `-` removed.

export type DiffLineKind = "added" | "removed" | "hunk" | "file" | "meta" | "context";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

const isFileStart = (text: string) => text.startsWith("diff ") || text.startsWith("Index: ");

export function classifyDiffLines(source: string): DiffLine[] {
  const lines = source.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  if (!lines.some((line) => line.startsWith("@@"))) return lines.map(classifyBare);

  let oldLeft = 0;
  let newLeft = 0;
  return lines.map((text): DiffLine => {
    if (text.startsWith("\\")) return { kind: "meta", text };
    const inHunk = oldLeft > 0 || newLeft > 0;
    if (inHunk && !(oldLeft === Infinity && (text.startsWith("@@") || isFileStart(text)))) {
      if (text.startsWith("+")) {
        newLeft--;
        return { kind: "added", text };
      }
      if (text.startsWith("-")) {
        oldLeft--;
        return { kind: "removed", text };
      }
      oldLeft--;
      newLeft--;
      return { kind: "context", text };
    }
    oldLeft = 0;
    newLeft = 0;
    if (text.startsWith("@@")) {
      const counts = HUNK_HEADER.exec(text);
      oldLeft = counts ? Number(counts[1] ?? 1) : Infinity;
      newLeft = counts ? Number(counts[2] ?? 1) : Infinity;
      return { kind: "hunk", text };
    }
    if (isFileStart(text)) return { kind: "file", text };
    return { kind: "meta", text };
  });
}

function classifyBare(text: string): DiffLine {
  if (text.startsWith("\\")) return { kind: "meta", text };
  if (text.startsWith("+")) return { kind: "added", text };
  if (text.startsWith("-")) return { kind: "removed", text };
  return { kind: "context", text };
}

/** Lines added and removed, for a clipped diff's "Show all" control. */
export function diffStats(lines: readonly DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === "added") added++;
    else if (line.kind === "removed") removed++;
  }
  return { added, removed };
}
