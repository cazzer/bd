// The review drawer's enlarged screenshot or video (board-visual-reviews,
// task 4.4; video-review-attachments, design.md decision 7): a native
// <dialog> opened with showModal(), so the browser puts it in the top layer,
// makes the rest of the page inert, keeps focus inside it, and fires `cancel`
// on Escape wherever focus is — and undoes all of it when the dialog closes
// or unmounts, so no path can leave the page inert. Focus starts on the close
// button. ArrowLeft / ArrowRight step through the items (wrapping), except
// from a <video>, whose own controls take those keys to seek. Escape's
// keydown is stopped here so the drawer around it does not also close. The
// parent owns where focus returns, and unmounts this when the item it shows
// no longer exists.
//
// A video plays from `startAt` (the inline player's time), muted and looping
// as the inline player was, and closing reports the time it reached and its
// mute and loop, so the inline player picks up there as it was left.

import { useLayoutEffect, useRef, useState, type KeyboardEvent, type SyntheticEvent } from "react";
import { stepIndex } from "../lib/reviewDrawer.js";

export interface LightboxItem {
  name: string;
  path: string;
  /** Null when the file cannot be served; shown as unavailable. */
  src: string | null;
  /** Absent means an image. */
  kind?: "image" | "video";
  /** A video's poster image, or null. */
  poster?: string | null;
  /** A video starts muted unless this is false. */
  muted?: boolean;
  /** A video loops when this is true. */
  loop?: boolean;
}

/** Where an enlarged video was left when the lightbox closed. */
export interface LightboxVideoState {
  time: number;
  muted: boolean;
  loop: boolean;
}

export interface LightboxProps {
  items: readonly LightboxItem[];
  index: number;
  onIndexChange: (index: number) => void;
  /** Where a video item starts playing, in seconds. */
  startAt?: number;
  /** `video` is where a shown video was left; absent for an image. */
  onClose: (video?: LightboxVideoState) => void;
}

const NAV_BUTTON =
  "grid size-11 shrink-0 place-items-center rounded-full border border-hairline bg-surface-strong text-fg hover:border-accent focus:outline-none focus:ring-2 focus:ring-accent";

export function Lightbox({ items, index, onIndexChange, startAt, onClose }: LightboxProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  const item = items[index];
  const n = items.length;
  const isVideo = item?.kind === "video";
  const noun = isVideo ? "Video" : "Screenshot";

  // Before paint, so the dialog never shows un-modal for a frame.
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    closeRef.current?.focus();
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);

  function close() {
    const player = isVideo ? videoRef.current : null;
    onClose(player ? { time: player.currentTime, muted: player.muted, loop: player.loop } : undefined);
  }

  function onCancel(e: SyntheticEvent<HTMLDialogElement>) {
    // React carries `cancel` up the tree; a dialog around this one (the review-all run) must not take it as its own.
    e.stopPropagation();
    e.preventDefault();
    close();
  }

  function onKeyDown(e: KeyboardEvent<HTMLDialogElement>) {
    if (e.key === "Escape") {
      // `cancel` closes it; the drawer's own Escape handler must not see this.
      e.stopPropagation();
      return;
    }
    if (e.target instanceof HTMLVideoElement) return;
    if (e.key === "ArrowRight" && n > 1) {
      e.preventDefault();
      onIndexChange(stepIndex(index, 1, n));
    } else if (e.key === "ArrowLeft" && n > 1) {
      e.preventDefault();
      onIndexChange(stepIndex(index, -1, n));
    }
  }

  const unavailable = !item || item.src === null || failed.has(item.src);
  const label = item ? `${noun} ${index + 1} of ${n}: ${item.name}` : noun;
  const markFailed = () => setFailed((prev) => new Set(prev).add(item!.src!));

  return (
    <dialog
      ref={dialogRef}
      // Focusable itself, so a click on the image or backdrop leaves focus here and the arrow keys keep working.
      tabIndex={-1}
      aria-label={label}
      onCancel={onCancel}
      onKeyDown={onKeyDown}
      className="m-0 h-dvh max-h-none w-screen max-w-none flex-col bg-black/90 p-0 text-fg backdrop:bg-black/60 open:flex"
    >
      <div className="flex items-center gap-3 px-4 py-3 text-sm">
        <span className="shrink-0 font-mono text-fg-muted">
          {index + 1} / {n}
        </span>
        <span className="min-w-0 truncate">{item?.name}</span>
        <span className="ml-auto" />
        <button
          ref={closeRef}
          type="button"
          aria-label="Close"
          onClick={close}
          className="grid size-11 shrink-0 place-items-center rounded-lg border border-hairline text-fg-muted hover:bg-surface-strong hover:text-fg focus:outline-none focus:ring-2 focus:ring-accent"
        >
          ✕
        </button>
      </div>
      <div className="flex min-h-0 flex-1 items-center gap-2 px-2 pb-4 sm:gap-4 sm:px-4">
        {n > 1 && (
          <button type="button" aria-label={`Previous ${noun.toLowerCase()}`} onClick={() => onIndexChange(stepIndex(index, -1, n))} className={NAV_BUTTON}>
            ‹
          </button>
        )}
        <div className="flex h-full min-w-0 flex-1 items-center justify-center">
          {unavailable ? (
            <p className="max-w-full rounded-lg border border-hairline bg-surface-strong px-4 py-3 text-sm text-fg-muted">
              Can't show: <span className="break-all font-mono">{item?.path}</span>
            </p>
          ) : isVideo ? (
            <video
              ref={videoRef}
              key={item.src}
              src={item.src!}
              poster={item.poster ?? undefined}
              aria-label={item.name}
              controls
              playsInline
              autoPlay
              muted={item.muted ?? true}
              loop={item.loop ?? false}
              onLoadedMetadata={(e) => {
                if (startAt !== undefined && startAt > 0) e.currentTarget.currentTime = startAt;
              }}
              onError={markFailed}
              className="max-h-full max-w-full rounded-lg bg-black shadow-2xl"
            />
          ) : (
            <img key={item.src} src={item.src!} alt={item.name} onError={markFailed} className="max-h-full max-w-full rounded-lg object-contain shadow-2xl" />
          )}
        </div>
        {n > 1 && (
          <button type="button" aria-label={`Next ${noun.toLowerCase()}`} onClick={() => onIndexChange(stepIndex(index, 1, n))} className={NAV_BUTTON}>
            ›
          </button>
        )}
      </div>
    </dialog>
  );
}
