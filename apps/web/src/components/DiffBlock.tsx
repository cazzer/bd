// A unified diff shown with added and removed lines distinguished
// (decision-card-reviews, design.md decision 3). Used for a ```diff fence in
// EvidenceView and, by the card's attachments, for a `diff` attachment, so the
// two look the same. Every line is React text: the source is never markup.
// Colour is not the only signal — each added or removed line carries a
// visually hidden prefix a screen reader reads before it (and a copy leaves
// out). Long lines wrap rather than scroll sideways; each file in a
// multi-file diff starts below a rule.
//
// Wrapped lines hang (the continuation indents past the +/- column), so a
// wrapped added line still reads as one line. With `fill` (the run's stage),
// a file line shows only its `b/` path, the full header in its tooltip.
//
// Plain elements (div/span), not pre/code: inside EvidenceView the
// MarkdownEditor stylesheet styles `pre` and `code` with unlayered rules that
// would override these utilities, and the attachment copy has no such scope.

import { useMemo, useState } from "react";
import { classifyDiffLines, diffStats, fileLinePath, type DiffLineKind } from "../lib/diffLines.js";

const LINE_CLASS: Record<DiffLineKind, string> = {
  added: "bg-emerald-500/10 text-emerald-300",
  removed: "bg-red-500/10 text-red-300",
  hunk: "text-sky-300",
  file: "font-semibold text-fg",
  meta: "text-fg-muted",
  context: "text-fg",
};

const SCREEN_READER_PREFIX: Partial<Record<DiffLineKind, string>> = { added: "added: ", removed: "removed: " };

const FOCUS_RING = "focus:outline-none focus-visible:ring-2 focus-visible:ring-accent";

export interface DiffBlockProps {
  source: string;
  caption?: string;
  /**
   * A diff with more lines than this starts clipped to them, with a control
   * that shows the rest (and its added/removed counts). Default 24;
   * `Infinity` never clips.
   */
  maxLines?: number;
  /**
   * Fill the parent's height (the run's stage): never clipped, and the lines
   * scroll inside the block, which is then a focusable region so the keyboard
   * can scroll it. The parent must give it a height.
   */
  fill?: boolean;
}

export function DiffBlock({ source, caption, maxLines = 24, fill = false }: DiffBlockProps) {
  const lines = useMemo(() => classifyDiffLines(source), [source]);
  const [expanded, setExpanded] = useState(false);
  const clippable = !fill && lines.length > maxLines;
  const shown = clippable && !expanded ? lines.slice(0, maxLines) : lines;
  const stats = diffStats(lines);
  const scroller = fill ? { role: "region", tabIndex: 0, "aria-label": caption ?? "Diff" } : {};

  return (
    <figure className={fill ? "flex h-full min-h-0 min-w-0 flex-col" : "min-w-0"}>
      {caption && <figcaption className="mb-1.5 shrink-0 text-xs text-fg-muted">{caption}</figcaption>}
      <div {...scroller} className={`rounded-md border border-hairline bg-[#030509] py-2 font-mono text-xs leading-relaxed ${fill ? `min-h-0 flex-1 overflow-y-auto ${FOCUS_RING}` : ""}`}>
        {shown.map((line, i) => {
          const prefix = SCREEN_READER_PREFIX[line.kind];
          const fileRule = line.kind === "file" && i > 0 ? "mt-2 border-t border-hairline pt-2" : "";
          const shortFile = fill && line.kind === "file";
          return (
            <span
              key={i}
              data-diff-line={line.kind}
              title={shortFile ? line.text : undefined}
              className={`block whitespace-pre-wrap pl-[calc(0.75rem+2ch)] pr-3 -indent-[2ch] [overflow-wrap:anywhere] ${LINE_CLASS[line.kind]} ${fileRule}`}
            >
              {prefix && <span className="sr-only select-none">{prefix}</span>}
              {line.text === "" ? " " : shortFile ? fileLinePath(line.text) : line.text}
            </span>
          );
        })}
      </div>
      {clippable && (
        <button type="button" aria-expanded={expanded} onClick={() => setExpanded((open) => !open)} className={`mt-1.5 self-start rounded text-xs text-accent hover:underline ${FOCUS_RING}`}>
          {expanded ? "Show fewer lines" : `Show all ${lines.length} lines (+${stats.added} −${stats.removed})`}
        </button>
      )}
    </figure>
  );
}
