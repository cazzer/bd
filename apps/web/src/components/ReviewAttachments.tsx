// The review panel's attachment slot (review-queue, design.md decision 6):
// one renderer per attachment kind (lib/reviewAttachments.ts), drawn in a
// fixed order of kinds, each given the attachments of its kind (possibly
// none — a renderer stays mounted when its list empties, so it can put
// focus back itself). A new kind (bd-4zn: a Mermaid diagram, an ERD) is a
// new entry in RENDERERS and KIND_ORDER; nothing that hosts the panel
// changes. Before/recommendation are not a kind: they are parts that cut
// across kinds (a "before" screenshot, a "recommended" diagram), so they
// would be a `part` field on each attachment that the panel groups by, part
// then kind, around this slot — not an entry here.
//
// Two layouts, chosen by the host through the panel. `column` (the drawer,
// and the run-through below `lg`) stacks the kinds in the scrolling body.
// `stage` (the run-through from `lg` up) gives the attachments the left
// column of the dialog at full height: kinds sit side by side, each filling
// its share, so a later kind lays out beside the screenshots in the stage
// and under them in the drawer without either host changing.
//
// Images (board-visual-reviews, task 4.4). In `column`: the first full
// width as a hero, the rest a two-column grid; each enlarges in the
// lightbox. In `stage`: one screenshot at a time filling the stage (click
// or Enter enlarges it), with a strip of thumbnails under it that choose
// which. A screenshot the server cannot serve shows as unavailable with its
// path, never hiding the rest. Focus returns to the control that opened the
// lightbox once it has closed — or, when a re-read took that screenshot
// away, to the last one left, or the panel's title if none is.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { attachmentsOfKind, type ImageAttachment, type ReviewAttachment, type ReviewAttachmentKind } from "../lib/reviewAttachments.js";
import { Lightbox } from "./Lightbox.js";

export type AttachmentLayout = "column" | "stage";

export interface AttachmentRendererProps<K extends ReviewAttachmentKind> {
  attachments: Array<Extract<ReviewAttachment, { kind: K }>>;
  layout: AttachmentLayout;
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
  layout: AttachmentLayout;
  focusTitle: () => void;
  /** Per kind, so one renderer closing its overlay never clears another's. */
  onOverlayChange: (kind: ReviewAttachmentKind, open: boolean) => void;
}

export function ReviewAttachments({ attachments, layout, focusTitle, onOverlayChange }: ReviewAttachmentsProps) {
  const slots = KIND_ORDER.map((kind) => <KindSlot key={kind} kind={kind} attachments={attachments} layout={layout} focusTitle={focusTitle} onOverlayChange={onOverlayChange} />);
  if (layout === "column") return <>{slots}</>;
  return <div className="flex h-full min-h-0 gap-4 [&>*]:min-w-0 [&>*]:flex-1">{slots}</div>;
}

function KindSlot<K extends ReviewAttachmentKind>({ kind, attachments, layout, focusTitle, onOverlayChange }: ReviewAttachmentsProps & { kind: K }) {
  const Renderer = RENDERERS[kind] as (props: AttachmentRendererProps<K>) => ReactNode;
  return <Renderer attachments={attachmentsOfKind(attachments, kind)} layout={layout} focusTitle={focusTitle} onOverlayChange={(open) => onOverlayChange(kind, open)} />;
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">{children}</h3>;
}

function ImageAttachments({ attachments, layout, focusTitle, onOverlayChange }: AttachmentRendererProps<"image">) {
  const [lightbox, setLightbox] = useState<number | null>(null);
  const [selected, setSelected] = useState(0);
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  const thumbRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const heroRef = useRef<HTMLButtonElement | null>(null);
  const images: ImageAttachment[] = attachments.map((img) => (img.src !== null && failed.has(img.src) ? { ...img, src: null } : img));
  const stage = layout === "stage";
  const shown = Math.min(selected, Math.max(0, images.length - 1));

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
    const target = returnFocusTo.current >= 0 ? (stage ? heroRef.current : thumbRefs.current[returnFocusTo.current]) : null;
    returnFocusTo.current = null;
    if (target) target.focus();
    else focusTitle();
  }, [lightbox]);

  function closeLightbox() {
    returnFocusTo.current = lightbox;
    // On the stage, the screenshot last shown enlarged stays on the stage.
    if (stage && lightbox !== null) setSelected(lightbox);
    setLightbox(null);
  }

  const onError = (src: string) => setFailed((prev) => new Set(prev).add(src));
  const lightboxEl = lightbox !== null && lightbox < images.length && <Lightbox images={images} index={lightbox} onIndexChange={setLightbox} onClose={closeLightbox} />;

  if (images.length === 0) return <>{lightboxEl}</>;

  if (stage) {
    const hero = images[shown]!;
    return (
      <section aria-label={`Screenshots · ${images.length}`} className="flex h-full min-h-0 flex-col gap-3">
        <button
          ref={heroRef}
          type="button"
          aria-label={`Enlarge screenshot ${shown + 1} of ${images.length}: ${hero.name}`}
          onClick={() => setLightbox(shown)}
          className="group relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-xl border border-hairline bg-ground focus:outline-none focus:ring-2 focus:ring-accent"
        >
          {hero.src === null ? (
            <span className="p-3 text-center text-xs text-fg-muted">
              Can't show: <span className="break-all font-mono">{hero.path}</span>
            </span>
          ) : (
            <img key={hero.src} src={hero.src} alt="" decoding="async" onError={() => onError(hero.src!)} className="h-full w-full object-contain" />
          )}
          <span className="absolute bottom-2 left-2 rounded-md border border-hairline bg-surface-strong px-2 py-0.5 font-mono text-[11px] text-fg-muted">
            {shown + 1} / {images.length} · {hero.name}
          </span>
        </button>
        {images.length > 1 && (
          <ul role="list" aria-label="Choose a screenshot" className="flex shrink-0 gap-2 overflow-x-auto pb-1">
            {images.map((img, i) => (
              <li key={`${i}:${img.path}`} className="shrink-0">
                <button
                  ref={(el) => {
                    thumbRefs.current[i] = el;
                  }}
                  type="button"
                  aria-label={`Show screenshot ${i + 1}: ${img.name}`}
                  aria-pressed={i === shown}
                  onClick={() => setSelected(i)}
                  className={`block h-16 w-28 overflow-hidden rounded-lg border bg-ground focus:outline-none focus:ring-2 focus:ring-accent ${i === shown ? "border-accent ring-1 ring-accent" : "border-hairline opacity-70 hover:opacity-100"}`}
                >
                  {img.src === null ? (
                    <span className="flex h-full items-center justify-center text-[11px] text-fg-muted">{i + 1}</span>
                  ) : (
                    <img src={img.src} alt="" loading="lazy" decoding="async" onError={() => onError(img.src!)} className="h-full w-full object-cover object-top" />
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
        {lightboxEl}
      </section>
    );
  }

  return (
    <>
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
                onError={onError}
              />
            </li>
          ))}
        </ul>
      </section>
      {lightboxEl}
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
