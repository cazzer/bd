// Unlinked-notes list (bd-hmd.6, task 6.4): "surface an unlinked-notes
// list so [degree-zero notes] do not silently accumulate" — a degree-0
// note is invisible in the graph (nothing to draw an edge to) and
// reachable only by search otherwise; this is the "somewhere findable"
// design.md's own risk asks for. Backed by server/routers/read.ts's
// `listUnlinkedNotes` (see that procedure's header for how it's derived
// with no `packages/core` change).
//
// bd-8ub: now a small frosted disclosure pinned bottom-left, collapsed
// by default to a bare count ("N unlinked notes"). That count has to be
// known BEFORE the disclosure is ever opened, so the fetch that used to
// fire on the trigger button's click now fires once on mount instead —
// the only behavioural change this shell rewrite makes to this
// component; `onShow`'s contract and the list's own rendering are
// unchanged. `<details>`/`<summary>` gives the expand/collapse toggle
// native keyboard and screen-reader semantics for free.

import { useEffect, useState } from "react";
import { trpc } from "../trpc.js";

type UnlinkedNote = Awaited<ReturnType<typeof trpc.listUnlinkedNotes.query>>["notes"][number];

export interface UnlinkedNotesProps {
  /** Draws the chosen note onto the canvas (graph/expansion.ts's `mergeStandaloneNode` + `graphNodeFromUnlinkedNote`) and selects it. */
  onShow: (note: UnlinkedNote) => void;
}

type State = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; notes: UnlinkedNote[]; scannedNotes: number; scanTruncated: boolean };

export function UnlinkedNotes({ onShow }: UnlinkedNotesProps) {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    trpc.listUnlinkedNotes
      .query()
      .then((result) => {
        if (cancelled) return;
        setState({ kind: "ready", notes: result.notes, scannedNotes: result.scannedNotes, scanTruncated: result.scanTruncated });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({ kind: "error", message: err instanceof Error ? err.message : "Failed to load unlinked notes." });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const summary = state.kind === "loading" ? "Unlinked notes…" : state.kind === "error" ? "Unlinked notes" : `${state.notes.length} unlinked note${state.notes.length === 1 ? "" : "s"}`;

  return (
    <details className="glass max-w-xs px-3 py-2 text-sm">
      <summary className="cursor-pointer text-fg-muted select-none focus:outline-none focus-visible:ring-2 focus-visible:ring-accent">{summary}</summary>
      <div className="mt-2">
        {state.kind === "loading" && <p className="text-xs text-fg-muted">Loading…</p>}
        {state.kind === "error" && <p className="text-xs text-red-400">{state.message}</p>}
        {state.kind === "ready" && (
          <>
            {state.notes.length === 0 ? (
              <p className="text-xs text-fg-muted">No unlinked notes ({state.scannedNotes} note{state.scannedNotes === 1 ? "" : "s"} checked).</p>
            ) : (
              <ul className="max-h-48 space-y-1 overflow-y-auto">
                {state.notes.map((note) => (
                  <li key={note.id}>
                    <button
                      type="button"
                      onClick={() => onShow(note)}
                      className="block w-full rounded-lg px-1.5 py-1 text-left text-xs text-fg hover:bg-surface-strong focus:outline-none focus:ring-2 focus:ring-accent"
                    >
                      {note.title || "(untitled note)"}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {state.scanTruncated && <p className="mt-1 text-[10px] text-fg-muted">Only the {state.scannedNotes} most recently updated notes were checked.</p>}
          </>
        )}
      </div>
    </details>
  );
}
