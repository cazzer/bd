// The review drawer's enlarged screenshot (board-visual-reviews, task 4.4):
// a modal dialog portaled to <body>. While it is open the app root is
// `inert`, so focus and the screen reader stay inside it; the flag is
// restored on unmount whatever closed it. Focus starts on the close button.
// ArrowLeft / ArrowRight step through the screenshots (wrapping); Escape
// closes and stops there, so the drawer underneath does not close too (React
// events bubble through portals to their React parent). The parent owns
// where focus returns on close.

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { stepIndex } from "../lib/reviewDrawer.js";

export interface LightboxImage {
  name: string;
  path: string;
  /** Null when the image cannot be served; shown as missing. */
  src: string | null;
}

export interface LightboxProps {
  images: readonly LightboxImage[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}

export function Lightbox({ images, index, onIndexChange, onClose }: LightboxProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  const image = images[index];
  const n = images.length;

  useEffect(() => {
    const root = document.getElementById("root");
    const wasInert = root?.inert ?? false;
    if (root) root.inert = true;
    closeRef.current?.focus();
    return () => {
      if (root) root.inert = wasInert;
    };
  }, []);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.stopPropagation();
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowRight" && n > 1) {
      e.preventDefault();
      onIndexChange(stepIndex(index, 1, n));
    } else if (e.key === "ArrowLeft" && n > 1) {
      e.preventDefault();
      onIndexChange(stepIndex(index, -1, n));
    }
  }

  if (!image) return null;
  const missing = image.src === null || failed.has(image.src);
  const label = `Screenshot ${index + 1} of ${n}: ${image.name}`;

  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={label} onKeyDown={onKeyDown} className="fixed inset-0 z-[60] flex flex-col bg-black/90 backdrop-blur-sm">
      <div className="flex items-center gap-3 px-4 py-3 text-sm text-fg">
        <span className="shrink-0 font-mono text-fg-muted">
          {index + 1} / {n}
        </span>
        <span className="min-w-0 truncate">{image.name}</span>
        <span className="ml-auto" />
        <button
          ref={closeRef}
          type="button"
          aria-label="Close image"
          onClick={onClose}
          className="grid size-10 shrink-0 place-items-center rounded-lg border border-hairline text-fg-muted hover:bg-surface-strong hover:text-fg focus:outline-none focus:ring-2 focus:ring-accent"
        >
          ✕
        </button>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center px-4 pb-4 sm:px-16">
        {n > 1 && (
          <button
            type="button"
            aria-label="Previous screenshot"
            onClick={() => onIndexChange(stepIndex(index, -1, n))}
            className="absolute left-3 z-10 grid size-10 place-items-center rounded-full border border-hairline bg-surface-strong text-fg hover:border-accent focus:outline-none focus:ring-2 focus:ring-accent"
          >
            ‹
          </button>
        )}
        {missing ? (
          <p className="max-w-full rounded-lg border border-hairline bg-surface-strong px-4 py-3 text-sm text-fg-muted">
            Missing: <span className="break-all font-mono">{image.path}</span>
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
        {n > 1 && (
          <button
            type="button"
            aria-label="Next screenshot"
            onClick={() => onIndexChange(stepIndex(index, 1, n))}
            className="absolute right-3 z-10 grid size-10 place-items-center rounded-full border border-hairline bg-surface-strong text-fg hover:border-accent focus:outline-none focus:ring-2 focus:ring-accent"
          >
            ›
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
}
