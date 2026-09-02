// Excerpt extraction for the detail panel's summary state (bd-e9n,
// openspec/changes/explorer-legibility/design.md decision 6: "Detail
// panel opens as a summary"). Pulls the first real paragraph out of a
// node's markdown content WITHOUT depending on the markdown renderer —
// same reasoning lib/snippet.ts documents for search snippets: a small,
// pure, directly-testable string transform rather than something only
// reachable by rendering a whole document through MarkdownEditor/tiptap.
//
// "Paragraph" here means: the first non-empty, blank-line-delimited
// block of lines that is not itself a heading, a fenced code block, a
// list item, a blockquote, a table row, or a line of raw HTML — the
// exact exclusion list graph-explorer/spec.md's "The detail panel opens
// as a summary" requirement names. Inline markdown (`**bold**`, links,
// etc.) inside that block is left untouched — this function does no
// markdown parsing, only line-shape recognition, the same "recognize
// the shape, don't parse the content" discipline snippet.ts's own header
// argues for.

const HEADING_RE = /^#{1,6}\s/;
const FENCE_RE = /^(```|~~~)/;
const LIST_ITEM_RE = /^([-*+]\s|\d+[.)]\s)/;
const BLOCKQUOTE_RE = /^>/;
const TABLE_ROW_RE = /^\|/;
const HTML_TAG_LINE_RE = /^<[a-zA-Z!/]/;

/** Whether `trimmedLine` (already `.trim()`-ed) starts a block this excerpt must skip over. Fenced code blocks are handled separately by the caller — they can legitimately contain blank lines, so they aren't just "one skipped block" the way the others are. */
function isExcludedBlockStart(trimmedLine: string): boolean {
  return HEADING_RE.test(trimmedLine) || LIST_ITEM_RE.test(trimmedLine) || BLOCKQUOTE_RE.test(trimmedLine) || TABLE_ROW_RE.test(trimmedLine) || HTML_TAG_LINE_RE.test(trimmedLine);
}

/**
 * Returns the first paragraph of `markdown`, for the detail panel's
 * summary state. Falls back to the first non-empty line if no block
 * qualifies as a paragraph (e.g. content that is nothing but a heading),
 * and to `""` for content with no non-empty line at all.
 *
 * CRLF is normalized to LF first — a document authored on Windows must
 * not have its blank-line detection (the block delimiter this function
 * scans on) silently broken by a trailing `\r` that survives a naive
 * `\n` split.
 */
export function firstParagraph(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const lineCount = lines.length;
  let index = 0;
  let firstNonEmptyLine: string | null = null;

  while (index < lineCount) {
    while (index < lineCount && lines[index]!.trim() === "") index++;
    if (index >= lineCount) break;

    const startLine = lines[index]!;
    const trimmedStart = startLine.trim();
    if (firstNonEmptyLine === null) {
      firstNonEmptyLine = trimmedStart;
    }

    if (FENCE_RE.test(trimmedStart)) {
      // A fenced block can contain blank lines internally (they're part
      // of the code, not a paragraph break) — skip everything up to and
      // including the matching closing fence, or to EOF if it's never
      // closed, rather than stopping at the first blank line the way an
      // ordinary excluded block does below.
      const fenceMarker = trimmedStart.slice(0, 3);
      index++;
      while (index < lineCount && !lines[index]!.trim().startsWith(fenceMarker)) index++;
      index++; // past the closing fence (or past EOF — the outer loop's bounds check handles that)
      continue;
    }

    if (isExcludedBlockStart(trimmedStart)) {
      while (index < lineCount && lines[index]!.trim() !== "") index++;
      continue;
    }

    const blockLines: string[] = [];
    while (index < lineCount && lines[index]!.trim() !== "") {
      blockLines.push(lines[index]!);
      index++;
    }
    return blockLines.join("\n").trim();
  }

  return firstNonEmptyLine ?? "";
}
