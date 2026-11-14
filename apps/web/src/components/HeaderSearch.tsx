// The header search box (search-results-view, design.md decision 7): one
// compact input and a submit button, mounted beside `ReviewQueuePill` in
// every view's header but the graph's, which keeps its own SearchBar.
// Submitting opens the results view for the text — whitespace-only opens
// it with no text rather than doing nothing (search-results/spec.md,
// "Every view offers search"). The typed text is local state seeded from
// `initialText`; a caller whose text changes from outside (the results
// view, on back/forward) re-seeds it with a `key`. The input has no `id`:
// GraphView's bar owns `search-input`, and nothing needs to target this one.

import { useState, type FormEvent } from "react";
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
        type="search"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Search…"
        aria-label="Search everything"
        className="w-36 min-w-0 rounded-lg border border-hairline bg-surface-strong px-2.5 py-1 text-xs text-fg placeholder:text-fg-muted focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent sm:w-48"
      />
      <button
        type="submit"
        className="shrink-0 rounded-lg border border-hairline px-2.5 py-1 text-xs font-medium text-fg hover:bg-surface-strong focus:outline-none focus:ring-2 focus:ring-accent"
      >
        Search
      </button>
    </form>
  );
}
