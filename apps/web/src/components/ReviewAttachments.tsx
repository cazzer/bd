// The review panel's attachment slot (review-queue, design.md decision 6;
// decision-card-reviews, design.md decision 7): one renderer per attachment
// kind (lib/reviewAttachments.ts), drawn in a fixed order, each given the
// attachments of its kind (possibly none — a renderer stays mounted when its
// list empties, so it can put focus back itself). Ahead of the kinds sits
// the before/after slot: a `before` immediately followed by an `after`
// (`pairAttachments`), of any kinds, shown side by side under Before and
// After labels; whatever is not paired goes to its kind. Order: pairs,
// screenshots, diagrams, diffs. A new kind is a new entry in RENDERERS and
// KIND_ORDER; nothing that hosts the panel changes.
//
// Two layouts, chosen by the host through the panel. `column` (the drawer,
// and the run-through below `lg`) stacks the slots in the scrolling body.
// `stage` (the run-through from `lg` up) gives the attachments the left
// column of the dialog at full height: the slots stack, each filling its
// share (a pair takes the larger one, so a pair with a diagram has the pair
// on top and the diagram below); a lone diff fills the stage and scrolls
// inside itself.
//
// Images (board-visual-reviews, task 4.4). In `column`: the first full
// width as a hero, the rest a two-column grid; each enlarges in the
// lightbox. In `stage`: one screenshot at a time filling the stage (click
// or Enter enlarges it), with a strip of thumbnails under it that choose
// which. A screenshot the server cannot serve shows as unavailable with its
// path, never hiding the rest. Focus returns to the control that opened the
// lightbox once it has closed — or, when a re-read took that screenshot
// away, to the last one left, or the panel's title if none is. Paired
// screenshots enlarge the same way, stepping through the pairs' images.
//
// Diagrams and diffs reuse the evidence's MermaidBlock and DiffBlock, so an
// attachment and a fence look the same. In `column` a diff is clipped (its
// "show all" control carries its stats); on the stage it is never clipped.
// A drawn diagram opens its own enlarged view (MermaidDiagram.tsx); the panel
// keeps its shortcuts out of any dialog inside it, so that view needs no
// overlay report.
//
// Videos (video-review-attachments, design.md decisions 5-8). Each plays in
// a vertical 9:16 player (`ReviewVideo`): muted, started by a click on it,
// native controls, metadata only until played, a Loop toggle on by default,
// and an Enlarge button (a click on the video plays it, so enlarging is its
// own control) that opens it in the lightbox at the inline player's time and
// takes the lightbox's time back on close. A video that names a card option
// goes to the cuts slot, ahead of the pairs: one cell per option with a
// video, in the card's option order (A left), each headed by its id, label,
// and — the recommended one — a Recommended chip; it is marked, never moved.
// The rest go to the Videos slot. While the host passes `onTimestamp` (the
// decision is open), each player has a Note button showing its current time,
// which hands the host `timestampNote` text for the message.

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  attachmentLabel,
  attachmentsOfKind,
  pairAttachments,
  pairLabel,
  type AttachmentPair,
  type AttachmentPairPart,
  type ImageAttachment,
  type ReviewAttachment,
  type ReviewAttachmentKind,
  formatVideoTime,
  optionVideos,
  timestampNote,
  type VideoAttachment,
} from "../lib/reviewAttachments.js";
import { DiffBlock } from "./DiffBlock.js";
import { Lightbox, type LightboxVideoState } from "./Lightbox.js";
import { MermaidBlock } from "./MermaidBlock.js";
import { IdBadge } from "./ReviewCardBody.js";

export type AttachmentLayout = "column" | "stage";

/** A slot of the attachments: the options' cuts, the before/after pairs, or one kind. Overlays are reported per slot. */
export type AttachmentSlot = "options" | "pair" | ReviewAttachmentKind;

export interface AttachmentRendererProps<K extends ReviewAttachmentKind> {
  attachments: Array<Extract<ReviewAttachment, { kind: K }>>;
  layout: AttachmentLayout;
  /** Put focus on the panel's title (what had focus went away). */
  focusTitle: () => void;
  /** An overlay of this renderer's opened or closed; Escape is the overlay's while it is open. */
  onOverlayChange: (open: boolean) => void;
  /** A video's Note pressed: the text to add to the message. Absent while the decision is not open. */
  onTimestamp?: (note: string) => void;
}

type Renderers = { [K in ReviewAttachmentKind]: (props: AttachmentRendererProps<K>) => ReactNode };

const RENDERERS: Renderers = { image: ImageAttachments, video: VideoAttachments, mermaid: MermaidAttachments, diff: DiffAttachments };

const KIND_ORDER: readonly ReviewAttachmentKind[] = ["image", "video", "mermaid", "diff"];

/** Lines a diff shows in the column before its "show all" control. */
const COLUMN_DIFF_LINES = 12;

/** A card option as the cuts slot heads a cell with it. */
export interface AttachmentOption {
  id: string;
  label: string;
}

export interface ReviewAttachmentsProps {
  attachments: readonly ReviewAttachment[];
  layout: AttachmentLayout;
  focusTitle: () => void;
  /** Per slot, so one renderer closing its overlay never clears another's. */
  onOverlayChange: (slot: AttachmentSlot, open: boolean) => void;
  /** The card's options, in card order; a video naming one is shown in its cell. */
  options?: readonly AttachmentOption[];
  /** The recommended option's id, marked in its cell. */
  recommend?: string | null;
  /** A video's Note pressed (see AttachmentRendererProps); absent hides the Note buttons. */
  onTimestamp?: (note: string) => void;
}

const NO_OPTIONS: readonly AttachmentOption[] = [];

export function ReviewAttachments({ attachments, layout, focusTitle, onOverlayChange, options = NO_OPTIONS, recommend = null, onTimestamp }: ReviewAttachmentsProps) {
  const { byOption, rest: unoptioned } = optionVideos(
    attachments,
    options.map((o) => o.id),
  );
  const { pairs, rest } = pairAttachments(unoptioned);
  const cells = byOption.map(({ optionId, video }) => ({ option: options.find((o) => o.id === optionId)!, video }));
  const slots = [
    <OptionVideos key="options" cells={cells} recommend={recommend} layout={layout} focusTitle={focusTitle} onOverlayChange={(open) => onOverlayChange("options", open)} onTimestamp={onTimestamp} />,
    <PairAttachments key="pair" pairs={pairs} layout={layout} focusTitle={focusTitle} onOverlayChange={(open) => onOverlayChange("pair", open)} onTimestamp={onTimestamp} />,
    ...KIND_ORDER.map((kind) => (
      <KindSlot key={kind} kind={kind} attachments={rest} layout={layout} focusTitle={focusTitle} onOverlayChange={onOverlayChange} onTimestamp={onTimestamp} />
    )),
  ];
  if (layout === "column") return <>{slots}</>;
  return <div className="flex h-full min-h-0 flex-col gap-4">{slots}</div>;
}

function KindSlot<K extends ReviewAttachmentKind>({
  kind,
  attachments,
  layout,
  focusTitle,
  onOverlayChange,
  onTimestamp,
}: Pick<ReviewAttachmentsProps, "attachments" | "layout" | "focusTitle" | "onOverlayChange" | "onTimestamp"> & { kind: K }) {
  const Renderer = RENDERERS[kind] as (props: AttachmentRendererProps<K>) => ReactNode;
  return (
    <Renderer
      attachments={attachmentsOfKind(attachments, kind)}
      layout={layout}
      focusTitle={focusTitle}
      onOverlayChange={(open) => onOverlayChange(kind, open)}
      {...(onTimestamp === undefined ? {} : { onTimestamp })}
    />
  );
}

/**
 * A slot's open overlays, its own (`ownOpen`) and its videos' enlarged
 * views, reported to the host as one flag. A video reports through the
 * returned callback, open on enlarging and closed on closing or unmounting.
 */
function useSlotOverlay(onOverlayChange: (open: boolean) => void, ownOpen = false): (open: boolean) => void {
  const [videosOpen, setVideosOpen] = useState(0);
  const open = ownOpen || videosOpen > 0;
  useEffect(() => {
    onOverlayChange(open);
  }, [open]);
  return (videoOpen: boolean) => setVideosOpen((n) => Math.max(0, n + (videoOpen ? 1 : -1)));
}

export function SectionTitle({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <h3 id={id} className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
      {children}
    </h3>
  );
}

/** A slot's share of the stage; nothing in the column. */
const STAGE_SHARE = "min-h-0 min-w-0 flex-[2]";

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
  const lightboxEl = lightbox !== null && lightbox < images.length && <Lightbox items={images} index={lightbox} onIndexChange={setLightbox} onClose={closeLightbox} />;

  if (images.length === 0) return <>{lightboxEl}</>;

  if (stage) {
    const hero = images[shown]!;
    return (
      <section aria-label={`Screenshots · ${images.length}`} className={`flex flex-col gap-3 ${STAGE_SHARE}`}>
        <button
          ref={heroRef}
          type="button"
          aria-label={`Enlarge screenshot ${shown + 1} of ${images.length}: ${attachmentLabel(hero)}`}
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
            {shown + 1} / {images.length} · {attachmentLabel(hero)}
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
                  aria-label={`Show screenshot ${i + 1}: ${attachmentLabel(img)}`}
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
      aria-label={`Enlarge screenshot ${index + 1}: ${attachmentLabel(image)}`}
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
        {index + 1}. {attachmentLabel(image)}
      </span>
    </button>
  );
}

/** Videos that name no option: each a vertical player with its caption, two to a row in the column, in one row on the stage. */
function VideoAttachments({ attachments, layout, focusTitle, onOverlayChange, onTimestamp }: AttachmentRendererProps<"video">) {
  const onEnlargedChange = useSlotOverlay(onOverlayChange);
  if (attachments.length === 0) return null;
  const stage = layout === "stage";
  const title = `Videos · ${attachments.length}`;
  return (
    <section aria-label={title} className={stage ? `flex flex-col ${STAGE_SHARE}` : undefined}>
      <SectionTitle>{title}</SectionTitle>
      <ul role="list" className={stage ? "flex min-h-0 flex-1 gap-3" : "grid grid-cols-2 gap-3"}>
        {attachments.map((v, i) => (
          <li key={`${i}:${v.path}`} className={stage ? "flex min-h-0 min-w-0 flex-1 flex-col" : "min-w-0"}>
            <ReviewVideo video={v} label={attachmentLabel(v) ?? v.name} stage={stage} focusTitle={focusTitle} onEnlargedChange={onEnlargedChange} onTimestamp={onTimestamp} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The options' cuts side by side, in the card's option order, each under its
 * option's id badge and label, the recommended one marked (design.md
 * decision 6). Two to a row in the column (three once there are three or
 * more); one row on the stage, ahead of the pairs.
 */
function OptionVideos({
  cells,
  recommend,
  layout,
  focusTitle,
  onOverlayChange,
  onTimestamp,
}: {
  cells: Array<{ option: AttachmentOption; video: VideoAttachment }>;
  recommend: string | null;
  layout: AttachmentLayout;
  focusTitle: () => void;
  onOverlayChange: (open: boolean) => void;
  onTimestamp?: (note: string) => void;
}) {
  const onEnlargedChange = useSlotOverlay(onOverlayChange);
  if (cells.length === 0) return null;
  const stage = layout === "stage";
  const title = `Cuts · ${cells.length}`;
  return (
    <section aria-label={title} className={stage ? "flex min-h-0 min-w-0 flex-[3] flex-col" : undefined}>
      <SectionTitle>{title}</SectionTitle>
      <ul role="list" className={stage ? "flex min-h-0 flex-1 gap-3" : `grid gap-3 ${cells.length >= 3 ? "grid-cols-3" : "grid-cols-2"}`}>
        {cells.map(({ option, video }) => {
          const recommended = option.id === recommend;
          return (
            <li key={option.id} data-option-id={option.id} className={stage ? "flex min-h-0 min-w-0 flex-1 flex-col" : "min-w-0"}>
              <div className="mb-1.5 flex min-w-0 items-center gap-2">
                <IdBadge id={option.id} accent={recommended} />
                <span title={option.label} className={`min-w-0 truncate text-xs text-fg ${recommended ? "font-semibold" : ""}`}>
                  <span className="sr-only">Option {option.id}: </span>
                  {option.label}
                </span>
                {recommended && <span className="ml-auto shrink-0 rounded-full border border-accent/60 bg-accent/15 px-2 py-0.5 text-[11px] text-fg">Recommended</span>}
              </div>
              <ReviewVideo
                video={video}
                label={`option ${option.id}${video.caption !== undefined ? `: ${video.caption}` : ""}`}
                optionId={option.id}
                stage={stage}
                focusTitle={focusTitle}
                onEnlargedChange={onEnlargedChange}
                onTimestamp={onTimestamp}
              />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const PLAYER_BUTTON =
  "rounded-md border border-hairline px-2 py-1 text-[11px] text-fg-muted hover:border-accent hover:text-fg focus:outline-none focus:ring-2 focus:ring-accent aria-pressed:border-accent aria-pressed:text-fg";

/**
 * One video as a vertical reel (module header): muted, click to play,
 * native controls, metadata only until played, a Loop toggle (on), Enlarge,
 * and Note while `onTimestamp` is given. `label` names it in its controls'
 * labels; `optionId` marks a note with the option it is the cut of. Its
 * enlarged view is reported through `onEnlargedChange`; when it unmounts
 * while enlarged, focus goes to the panel's title.
 */
function ReviewVideo({
  video,
  label,
  optionId,
  stage = false,
  focusTitle,
  onEnlargedChange,
  onTimestamp,
}: {
  video: VideoAttachment;
  label: string;
  optionId?: string;
  stage?: boolean;
  focusTitle: () => void;
  onEnlargedChange: (open: boolean) => void;
  onTimestamp?: (note: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const enlargeRef = useRef<HTMLButtonElement>(null);
  const [loop, setLoop] = useState(true);
  const [failed, setFailed] = useState<string | null>(null);
  /** The whole second the player is at, so Note re-renders once a second at most. */
  const [second, setSecond] = useState(0);
  const [enlarged, setEnlarged] = useState<{ startAt: number; muted: boolean } | null>(null);
  const returnFocus = useRef(false);
  const enlargedNow = useRef(false);
  enlargedNow.current = enlarged !== null;
  const src = video.src !== null && video.src !== failed ? video.src : null;

  useEffect(() => {
    if (enlarged === null) return;
    onEnlargedChange(true);
    return () => onEnlargedChange(false);
  }, [enlarged !== null]);
  useEffect(() => {
    if (enlarged !== null || !returnFocus.current) return;
    returnFocus.current = false;
    enlargeRef.current?.focus();
  }, [enlarged]);
  useEffect(
    () => () => {
      if (enlargedNow.current) focusTitle();
    },
    [],
  );

  function syncSecond() {
    const whole = Math.floor(videoRef.current?.currentTime ?? 0);
    setSecond((prev) => (prev === whole ? prev : whole));
  }

  function enlarge() {
    const player = videoRef.current;
    const startAt = player?.currentTime ?? 0;
    player?.pause();
    setEnlarged({ startAt: Number.isFinite(startAt) ? startAt : 0, muted: player?.muted ?? true });
  }

  function closeEnlarged(left?: LightboxVideoState) {
    const player = videoRef.current;
    if (player && left !== undefined) {
      if (Number.isFinite(left.time)) player.currentTime = left.time;
      // Not a React prop after mount (`muted` is set once), so the element keeps what is set here.
      player.muted = left.muted;
      syncSecond();
    }
    if (left !== undefined) setLoop(left.loop);
    returnFocus.current = true;
    setEnlarged(null);
  }

  const time = formatVideoTime(second);
  return (
    <figure className={`min-w-0 ${stage ? "flex min-h-0 flex-1 flex-col" : ""}`}>
      {src === null ? (
        <span className={`flex aspect-[9/16] items-center justify-center rounded-lg border border-hairline bg-ground p-3 text-center text-xs text-fg-muted ${stage ? "max-h-full min-h-0 flex-1" : "max-h-[60vh] w-full"}`}>
          <span>
            Can't show: <span className="break-all font-mono">{video.path}</span>
          </span>
        </span>
      ) : (
        <video
          ref={videoRef}
          key={src}
          src={src}
          poster={video.poster ?? undefined}
          aria-label={label}
          muted
          playsInline
          preload="metadata"
          controls
          loop={loop}
          onTimeUpdate={syncSecond}
          onSeeked={syncSecond}
          onLoadedMetadata={syncSecond}
          onError={() => setFailed(src)}
          className={`aspect-[9/16] rounded-lg bg-black object-contain ${stage ? "mx-auto max-h-full min-h-0 flex-1" : "max-h-[60vh] w-full"}`}
        />
      )}
      <figcaption className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5">
        <span title={attachmentLabel(video)} className="min-w-0 flex-1 truncate font-mono text-[10px] text-fg-muted">
          {attachmentLabel(video)}
        </span>
        {src !== null && (
          <>
            <button type="button" aria-pressed={loop} aria-label={`Loop ${label}`} onClick={() => setLoop((on) => !on)} className={PLAYER_BUTTON}>
              Loop
            </button>
            <button ref={enlargeRef} type="button" aria-label={`Enlarge video: ${label}`} onClick={enlarge} className={PLAYER_BUTTON}>
              Enlarge
            </button>
            {onTimestamp !== undefined && (
              <button
                type="button"
                aria-label={`Note ${time} of ${label} in the message`}
                onClick={() => onTimestamp(timestampNote(videoRef.current?.currentTime ?? 0, optionId))}
                className={PLAYER_BUTTON}
              >
                Note {time}
              </button>
            )}
          </>
        )}
      </figcaption>
      {enlarged !== null && src !== null && (
        <Lightbox
          items={[{ kind: "video", name: video.name, path: video.path, src, poster: video.poster, muted: enlarged.muted, loop }]}
          index={0}
          onIndexChange={() => {}}
          startAt={enlarged.startAt}
          onClose={closeEnlarged}
        />
      )}
    </figure>
  );
}

/** Diagrams: each through MermaidBlock with its caption. On the stage a lone diagram is scaled to fit its share; several scroll together. */
function MermaidAttachments({ attachments, layout }: AttachmentRendererProps<"mermaid">) {
  if (attachments.length === 0) return null;
  const title = `Diagrams · ${attachments.length}`;
  const blocks = attachments.map((a, i) => <MermaidBlock key={i} source={a.source} caption={attachmentLabel(a)} />);
  if (layout === "stage") {
    const only = attachments.length === 1 ? attachments[0]! : null;
    return (
      <section aria-label={title} className={`flex flex-col ${STAGE_SHARE}`}>
        {only !== null ? (
          // A lone diagram is the stage's picture: no heading, its caption under it.
          <div className="min-h-0 flex-1 overflow-y-auto">
            <MermaidBlock source={only.source} caption={attachmentLabel(only)} fill />
          </div>
        ) : (
          <>
            <SectionTitle>{title}</SectionTitle>
            <div role="region" tabIndex={0} aria-label={title} className="min-h-0 flex-1 space-y-4 overflow-y-auto rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-accent">
              {blocks}
            </div>
          </>
        )}
      </section>
    );
  }
  return (
    <section>
      <SectionTitle>{title}</SectionTitle>
      <div className="space-y-4">{blocks}</div>
    </section>
  );
}

/** Diffs: clipped in the column; on the stage a lone diff fills its share, several scroll together unclipped. */
function DiffAttachments({ attachments, layout }: AttachmentRendererProps<"diff">) {
  if (attachments.length === 0) return null;
  const title = `Diffs · ${attachments.length}`;
  if (layout === "stage") {
    const only = attachments.length === 1 ? attachments[0]! : null;
    return (
      <section aria-label={title} className={`flex flex-col ${STAGE_SHARE}`}>
        <SectionTitle>{title}</SectionTitle>
        {only !== null ? (
          <div className="min-h-0 flex-1">
            <DiffBlock source={only.source} caption={attachmentLabel(only)} fill />
          </div>
        ) : (
          <div role="region" tabIndex={0} aria-label={title} className="min-h-0 flex-1 space-y-4 overflow-y-auto rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-accent">
            {attachments.map((a, i) => (
              <DiffBlock key={i} source={a.source} caption={attachmentLabel(a)} maxLines={Infinity} />
            ))}
          </div>
        )}
      </section>
    );
  }
  return (
    <section>
      <SectionTitle>{title}</SectionTitle>
      <div className="space-y-4">
        {attachments.map((a, i) => (
          <DiffBlock key={i} source={a.source} caption={attachmentLabel(a)} maxLines={COLUMN_DIFF_LINES} />
        ))}
      </div>
    </section>
  );
}

/**
 * Before/after pairs, each side by side under its Before and After labels
 * (with the caption beside the label). A paired screenshot enlarges in the
 * lightbox, which steps through every paired screenshot; focus comes back
 * as for the screenshots slot. On the stage the pairs take the larger share
 * and each image fits its half.
 */
function PairAttachments({
  pairs,
  layout,
  focusTitle,
  onOverlayChange,
  onTimestamp,
}: {
  pairs: AttachmentPair[];
  layout: AttachmentLayout;
  focusTitle: () => void;
  onOverlayChange: (open: boolean) => void;
  onTimestamp?: (note: string) => void;
}) {
  const [lightbox, setLightbox] = useState<number | null>(null);
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  const imageRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const returnFocusTo = useRef<number | null>(null);
  const stage = layout === "stage";
  const images: ImageAttachment[] = pairs
    .flatMap((p) => [p.before, p.after])
    .filter((a): a is ImageAttachment => a.kind === "image")
    .map((img) => (img.src !== null && failed.has(img.src) ? { ...img, src: null } : img));

  const onEnlargedChange = useSlotOverlay(onOverlayChange, lightbox !== null);

  useEffect(() => {
    if (lightbox === null || lightbox < images.length) return;
    returnFocusTo.current = images.length - 1;
    setLightbox(null);
  }, [lightbox, images.length]);
  useEffect(() => {
    if (lightbox !== null || returnFocusTo.current === null) return;
    const target = returnFocusTo.current >= 0 ? imageRefs.current[returnFocusTo.current] : null;
    returnFocusTo.current = null;
    if (target) target.focus();
    else focusTitle();
  }, [lightbox]);

  function closeLightbox() {
    returnFocusTo.current = lightbox;
    setLightbox(null);
  }

  const onError = (src: string) => setFailed((prev) => new Set(prev).add(src));
  const lightboxEl = lightbox !== null && lightbox < images.length && <Lightbox items={images} index={lightbox} onIndexChange={setLightbox} onClose={closeLightbox} />;
  if (pairs.length === 0) return <>{lightboxEl}</>;

  let imageIndex = 0;
  function side(a: ReviewAttachment, part: AttachmentPairPart): ReactNode {
    const label = pairLabel(part);
    let content: ReactNode;
    if (a.kind === "image") {
      const i = imageIndex++;
      const img = images[i]!;
      content = (
        <button
          ref={(el) => {
            imageRefs.current[i] = el;
          }}
          type="button"
          aria-label={`Enlarge ${label.toLowerCase()} screenshot: ${img.caption ?? img.name}`}
          onClick={() => setLightbox(i)}
          className={`block w-full overflow-hidden rounded-lg border border-hairline bg-ground focus:outline-none focus:ring-2 focus:ring-accent ${stage ? "min-h-0 flex-1" : ""}`}
        >
          {img.src === null ? (
            <span className="flex min-h-24 items-center justify-center p-3 text-center text-xs text-fg-muted">
              <span>
                Can't show: <span className="break-all font-mono">{img.path}</span>
              </span>
            </span>
          ) : (
            <img src={img.src} alt="" decoding="async" onError={() => onError(img.src!)} className={stage ? "h-full w-full object-contain" : "h-auto max-h-[40vh] w-full object-contain"} />
          )}
        </button>
      );
    } else if (a.kind === "video") {
      content = <ReviewVideo video={a} label={attachmentLabel(a) ?? a.name} stage={stage} focusTitle={focusTitle} onEnlargedChange={onEnlargedChange} onTimestamp={onTimestamp} />;
    } else if (a.kind === "mermaid") {
      content = stage ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <MermaidBlock source={a.source} fill />
        </div>
      ) : (
        <MermaidBlock source={a.source} />
      );
    } else {
      content = stage ? (
        <div className="min-h-0 flex-1">
          <DiffBlock source={a.source} fill />
        </div>
      ) : (
        <DiffBlock source={a.source} maxLines={COLUMN_DIFF_LINES} />
      );
    }
    return (
      <figure className={`min-w-0 ${stage ? "flex min-h-0 flex-col" : ""}`}>
        <figcaption className="mb-1.5 flex min-w-0 items-center gap-2">
          <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${part === "before" ? "bg-fg/10 text-fg-muted" : "bg-accent/20 text-accent"}`}>{label}</span>
          {a.caption !== undefined && (
            <span title={a.caption} className="truncate text-xs text-fg-muted">
              {a.caption}
            </span>
          )}
        </figcaption>
        {content}
      </figure>
    );
  }

  const title = pairs.length === 1 ? "Before / after" : `Before / after · ${pairs.length}`;
  return (
    <section aria-label={stage ? title : undefined} className={stage ? "flex min-h-0 min-w-0 flex-[3] flex-col gap-3" : undefined}>
      {!stage && <SectionTitle>{title}</SectionTitle>}
      <div className={stage ? "flex min-h-0 flex-1 flex-col gap-3" : "space-y-3"}>
        {pairs.map((p, i) => (
          <div key={i} className={`grid grid-cols-2 gap-3 ${stage ? "min-h-0 flex-1" : ""}`}>
            {side(p.before, "before")}
            {side(p.after, "after")}
          </div>
        ))}
      </div>
      {lightboxEl}
    </section>
  );
}
