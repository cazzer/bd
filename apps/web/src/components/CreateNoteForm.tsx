// Standalone note creation (bd-hmd.6, task 6.4): "The explorer SHALL let
// a person create a note, either standing alone or as an annotation of
// an existing node" — the annotation half lives in DetailPanel.tsx's
// AnnotateSection; this is the standing-alone half, reachable with no
// node selected at all.

import { useState } from "react";
import { trpc } from "../trpc.js";
import { MarkdownEditor } from "./MarkdownEditor.js";

type CreateNoteResult = Awaited<ReturnType<typeof trpc.createNote.mutate>>;

export interface CreateNoteFormProps {
  onCreated: (result: CreateNoteResult, title: string | undefined) => void;
}

export function CreateNoteForm({ onCreated }: CreateNoteFormProps) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [getMarkdown, setGetMarkdown] = useState<(() => string) | null>(null);
  const [state, setState] = useState<{ kind: "idle" } | { kind: "saving" } | { kind: "error"; message: string }>({ kind: "idle" });

  async function handleCreate() {
    setState({ kind: "saving" });
    try {
      const content = getMarkdown ? getMarkdown() : undefined;
      const result = await trpc.createNote.mutate({ title: title.trim() || undefined, content });
      setState({ kind: "idle" });
      setOpen(false);
      const usedTitle = title.trim() || undefined;
      setTitle("");
      onCreated(result, usedTitle);
    } catch (err) {
      setState({ kind: "error", message: err instanceof Error ? err.message : "Note creation failed unexpectedly." });
    }
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
        + New note
      </button>
    );
  }

  return (
    <div className="rounded-lg border border-slate-300 bg-white p-3 shadow-sm">
      <p className="mb-2 text-xs text-slate-500">A standalone note has no edges until you annotate or connect it — it's still searchable and listed under "unlinked notes" until then.</p>
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Title (optional)"
        autoFocus
        className="mb-2 w-full rounded border border-slate-300 px-2 py-1 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
      />
      <div className="rounded border border-slate-300 px-2 py-1.5">
        <MarkdownEditor initialContent="" editable={true} onReady={(fn) => setGetMarkdown(() => fn)} ariaLabel="New note content" />
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={() => void handleCreate()}
          disabled={state.kind === "saving"}
          className="rounded bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {state.kind === "saving" ? "Creating…" : "Create note"}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="text-xs text-slate-500 hover:underline">
          Cancel
        </button>
        {state.kind === "error" && <span className="text-xs text-red-700">{state.message}</span>}
      </div>
    </div>
  );
}
