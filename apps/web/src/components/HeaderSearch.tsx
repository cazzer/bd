// The header search box (search-results-view, design.md decision 7): one
// compact input and a submit button, mounted beside `ReviewQueuePill` in
// every view's header but the graph's, which keeps its own SearchBar.
// Submitting opens the results view for the text — whitespace-only opens
// it with no text rather than doing nothing (search-results/spec.md,
// "Every view offers search"). The typed text is local state seeded from
// `initialText`, and re-seeded when `initialText` changes (the results
// view, on back/forward) — but never while the box has focus, so a submit
// from the results view keeps the caret where the person is typing rather
// than remounting the input. The input has no `id`: GraphView's bar owns
// `search-input`, and nothing needs to target this one.

import { useEffect, useRef, useState, type FormEvent } from "react";
import { navigate } from "../lib/navigate.js";
import { searchRouteFor } from "../lib/searchRow.js";

export interface HeaderSearchProps {
  /** The text the box starts with. */
  initialText?: string;
  /** Called with the submitted text instead of the default push to `/search?q=<text>` — the results view uses it to keep its filters. */
  onSubmit?: (text: string) => void;
}

export function HeaderSearch({ initialText = "", onSubmit }: HeaderSearchProps) {
  const [text, setText] = useState(initialText);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (document.activeElement !== inputRef.current) {
      setText(initialText);
    }
  }, [initialText]);

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (onSubmit) {
      onSubmit(text);
    } else {
      navigate(searchRouteFor(text), "push");
    }
  }

  return (
    <form role="search" onSubmit={handleSubmit} className="flex min-w-0 items-center gap-1.5">
      <input
        ref={inputRef}
        type="search"
        value={text}
        // The server's `find` text bound (MAX_FIND_TEXT_LENGTH in packages/core/src/find.ts).
        maxLength={500}
        onChange={(e) => setText(e.target.value)}
        placeholder="Search…"
        aria-label="Search everything"
        className="min-h-11 w-36 min-w-0 rounded-lg border border-hairline bg-surface-strong px-2.5 py-1 text-xs text-fg placeholder:text-fg-muted focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent sm:min-h-0 sm:w-48"
      />
      <button
        type="submit"
        className="min-h-11 shrink-0 rounded-lg border border-hairline px-2.5 py-1 text-xs font-medium text-fg hover:bg-surface-strong focus:outline-none focus:ring-2 focus:ring-accent sm:min-h-0"
      >
        Search
      </button>
    </form>
  );
}
