// Minimal top-center frosted search bar (bd-8ub, tasks.md 2.3/2.4; type
// suggestions/chips bd-73t, tasks.md 4.2-4.4). Owns the query input,
// submit, a compact one-line status/error readout, and now also the
// type-suggestion dropdown and removable chip row — the collapsed form
// of what used to be App.tsx's header block. `trailing` is App.tsx's
// "New note" popover trigger; this component doesn't know what it
// renders, only that it belongs at the end of the bar.
//
// Suggestion/chip DATA (which types match, which are already chosen) is
// entirely App.tsx's — this component only renders `suggestions`/`chips`
// props and reports choices/removals back up, per design.md's "Search
// bar: minimal, and it searches types too". What IS local here: the
// listbox's own transient UI state (which row is arrow-key-highlighted,
// whether Escape dismissed it) — neither is derived from props, so
// neither belongs upstream in App.tsx.

import { useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import type { SearchResult } from "../graph/encoding.js";
import { colorForNodeType } from "../graph/palette.js";
import type { TypeCount } from "../graph/typePrevalence.js";

/**
 * Exported so App.tsx (which produces these values from `runSearch`) and
 * this component share exactly one shape — this component owns the
 * status line's rendering, so it owns the type.
 */
export type SearchBarStatus = { kind: "idle" } | { kind: "loading" } | { kind: "error"; message: string } | { kind: "done"; result: SearchResult };

export interface SearchBarProps {
  query: string;
  onQueryChange: (query: string) => void;
  onSubmit: (query: string) => void;
  status: SearchBarStatus;
  /** Rendered at the trailing end of the bar, as a sibling of the search <form> (see the render body for why it isn't nested inside it) — App.tsx's "New note" popover trigger. */
  trailing?: ReactNode;
  /** Node types matching the currently typed text (bd-73t) — App.tsx computes this via lib/typeMatch.ts's `matchNodeTypes` over `getStoreSummary().nodeTypes`, already excluding types already in `chips`. */
  suggestions: TypeCount[];
  /** Active type-filter chips — applied on the next submit as `search`'s `nodeTypes` filter. */
  chips: string[];
  /** A suggestion was chosen (click, or Enter with a row active) — App.tsx adds the chip and clears the typed text; this component does neither itself. */
  onChooseSuggestion: (nodeType: string) => void;
  /** A chip's own remove button was activated. */
  onRemoveChip: (nodeType: string) => void;
}

function statusLine(status: SearchBarStatus): { text: string; tone: "muted" | "error" } {
  switch (status.kind) {
    case "idle":
      return { text: "Search to see the graph.", tone: "muted" };
    case "loading":
      return { text: "Searching…", tone: "muted" };
    case "error":
      return { text: status.message, tone: "error" };
    case "done": {
      const result = status.result;
      if (result.mode === "empty") {
        return { text: `No matches. Tried both search modes: ${result.triedModes.join(" and ")}.`, tone: "muted" };
      }
      const seeds = `${result.seedCount} seed${result.seedCount === 1 ? "" : "s"}`;
      const nodes = `${result.nodeCount} node${result.nodeCount === 1 ? "" : "s"}`;
      const truncated = result.truncated ? " (truncated by nodeBudget)" : "";
      return { text: `${result.mode} match — ${seeds}, ${nodes}${truncated}`, tone: "muted" };
    }
  }
}

/** A removable type-filter pill (bd-73t) — a coloured swatch (same lookup TypePanel uses, so a type reads identically wherever it appears) plus an accessible remove control. */
function TypeChip({ nodeType, onRemove }: { nodeType: string; onRemove: () => void }) {
  return (
    <span className="flex shrink-0 items-center gap-1 rounded-full border border-hairline bg-surface-strong py-0.5 pr-1 pl-2 text-[11px] text-fg">
      <span aria-hidden className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: colorForNodeType(nodeType) }} />
      {nodeType}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`remove ${nodeType}`}
        className="ml-0.5 rounded-full px-1 text-fg-muted hover:bg-hairline hover:text-fg focus:outline-none focus:ring-1 focus:ring-accent"
      >
        ×
      </button>
    </span>
  );
}

export function SearchBar({ query, onQueryChange, onSubmit, status, trailing, suggestions, chips, onChooseSuggestion, onRemoveChip }: SearchBarProps) {
  const { text, tone } = statusLine(status);

  // Listbox UI state (bd-73t) — see this file's header on why this is
  // local rather than lifted to App.tsx. `activeIndex` is cleared
  // whenever the typed text changes or a choice is made, so a stale
  // highlight never survives onto a fresh suggestion list.
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [dismissed, setDismissed] = useState(false);

  const showSuggestions = suggestions.length > 0 && !dismissed;
  const activeSuggestion = activeIndex !== null && activeIndex < suggestions.length ? suggestions[activeIndex] : undefined;

  // graph-explorer/spec.md's own hint (design.md: "chips alone ... cannot
  // search, because the server's search procedure requires query to be
  // at least one character; the bar shows a hint ... rather than
  // attempting the call") — replaces the ordinary status line while true,
  // and the form's own onSubmit below refuses to call `onSubmit` too.
  const showTextHint = chips.length > 0 && query.trim().length === 0;

  function chooseSuggestion(nodeType: string) {
    onChooseSuggestion(nodeType);
    setActiveIndex(null);
    setDismissed(false);
  }

  function handleInputChange(value: string) {
    onQueryChange(value);
    setActiveIndex(null);
    setDismissed(false);
  }

  function handleInputKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (!showSuggestions) return; // nothing to navigate/dismiss — Enter/Escape fall through to their normal behaviour (submit, DetailPanel's own Escape-to-close)
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((current) => (current === null ? 0 : (current + 1) % suggestions.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((current) => (current === null ? suggestions.length - 1 : (current - 1 + suggestions.length) % suggestions.length));
    } else if (e.key === "Enter" && activeSuggestion) {
      // An active row wins over submitting — no active row (activeIndex
      // still null) leaves this branch untaken, so Enter falls through to
      // the form's own onSubmit as an ordinary search submission.
      e.preventDefault();
      chooseSuggestion(activeSuggestion.nodeType);
    } else if (e.key === "Escape") {
      // stopPropagation: dismissing THIS list is the whole meaning of this
      // Escape; no ancestor (App-level popover handlers included) should
      // also act on it.
      e.preventDefault();
      e.stopPropagation();
      setDismissed(true);
      setActiveIndex(null);
    }
  }

  return (
    <div className="glass px-4 py-3">
      <div className="flex items-center gap-2">
        {/*
          `trailing` (App.tsx's "New note" button + popover) is
          deliberately a SIBLING of this <form>, not a child of it: a
          plain single-line text input submits its nearest ancestor
          <form> on Enter, and CreateNoteForm's own title field would
          otherwise silently re-trigger a graph search (using whatever's
          still in THIS bar's query field) every time someone pressed
          Enter while naming a note.
        */}
        <form
          className="flex flex-1 flex-wrap items-center gap-2"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            // bd-8ub review, should-fix 8: submitting via Enter left the
            // suggestion list open when the typed text also happened to
            // match a type name (e.g. "spec" matching `openspec-*`),
            // covering the status line and canvas underneath it.
            // Dismissed unconditionally on submit — `handleInputChange`
            // already un-dismisses the moment the text changes again, so
            // this never permanently hides suggestions, only this one
            // now-submitted query's leftover list.
            setDismissed(true);
            setActiveIndex(null);
            if (showTextHint) {
              return; // server requires a non-empty query — chips alone can't search (design.md)
            }
            onSubmit(query);
          }}
        >
          {chips.map((nodeType) => (
            <TypeChip key={nodeType} nodeType={nodeType} onRemove={() => onRemoveChip(nodeType)} />
          ))}
          <div className="relative min-w-40 flex-1">
            <input
              type="text"
              value={query}
              onChange={(e) => handleInputChange(e.target.value)}
              onKeyDown={handleInputKeyDown}
              placeholder="Search…"
              aria-label="Search the knowledge store"
              role="combobox"
              aria-autocomplete="list"
              aria-haspopup="listbox"
              aria-expanded={showSuggestions}
              aria-controls="search-type-suggestions"
              aria-activedescendant={activeSuggestion ? `type-suggestion-${activeSuggestion.nodeType}` : undefined}
              className="w-full rounded-xl border border-hairline bg-surface-strong px-3 py-2 text-sm text-fg placeholder:text-fg-muted focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
              autoFocus
            />
            {showSuggestions && (
              <ul
                id="search-type-suggestions"
                role="listbox"
                aria-label="Matching node types"
                className="glass absolute top-full left-0 z-30 mt-1 max-h-48 w-full overflow-y-auto py-1"
              >
                {suggestions.map((suggestion, index) => (
                  <li
                    key={suggestion.nodeType}
                    id={`type-suggestion-${suggestion.nodeType}`}
                    role="option"
                    aria-selected={index === activeIndex}
                    // onMouseDown (not onClick alone) with preventDefault:
                    // stops the input from blurring before the click
                    // completes, which would otherwise close this list
                    // (showSuggestions depends on suggestions.length,
                    // itself driven by `query` from App.tsx) before the
                    // click ever registers.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => chooseSuggestion(suggestion.nodeType)}
                    className={`flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[13px] ${
                      index === activeIndex ? "bg-surface-strong text-fg" : "text-fg-muted hover:bg-surface-strong hover:text-fg"
                    }`}
                  >
                    <span aria-hidden className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: colorForNodeType(suggestion.nodeType) }} />
                    <span className="flex-1 truncate">{suggestion.nodeType}</span>
                    <span className="shrink-0">{suggestion.count}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <button
            type="submit"
            disabled={status.kind === "loading"}
            className="shrink-0 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-slate-950 hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-ground disabled:opacity-50"
          >
            {status.kind === "loading" ? "Searching…" : "Search"}
          </button>
        </form>
        {trailing}
      </div>
      <p
        className={`mt-2 min-h-[1.25rem] text-xs ${!showTextHint && tone === "error" ? "text-red-300" : "text-fg-muted"}`}
        role={!showTextHint && tone === "error" ? "alert" : undefined}
      >
        {showTextHint ? "add search text" : text}
      </p>
    </div>
  );
}
