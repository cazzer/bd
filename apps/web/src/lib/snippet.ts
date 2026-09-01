// Shared safe-snippet parsing (bd-hmd.3, moved to its own module in
// bd-hmd.4 so both the graph canvas's tooltips and any future list view
// use the identical logic — one implementation of a security-sensitive
// rule, not two that could drift).

export interface SnippetSegment {
  text: string;
  highlighted: boolean;
}

/**
 * Splits `ts_headline`'s `[[matched]]` delimiters (StartSel/StopSel,
 * configured in packages/core/src/retrieval.ts) into segments for safe
 * rendering — bd-hmd.3 review, stored XSS: `ts_headline` wraps *matched*
 * lexemes in `[[`/`]]` but does not HTML-escape the rest of the snippet,
 * and nothing in core rejects `<`/`>` in title/content (only C0 control
 * characters are blocked — see nodes.ts's `findControlChar`). A title of
 * `xsstest <img src=x onerror=alert(1)>` therefore came back byte-for-byte
 * in `snippet` and, via the `dangerouslySetInnerHTML` this originally
 * replaced, executed in the page with the tRPC client's full access.
 *
 * This function does no HTML parsing at all — it only recognizes the two
 * literal delimiter strings and splits on them. Every other character,
 * `<`/`>` included, becomes part of a segment's `text`. Every call site
 * must render that text through an API that treats it as text, never
 * markup: React JSX text content (which escapes unconditionally) or a
 * DOM node's `.textContent` (never `.innerHTML`) — see graph/tooltip.ts's
 * header for a second, non-React place this same rule applies.
 */
export function parseSnippetSegments(snippet: string): SnippetSegment[] {
  const segments: SnippetSegment[] = [];
  const parts = snippet.split(/(\[\[|\]\])/);
  let highlighted = false;
  for (const part of parts) {
    if (part === "[[") {
      highlighted = true;
      continue;
    }
    if (part === "]]") {
      highlighted = false;
      continue;
    }
    if (part.length > 0) {
      segments.push({ text: part, highlighted });
    }
  }
  return segments;
}
