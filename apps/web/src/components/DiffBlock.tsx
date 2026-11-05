// A unified diff shown with added and removed lines distinguished
// (decision-card-reviews, design.md decision 3). Used for a ```diff fence in
// EvidenceView and, by the card's attachments, for a `diff` attachment, so the
// two look the same. Every line is React text: the source is never markup.
// Colour is not the only signal — each added or removed line carries a
// visually hidden prefix a screen reader reads before it.
//
// Plain elements (div/span), not pre/code: inside EvidenceView the
// MarkdownEditor stylesheet styles `pre` and `code` with unlayered rules that
// would override these utilities, and the attachment copy has no such scope.

import { classifyDiffLines, type DiffLineKind } from "../lib/diffLines.js";

const LINE_CLASS: Record<DiffLineKind, string> = {
  added: "bg-emerald-500/10 text-emerald-300",
  removed: "bg-red-500/10 text-red-300",
  hunk: "text-sky-300",
  meta: "text-fg-muted",
  context: "text-fg",
};

const SCREEN_READER_PREFIX: Partial<Record<DiffLineKind, string>> = { added: "added: ", removed: "removed: " };

export interface DiffBlockProps {
  source: string;
  caption?: string;
}

export function DiffBlock({ source, caption }: DiffBlockProps) {
  const lines = classifyDiffLines(source);
  return (
    <figure className="min-w-0">
      {caption && <figcaption className="mb-1.5 text-xs text-fg-muted">{caption}</figcaption>}
      <div className="overflow-x-auto rounded-md border border-hairline bg-[#030509] py-2 font-mono text-xs leading-relaxed">
        <div className="inline-block min-w-full">
          {lines.map((line, i) => {
            const prefix = SCREEN_READER_PREFIX[line.kind];
            return (
              <span key={i} data-diff-line={line.kind} className={`block whitespace-pre px-3 ${LINE_CLASS[line.kind]}`}>
                {prefix && <span className="sr-only">{prefix}</span>}
                {line.text === "" ? " " : line.text}
              </span>
            );
          })}
        </div>
      </div>
    </figure>
  );
}
