// The board's item drawer (board-visual-reviews, task 4.4; layout A + hero,
// picked at the 4.1 checkpoint): a 480 px panel at the right of the board
// from `sm` up, a full-screen sheet below it. From `sm` up it is non-modal —
// the board stays usable beside it (BoardView pads itself clear of it) — so
// it is an <aside> named by its title. Below `sm` it covers the board, so it
// is a modal dialog and BoardView makes the board inert. Escape inside it
// closes it, unless a draft is in the message box or a decision is being
// written, or the lightbox is open (ReviewItemPanel.tsx decides).
//
// This file is the frame and its Close; what it shows — the item read,
// summary, attachments, thread, and decision form — is ReviewItemPanel,
// which the review-all modal renders too (review-queue, design.md decision
// 6). BoardView keys this on the item alone and keeps the draft per item,
// so a project resolving late or a close-and-reopen never drops what was
// typed; the shell's queue drawer (ReviewQueue.tsx) mounts it the same way.

import { useEffect, useId, useState } from "react";
import { ReviewItemPanel } from "./ReviewItemPanel.js";

/** Tailwind's `sm`: at and above it the drawer is a side panel beside the board. */
const WIDE_QUERY = "(min-width: 40rem)";

/** True from `sm` up (the drawer is a non-modal side panel), false below it (a modal sheet). */
export function useWideDrawer(): boolean {
  const [wide, setWide] = useState(() => (typeof matchMedia === "function" ? matchMedia(WIDE_QUERY).matches : true));
  useEffect(() => {
    const query = matchMedia(WIDE_QUERY);
    const update = () => setWide(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return wide;
}

export interface ReviewDrawerProps {
  /** The item's project; null while it cannot be known yet (the drawer waits). */
  project: string | null;
  /** The addressed external id (a bead id). */
  item: string;
  /** False until the board's first read lands. */
  boardLoaded: boolean;
  /** Bumped by the board after every read; the drawer re-reads on it. */
  boardVersion: number;
  /** The draft kept for this item from an earlier opening. */
  initialDraft: string;
  onDraftChange: (draft: string) => void;
  /** A decision wrote something; the board keeps the card in view while it moves. */
  onDecided: () => void;
  /** `boardItem` found the item in `project`, so the board may stop guessing it. */
  onProjectConfirmed: (project: string) => void;
  onClose: () => void;
}

export function ReviewDrawer({ project, item, boardLoaded, boardVersion, initialDraft, onDraftChange, onDecided, onProjectConfirmed, onClose }: ReviewDrawerProps) {
  const titleId = useId();
  const wide = useWideDrawer();

  // A complementary <aside> beside the board from `sm` up; a modal dialog
  // (a <div>: `dialog` is not an allowed role on <aside>) below it.
  const Shell = wide ? "aside" : "div";

  return (
    <Shell
      aria-labelledby={titleId}
      role={wide ? undefined : "dialog"}
      aria-modal={wide ? undefined : true}
      className="glass fixed inset-0 z-40 flex flex-col overflow-hidden rounded-none border-0 bg-surface-strong sm:inset-auto sm:top-3 sm:right-3 sm:bottom-3 sm:w-[480px] sm:rounded-2xl sm:border"
    >
      <ReviewItemPanel
        project={project}
        item={item}
        boardLoaded={boardLoaded}
        boardVersion={boardVersion}
        initialDraft={initialDraft}
        onDraftChange={onDraftChange}
        onDecided={onDecided}
        onProjectConfirmed={onProjectConfirmed}
        onEscape={onClose}
        titleId={titleId}
        headerEnd={
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="grid size-11 shrink-0 place-items-center rounded-lg border border-hairline text-fg-muted hover:bg-surface-strong hover:text-fg focus:outline-none focus:ring-2 focus:ring-accent sm:size-9"
          >
            ✕
          </button>
        }
      />
    </Shell>
  );
}
