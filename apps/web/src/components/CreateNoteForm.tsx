// Standalone note creation (bd-hmd.6, task 6.4): "The explorer SHALL let
// a person create a note, either standing alone or as an annotation of
// an existing node" — the annotation half lives in DetailPanel.tsx's
// AnnotateSection; this is the standing-alone half, reachable with no
// node selected at all.
//
// bd-8ub: the trigger for this form moved from an inline header row into
// a frosted popover App.tsx opens from the search bar's "New note"
// button. `onCreated`'s contract is unchanged — the only addition is
// `autoOpen`, which skips this component's own inline "+ New note"
// toggle so the popover doesn't nest a second toggle inside its own;
// defaults to `false`, preserving this component's original standalone
// behaviour for any other caller.
//
// bd-8ub review, must-fix 1: when `autoOpen` is set, Cancel must not call
// this component's own `setOpen(false)` — that only flips this
// component's internal "expanded" flag, which (since `autoOpen` merely
// seeds initial state, per the paragraph above) re-renders THIS
// component's own collapsed "+ New note" trigger *inside* App.tsx's still-
// open outer popover (`noteFormOpen` is a separate piece of state App.tsx
// owns, untouched by this component). `onCancel` is the fix: when
// `autoOpen` is set, Cancel calls it instead, and the collapsed-trigger
// branch below is gated on `!autoOpen` so it can never render in that
// mode regardless of `open`'s own value.

import { useState } from "react";
import { trpc } from "../trpc.js";
import { MarkdownEditor } from "./MarkdownEditor.js";

type CreateNoteResult = Awaited<ReturnType<typeof trpc.createNote.mutate>>;

export interface CreateNoteFormProps {
  onCreated: (result: CreateNoteResult, title: string | undefined) => void;
  /** Render already expanded to the form, skipping the inline toggle button below. */
  autoOpen?: boolean;
  /** Cancel was activated while `autoOpen` is set — the caller (App.tsx's popover) closes itself; this component never falls back to its own collapsed trigger in that case. Ignored when `autoOpen` is false. */
  onCancel?: () => void;
}

export function CreateNoteForm({ onCreated, autoOpen = false, onCancel }: CreateNoteFormProps) {
  const [open, setOpen] = useState(autoOpen);
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

  if (!open && !autoOpen) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-xl border border-hairline px-3 py-2 text-sm font-medium text-fg hover:bg-surface-strong focus:outline-none focus:ring-2 focus:ring-accent"
      >
        + New note
      </button>
    );
  }

  return (
    <div>
      <p className="mb-2 text-xs text-fg-muted">A standalone note has no edges until you annotate or connect it — it's still searchable and listed under "unlinked notes" until then.</p>
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Title (optional)"
        autoFocus
        className="mb-2 w-full rounded-lg border border-hairline bg-surface-strong px-2 py-1 text-sm text-fg placeholder:text-fg-muted focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
      />
      <div className="rounded-lg border border-hairline bg-surface-strong/60 px-2 py-1.5">
        <MarkdownEditor initialContent="" editable={true} onReady={(fn) => setGetMarkdown(() => fn)} ariaLabel="New note content" />
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={() => void handleCreate()}
          disabled={state.kind === "saving"}
          className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-slate-950 hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
        >
          {state.kind === "saving" ? "Creating…" : "Create note"}
        </button>
        <button
          type="button"
          onClick={() => (autoOpen ? onCancel?.() : setOpen(false))}
          className="text-xs text-fg-muted hover:text-fg hover:underline focus:outline-none focus:ring-2 focus:ring-accent"
        >
          Cancel
        </button>
        {state.kind === "error" && <span className="text-xs text-red-400">{state.message}</span>}
      </div>
    </div>
  );
}
