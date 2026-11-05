// The review panel's attachment slot (review-queue, design.md decision 6):
// one renderer per attachment kind (lib/reviewAttachments.ts), drawn in a
// fixed order of kinds, each given the attachments of its kind (possibly
// none — a renderer stays mounted when its list empties, so it can put
// focus back itself). A new kind (bd-4zn: a Mermaid diagram, an ERD, a
// before/recommendation pair) is a new entry in RENDERERS and KIND_ORDER;
// nothing that hosts the panel changes.
//
// Images (board-visual-reviews, task 4.4): the first full width as a hero,
// the rest a two-column grid; each enlarges in the lightbox. A screenshot
// the server cannot serve shows as unavailable with its path, never hiding
// the rest. Focus returns to the thumbnail of the screenshot last shown
// once the lightbox has closed — or, when a re-read took that screenshot
// away, to the last one left, or the panel's title if none is.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { attachmentsOfKind, type ImageAttachment, type ReviewAttachment, type ReviewAttachmentKind } from "../lib/reviewAttachments.js";
import { Lightbox } from "./Lightbox.js";

export interface AttachmentRendererProps<K extends ReviewAttachmentKind> {
  attachments: Array<Extract<ReviewAttachment, { kind: K }>>;
  /** Put focus on the panel's title (what had focus went away). */
  focusTitle: () => void;
  /** An overlay of this renderer's opened or closed; Escape is the overlay's while it is open. */
  onOverlayChange: (open: boolean) => void;
}

type Renderers = { [K in ReviewAttachmentKind]: (props: AttachmentRendererProps<K>) => ReactNode };

const RENDERERS: Renderers = { image: ImageAttachments };

const KIND_ORDER: readonly ReviewAttachmentKind[] = ["image"];

export interface ReviewAttachmentsProps {
  attachments: readonly ReviewAttachment[];
  focusTitle: () => void;
  onOverlayChange: (open: boolean) => void;
}

export function ReviewAttachments({ attachments, focusTitle, onOverlayChange }: ReviewAttachmentsProps) {
  return (
    <>
      {KIND_ORDER.map((kind) => (
        <KindSlot key={kind} kind={kind} attachments={attachments} focusTitle={focusTitle} onOverlayChange={onOverlayChange} />
      ))}
    </>
  );
}

function KindSlot<K extends ReviewAttachmentKind>({ kind, attachments, focusTitle, onOverlayChange }: ReviewAttachmentsProps & { kind: K }) {
  const Renderer = RENDERERS[kind] as (props: AttachmentRendererProps<K>) => ReactNode;
  return <Renderer attachments={attachmentsOfKind(attachments, kind)} focusTitle={focusTitle} onOverlayChange={onOverlayChange} />;
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">{children}</h3>;
}

function ImageAttachments({ attachments, focusTitle, onOverlayChange }: AttachmentRendererProps<"image">) {
  const [lightbox, setLightbox] = useState<number | null>(null);
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  const thumbRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const images: ImageAttachment[] = attachments.map((img) => (img.src !== null && failed.has(img.src) ? { ...img, src: null } : img));

  const overlayOpen = lightbox !== null;
  useEffect(() => {
    onOverlayChange(overlayOpen);
  }, [overlayOpen]);

  const returnFocusTo = useRef<number | null>(null);
  useEffect(() => {
    if (lightbox === null || lightbox < images.length) return;
    returnFocusTo.current = images.length - 1;
    setLightbox(null);
  }, [lightbox, images.length]);
  useEffect(() => {
    if (lightbox !== null || returnFocusTo.current === null) return;
    const thumb = returnFocusTo.current >= 0 ? thumbRefs.current[returnFocusTo.current] : null;
    returnFocusTo.current = null;
    if (thumb) thumb.focus();
    else focusTitle();
  }, [lightbox]);

  function closeLightbox() {
    returnFocusTo.current = lightbox;
    setLightbox(null);
  }

  return (
    <>
      {images.length > 0 && (
        <section>
          <SectionTitle>Screenshots · {images.length}</SectionTitle>
          <ul role="list" className="grid grid-cols-2 gap-2">
            {images.map((img, i) => (
              <li key={`${i}:${img.path}`} className={i === 0 ? "col-span-2" : undefined}>
                <Thumb
                  image={img}
                  index={i}
                  hero={i === 0}
                  buttonRef={(el) => {
                    thumbRefs.current[i] = el;
                  }}
                  onOpen={() => setLightbox(i)}
                  onError={(src) => setFailed((prev) => new Set(prev).add(src))}
                />
              </li>
            ))}
          </ul>
        </section>
      )}
      {lightbox !== null && lightbox < images.length && <Lightbox images={images} index={lightbox} onIndexChange={setLightbox} onClose={closeLightbox} />}
    </>
  );
}

function Thumb({
  image,
  index,
  hero,
  buttonRef,
  onOpen,
  onError,
}: {
  image: ImageAttachment;
  index: number;
  hero: boolean;
  buttonRef: (el: HTMLButtonElement | null) => void;
  onOpen: () => void;
  onError: (src: string) => void;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      aria-label={`Enlarge screenshot ${index + 1}: ${image.name}`}
      onClick={onOpen}
      className="group block w-full overflow-hidden rounded-lg border border-hairline bg-ground text-left focus:outline-none focus:ring-2 focus:ring-accent"
    >
      {image.src === null ? (
        <span className={`flex items-center justify-center p-3 text-center text-xs text-fg-muted ${hero ? "min-h-32" : "aspect-[16/10]"}`}>
          <span>
            Can't show: <span className="break-all font-mono">{image.path}</span>
          </span>
        </span>
      ) : (
        <img
          src={image.src}
          alt=""
          loading={hero ? "eager" : "lazy"}
          decoding="async"
          onError={() => onError(image.src!)}
          className={`w-full transition-transform group-hover:scale-[1.02] ${hero ? "h-auto max-h-[60vh] object-contain" : "aspect-[16/10] object-cover object-top"}`}
        />
      )}
      <span className="block truncate border-t border-hairline px-2 py-1 font-mono text-[10px] text-fg-muted">
        {index + 1}. {image.name}
      </span>
    </button>
  );
}
