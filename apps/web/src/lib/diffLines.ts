// Classifies the lines of a unified diff for DiffBlock (decision-card-reviews,
// design.md decision 3): a leading `+` is added, `-` removed, `@@` a hunk
// header. Inside a diff that has hunks, the `+`/`-` rule holds only within a
// hunk: before its first `@@` a file's `--- a/x` / `+++ b/x` lines are headers,
// and a removed SQL comment (`-` + `-- note`) reads `--- note`, so a rule on
// the line's first characters alone could not tell the two apart. A fence
// without any `@@` (a hand-written `+a` / `-b` sketch) uses the bare rule.

export type DiffLineKind = "added" | "removed" | "hunk" | "meta" | "context";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

export function classifyDiffLines(source: string): DiffLine[] {
  const lines = source.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const hasHunks = lines.some((line) => line.startsWith("@@"));
  let inHunk = !hasHunks;
  return lines.map((text) => {
    if (text.startsWith("@@")) {
      inHunk = true;
      return { kind: "hunk", text };
    }
    if (hasHunks && text.startsWith("diff ")) inHunk = false;
    if (!inHunk) return { kind: "meta", text };
    if (text.startsWith("+")) return { kind: "added", text };
    if (text.startsWith("-")) return { kind: "removed", text };
    return { kind: "context", text };
  });
}
