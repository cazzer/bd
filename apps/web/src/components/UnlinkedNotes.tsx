// Unlinked-notes list (bd-hmd.6, task 6.4): "surface an unlinked-notes
// list so [degree-zero notes] do not silently accumulate" — a degree-0
// note is invisible in the graph (nothing to draw an edge to) and
// reachable only by search otherwise; this is the "somewhere findable"
// design.md's own risk asks for. Backed by server/routers/read.ts's
// `listUnlinkedNotes` (see that procedure's header for how it's derived
// with no `packages/core` change).

import { useState } from "react";
import { trpc } from "../trpc.js";

type UnlinkedNote = Awaited<ReturnType<typeof trpc.listUnlinkedNotes.query>>["notes"][number];

export interface UnlinkedNotesProps {
  /** Draws the chosen note onto the canvas (graph/expansion.ts's `mergeStandaloneNode` + `graphNodeFromUnlinkedNote`) and selects it. */
  onShow: (note: UnlinkedNote) => void;
}

type State = { kind: "closed" } | { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; notes: UnlinkedNote[]; scannedNotes: number; scanTruncated: boolean };

export function UnlinkedNotes({ onShow }: UnlinkedNotesProps) {
  const [state, setState] = useState<State>({ kind: "closed" });

  async function open() {
    setState({ kind: "loading" });
    try {
      const result = await trpc.listUnlinkedNotes.query();
      setState({ kind: "ready", notes: result.notes, scannedNotes: result.scannedNotes, scanTruncated: result.scanTruncated });
    } catch (err) {
      setState({ kind: "error", message: err instanceof Error ? err.message : "Failed to load unlinked notes." });
    }
  }

  if (state.kind === "closed") {
    return (
      <button type="button" onClick={() => void open()} className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
        Unlinked notes
      </button>
    );
  }

  return (
    <div className="rounded-lg border border-slate-300 bg-white p-3 shadow-sm">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-medium tracking-wide text-slate-400 uppercase">Unlinked notes</h3>
        <button type="button" onClick={() => setState({ kind: "closed" })} aria-label="Close unlinked notes" className="text-slate-400 hover:text-slate-700">
          ×
        </button>
      </div>
      {state.kind === "loading" && <p className="text-xs text-slate-400">Loading…</p>}
      {state.kind === "error" && <p className="text-xs text-red-700">{state.message}</p>}
      {state.kind === "ready" && (
        <>
          {state.notes.length === 0 ? (
            <p className="text-xs text-slate-400">No unlinked notes ({state.scannedNotes} note{state.scannedNotes === 1 ? "" : "s"} checked).</p>
          ) : (
            <ul className="max-h-48 space-y-1 overflow-y-auto">
              {state.notes.map((note) => (
                <li key={note.id}>
                  <button type="button" onClick={() => onShow(note)} className="block w-full rounded px-1.5 py-1 text-left text-xs hover:bg-slate-100">
                    {note.title || "(untitled note)"}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {state.scanTruncated && <p className="mt-1 text-[10px] text-slate-400">Only the {state.scannedNotes} most recently updated notes were checked.</p>}
        </>
      )}
    </div>
  );
}
