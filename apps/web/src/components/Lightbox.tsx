// The review drawer's enlarged screenshot (board-visual-reviews, task 4.4):
// a native <dialog> opened with showModal(), so the browser puts it in the
// top layer, makes the rest of the page inert, keeps focus inside it, and
// fires `cancel` on Escape wherever focus is — and undoes all of it when the
// dialog closes or unmounts, so no path can leave the page inert. Focus
// starts on the close button. ArrowLeft / ArrowRight step through the
// screenshots (wrapping). Escape's keydown is stopped here so the drawer
// around it does not also close. The parent owns where focus returns, and
// unmounts this when the screenshot it shows no longer exists.

import { useLayoutEffect, useRef, useState, type KeyboardEvent, type SyntheticEvent } from "react";
import { stepIndex } from "../lib/reviewDrawer.js";

export interface LightboxImage {
  name: string;
  path: string;
  /** Null when the image cannot be served; shown as unavailable. */
  src: string | null;
}

export interface LightboxProps {
  images: readonly LightboxImage[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}

const NAV_BUTTON =
  "grid size-11 shrink-0 place-items-center rounded-full border border-hairline bg-surface-strong text-fg hover:border-accent focus:outline-none focus:ring-2 focus:ring-accent";

export function Lightbox({ images, index, onIndexChange, onClose }: LightboxProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  const image = images[index];
  const n = images.length;

  // Before paint, so the dialog never shows un-modal for a frame.
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    closeRef.current?.focus();
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);

  function onCancel(e: SyntheticEvent<HTMLDialogElement>) {
    e.preventDefault();
    onClose();
  }

  function onKeyDown(e: KeyboardEvent<HTMLDialogElement>) {
    if (e.key === "Escape") {
      // `cancel` closes it; the drawer's own Escape handler must not see this.
      e.stopPropagation();
    } else if (e.key === "ArrowRight" && n > 1) {
      e.preventDefault();
      onIndexChange(stepIndex(index, 1, n));
    } else if (e.key === "ArrowLeft" && n > 1) {
      e.preventDefault();
      onIndexChange(stepIndex(index, -1, n));
    }
  }

  const unavailable = !image || image.src === null || failed.has(image.src);
  const label = image ? `Screenshot ${index + 1} of ${n}: ${image.name}` : "Screenshot";

  return (
    <dialog
      ref={dialogRef}
      aria-label={label}
      onCancel={onCancel}
      onKeyDown={onKeyDown}
      className="m-0 h-dvh max-h-none w-screen max-w-none flex-col bg-black/90 p-0 text-fg backdrop:bg-black/60 open:flex"
    >
      <div className="flex items-center gap-3 px-4 py-3 text-sm">
        <span className="shrink-0 font-mono text-fg-muted">
          {index + 1} / {n}
        </span>
        <span className="min-w-0 truncate">{image?.name}</span>
        <span className="ml-auto" />
        <button
          ref={closeRef}
          type="button"
          aria-label="Close image"
          onClick={onClose}
          className="grid size-11 shrink-0 place-items-center rounded-lg border border-hairline text-fg-muted hover:bg-surface-strong hover:text-fg focus:outline-none focus:ring-2 focus:ring-accent"
        >
          ✕
        </button>
      </div>
      <div className="flex min-h-0 flex-1 items-center gap-2 px-2 pb-4 sm:gap-4 sm:px-4">
        {n > 1 && (
          <button type="button" aria-label="Previous screenshot" onClick={() => onIndexChange(stepIndex(index, -1, n))} className={NAV_BUTTON}>
            ‹
          </button>
        )}
        <div className="flex h-full min-w-0 flex-1 items-center justify-center">
          {unavailable ? (
            <p className="max-w-full rounded-lg border border-hairline bg-surface-strong px-4 py-3 text-sm text-fg-muted">
              Can't show: <span className="break-all font-mono">{image?.path}</span>
            </p>
          ) : (
            <img
              key={image.src}
              src={image.src!}
              alt={image.name}
              onError={() => setFailed((prev) => new Set(prev).add(image.src!))}
              className="max-h-full max-w-full rounded-lg object-contain shadow-2xl"
            />
          )}
        </div>
        {n > 1 && (
          <button type="button" aria-label="Next screenshot" onClick={() => onIndexChange(stepIndex(index, 1, n))} className={NAV_BUTTON}>
            ›
          </button>
        )}
      </div>
    </dialog>
  );
}
