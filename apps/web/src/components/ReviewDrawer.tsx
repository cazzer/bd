// The board's item drawer (board-visual-reviews, task 4.4; layout A + hero,
// picked at the 4.1 checkpoint): a 480 px panel over the right of the board,
// a full-screen sheet at phone width. Non-modal — the board stays usable
// beside it — so it is an <aside> named by its title, not a dialog; the
// title takes focus on mount and Escape inside the panel closes it (unless
// the message box holds a draft, or the lightbox is open and handles Escape
// itself).
//
// It reads one item (`boardItem`) by project and external id, and re-reads
// whenever the board re-reads (`boardVersion`) or a decision lands, keeping
// the previous answer on screen meanwhile. `{ item: null }` is the waiting
// state: the address can name a bead before its tracker has loaded, and the
// next board change re-reads it.
//
// For a review: summary, screenshots (the first full width as a hero, the
// rest a two-column grid; each enlarges in the lightbox), the comment
// thread, and — while the review is open — a pinned footer taking Accept or
// Request changes with a message (`reviewDecision`). A tracker failure
// keeps the message; a refusal (tRPC error) shows in an alert and keeps it
// too. A screenshot the server cannot serve shows as missing with its path,
// never hiding the rest. For any other item: its fields, its description,
// and a link to the graph.

import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { navigate } from "../lib/navigate.js";
import { canDecide, decisionBlocked, describeDecision, describeNotified, type DecisionOutcome, type ReviewDecisionKind } from "../lib/reviewDrawer.js";
import { formatRoute, type GraphRoute } from "../lib/route.js";
import { trpc } from "../trpc.js";
import { Lightbox, type LightboxImage } from "./Lightbox.js";

type BoardItem = NonNullable<Awaited<ReturnType<typeof trpc.boardItem.query>>["item"]>;

export interface ReviewDrawerProps {
  /** The item's project; null while it cannot be known yet (the drawer waits). */
  project: string | null;
  /** The addressed external id (a bead id). */
  item: string;
  /** False until the board's first read lands. */
  boardLoaded: boolean;
  /** Bumped by the board after every read; the drawer re-reads on it. */
  boardVersion: number;
  onClose: () => void;
}

function messageOf(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function ReviewDrawer({ project, item, boardLoaded, boardVersion, onClose }: ReviewDrawerProps) {
  const titleId = useId();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [answer, setAnswer] = useState<BoardItem | null | undefined>(undefined);
  const [readError, setReadError] = useState<string | null>(null);
  const [refetch, setRefetch] = useState(0);
  const [lightbox, setLightbox] = useState<number | null>(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  useEffect(() => {
    if (project === null) return;
    let cancelled = false;
    trpc.boardItem
      .query({ project, item })
      .then((res) => {
        if (cancelled) return;
        setAnswer(res.item);
        setReadError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setReadError(messageOf(err, "Failed to read this item."));
      });
    return () => {
      cancelled = true;
    };
  }, [project, item, boardVersion, refetch]);

  function onKeyDown(e: KeyboardEvent<HTMLElement>) {
    if (e.key !== "Escape" || e.defaultPrevented || lightbox !== null) return;
    const target = e.target as HTMLElement;
    if (target instanceof HTMLTextAreaElement && target.value.trim() !== "") return;
    e.preventDefault();
    onClose();
  }

  // What the drawer can show: the item, still loading, or waiting for a tracker to bring it in.
  const loaded = answer ?? null;
  const waiting = project === null ? boardLoaded : answer === null;
  const title = loaded ? loaded.title || "(untitled)" : waiting ? `Waiting for ${item}` : readError ? item : "Loading…";

  return (
    <aside
      aria-labelledby={titleId}
      onKeyDown={onKeyDown}
      className="glass fixed inset-0 z-40 flex flex-col overflow-hidden rounded-none border-0 bg-surface-strong sm:inset-auto sm:top-3 sm:right-3 sm:bottom-3 sm:w-[480px] sm:rounded-2xl sm:border"
    >
      <div className="border-b border-hairline p-4">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-fg-muted">
              <span className="font-mono">{loaded?.externalId ?? item}</span>
              {loaded?.parent && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>
                    child of <span className="font-mono">{loaded.parent.externalId}</span>
                  </span>
                </>
              )}
            </div>
            <h2 id={titleId} ref={titleRef} tabIndex={-1} className="mt-1 text-base font-semibold leading-snug text-fg focus:outline-none">
              {title}
            </h2>
            {loaded && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Chip tone={loaded.status === "closed" ? "muted" : "green"}>{loaded.status}</Chip>
                {loaded.isReview && <Chip tone="accent">review</Chip>}
                {loaded.labels.includes("review:changes") && <Chip tone="amber">review:changes</Chip>}
                <Chip>{loaded.project}</Chip>
              </div>
            )}
          </div>
          {loaded && <GraphLink nodeId={loaded.id} className="mt-1 shrink-0 whitespace-nowrap rounded text-sm text-accent hover:underline focus:outline-none focus:ring-2 focus:ring-accent" />}
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="grid size-11 shrink-0 place-items-center rounded-lg border border-hairline text-fg-muted hover:bg-surface-strong hover:text-fg focus:outline-none focus:ring-2 focus:ring-accent sm:size-9"
          >
            ✕
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
        {readError && (
          <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            {readError}
          </p>
        )}
        {!loaded && waiting && <p className="text-sm text-fg-muted">Waiting for {item}; it opens when its tracker loads.</p>}
        {loaded && (loaded.isReview ? <ReviewBody item={loaded} lightbox={lightbox} setLightbox={setLightbox} /> : <PlainBody item={loaded} />)}
      </div>

      {loaded && project !== null && loaded.isReview && (
        <DecisionFooter item={loaded} project={project} message={message} setMessage={setMessage} onWritten={() => setRefetch((n) => n + 1)} />
      )}
    </aside>
  );
}

function Chip({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "accent" | "green" | "amber" }) {
  const cls =
    tone === "accent"
      ? "border-accent/60 bg-accent/15 text-fg"
      : tone === "green"
        ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-300"
        : tone === "amber"
          ? "border-amber-400/50 bg-amber-400/10 text-amber-200"
          : "border-hairline text-fg-muted";
  return <span className={`rounded-full border px-2 py-0.5 text-[11px] ${cls}`}>{children}</span>;
}

function GraphLink({ nodeId, className, children = "Open in graph" }: { nodeId: string; className: string; children?: ReactNode }) {
  const route: GraphRoute = { view: "graph", q: null, types: [], node: nodeId };
  function open(e: MouseEvent<HTMLAnchorElement>) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(route, "push");
  }
  return (
    <a href={formatRoute(route)} onClick={open} className={className}>
      {children}
    </a>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">{children}</h3>;
}

function ReviewBody({ item, lightbox, setLightbox }: { item: BoardItem; lightbox: number | null; setLightbox: (i: number | null) => void }) {
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  const thumbRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const review = item.review;
  const invalid = review !== null && "invalid" in review;
  // The version query keeps a re-requested screenshot (same path, new bytes) from showing the old one.
  const images: LightboxImage[] = item.reviewImages.map((img) => {
    const src = img.url === null ? null : `${img.url}?v=${encodeURIComponent(item.updatedAt)}`;
    return { name: img.name, path: img.path, src: src !== null && failed.has(src) ? null : src };
  });

  // Focus returns to the thumbnail of the screenshot last shown, after the
  // lightbox has unmounted and lifted `inert` from the app root (an inert
  // element cannot take focus).
  const returnFocusTo = useRef<number | null>(null);
  useEffect(() => {
    if (lightbox !== null || returnFocusTo.current === null) return;
    thumbRefs.current[returnFocusTo.current]?.focus();
    returnFocusTo.current = null;
  }, [lightbox]);

  function closeLightbox() {
    returnFocusTo.current = lightbox;
    setLightbox(null);
  }

  return (
    <>
      {invalid && (
        <p role="note" className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-sm text-amber-200">
          This review's details are malformed in the tracker, so its summary and screenshots cannot be shown. The thread and the decision still work.
        </p>
      )}
      {review !== null && !("invalid" in review) && review.summary !== "" && (
        <section>
          <SectionTitle>Summary</SectionTitle>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-fg">{review.summary}</p>
        </section>
      )}
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
      <Thread comments={item.comments} />
      {item.status === "closed" && (
        <p className="rounded-lg border border-hairline px-3 py-2 text-sm text-fg">
          Closed{item.closedReason ? <>: {item.closedReason}</> : "."}
        </p>
      )}
      {lightbox !== null && <Lightbox images={images} index={lightbox} onIndexChange={setLightbox} onClose={closeLightbox} />}
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
  image: LightboxImage;
  index: number;
  hero: boolean;
  buttonRef: (el: HTMLButtonElement | null) => void;
  onOpen: () => void;
  onError: (src: string) => void;
}) {
  const caption = (
    <span className="block truncate border-t border-hairline px-2 py-1 font-mono text-[10px] text-fg-muted">
      {index + 1}. {image.name}
    </span>
  );
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
            Missing: <span className="break-all font-mono">{image.path}</span>
          </span>
        </span>
      ) : (
        <img
          src={image.src}
          alt=""
          onError={() => onError(image.src!)}
          className={`w-full transition-transform group-hover:scale-[1.02] ${hero ? "h-auto" : "aspect-[16/10] object-cover object-top"}`}
        />
      )}
      {caption}
    </button>
  );
}

function Thread({ comments }: { comments: BoardItem["comments"] }) {
  return (
    <section>
      <SectionTitle>Thread · {comments.length}</SectionTitle>
      {comments.length === 0 ? (
        <p className="text-sm text-fg-muted">No comments yet.</p>
      ) : (
        <ol className="space-y-2.5">
          {comments.map((c, i) => (
            <li key={`${i}:${c.id}`} className="rounded-lg border border-hairline bg-surface-strong px-3 py-2">
              <div className="flex items-baseline justify-between gap-2 text-[11px] text-fg-muted">
                <span className="font-medium text-fg">{c.author ?? "unknown"}</span>
                {c.created_at && <time dateTime={c.created_at}>{formatTime(c.created_at)}</time>}
              </div>
              <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed text-fg">{c.text}</p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function PlainBody({ item }: { item: BoardItem }) {
  return (
    <div className="space-y-5">
      <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2 text-sm">
        <dt className="text-fg-muted">Status</dt>
        <dd className="text-fg">
          {item.status}
          {item.status === "closed" && item.closedReason && <span className="text-fg-muted"> ({item.closedReason})</span>}
        </dd>
        <dt className="text-fg-muted">Priority</dt>
        <dd className="text-fg">P{item.priority}</dd>
        <dt className="text-fg-muted">Type</dt>
        <dd className="text-fg">{item.issueType ?? "—"}</dd>
        <dt className="text-fg-muted">Assignee</dt>
        <dd className="break-words text-fg">{item.assignee ?? "—"}</dd>
      </dl>
      <section>
        <SectionTitle>Description</SectionTitle>
        {item.content.trim() === "" ? (
          <p className="text-sm text-fg-muted">No description.</p>
        ) : (
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-fg">{item.content}</p>
        )}
      </section>
      <GraphLink nodeId={item.id} className="inline-block rounded-lg border border-hairline px-3 py-1.5 text-sm text-accent hover:bg-surface-strong focus:outline-none focus:ring-2 focus:ring-accent">
        Open in graph →
      </GraphLink>
    </div>
  );
}

function DecisionFooter({
  item,
  project,
  message,
  setMessage,
  onWritten,
}: {
  item: BoardItem;
  project: string;
  message: string;
  setMessage: (m: string) => void;
  onWritten: () => void;
}) {
  const messageId = useId();
  const hintId = useId();
  const [pending, setPending] = useState<ReviewDecisionKind | null>(null);
  const [outcome, setOutcome] = useState<(DecisionOutcome & { notified: string | null }) | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const open = canDecide(item);

  async function decide(decision: ReviewDecisionKind) {
    if (decisionBlocked(decision, message, pending !== null)) return;
    setPending(decision);
    setOutcome(null);
    setRefusal(null);
    try {
      const result = await trpc.reviewDecision.mutate({ project, item: item.externalId, decision, message });
      const described = describeDecision(result);
      setOutcome({ ...described, notified: describeNotified(result.notified) });
      if (!described.keepMessage) setMessage("");
      if (result.written.length > 0) onWritten();
    } catch (err) {
      setRefusal(messageOf(err, "The decision was refused."));
    } finally {
      setPending(null);
    }
  }

  // Mounted for every review so an outcome survives the item closing under it; draws nothing until there is something to show.
  if (!open && outcome === null && refusal === null) return null;
  const changesNeedMessage = message.trim() === "";
  const toneClass = outcome?.tone === "ok" ? "text-emerald-300" : outcome?.tone === "partial" ? "text-amber-200" : "text-red-300";

  return (
    <div className="space-y-2 border-t border-hairline bg-surface-strong p-4">
      {open && (
        <>
          <label htmlFor={messageId} className="sr-only">
            Message to the agent
          </label>
          <textarea
            id={messageId}
            rows={2}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            disabled={pending !== null}
            placeholder="Message to the agent (required to request changes)"
            className="block w-full resize-none rounded-lg border border-hairline bg-ground/60 px-3 py-2 text-sm text-fg placeholder:text-fg-muted/70 focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-60"
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void decide("accept")}
              disabled={decisionBlocked("accept", message, pending !== null)}
              className="min-h-11 rounded-lg bg-accent px-4 text-sm font-semibold text-ground hover:bg-accent/90 focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-ground disabled:opacity-60 sm:min-h-10"
            >
              {pending === "accept" ? "Accepting…" : "Accept"}
            </button>
            <button
              type="button"
              onClick={() => void decide("changes")}
              disabled={decisionBlocked("changes", message, pending !== null)}
              aria-describedby={changesNeedMessage ? hintId : undefined}
              className="min-h-11 rounded-lg border border-amber-400/50 bg-amber-400/10 px-4 text-sm font-medium text-amber-200 hover:bg-amber-400/20 focus:outline-none focus:ring-2 focus:ring-amber-400 disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-10"
            >
              {pending === "changes" ? "Sending…" : "Request changes"}
            </button>
            {changesNeedMessage && (
              <span id={hintId} className="text-xs text-fg-muted">
                A message is required to request changes
              </span>
            )}
          </div>
        </>
      )}
      <p role="status" className={`text-xs ${toneClass}`}>
        {outcome && (
          <>
            {outcome.text}
            {outcome.notified && <span className="block text-fg-muted">{outcome.notified}</span>}
          </>
        )}
      </p>
      {refusal && (
        <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {refusal}
        </p>
      )}
    </div>
  );
}
