// What a review shows beside its question and thread, as a list of
// attachments keyed by kind (review-queue, design.md decision 6). The
// review panel renders the list through one slot that maps each kind to
// its renderer (components/ReviewAttachments.tsx), so a new kind is an
// entry here and a renderer there without reshaping the drawer, the
// run-through modal, or their props. The list is the card's
// (decision-card-reviews, design.md decision 1): `boardItem` serves core's
// `reviewCard`, whose attachments are a legacy review's images when it has
// no card. Before/after is not a kind: it is a `pair` on any attachment,
// and a `before` immediately followed by an `after` is shown as one
// side-by-side pair (`pairAttachments`), whatever their kinds. Structural
// types only, so nothing from the server reaches the bundle.
//
// Videos (video-review-attachments, design.md decisions 6 and 8). A video
// may name a card option (`option`); `optionVideos` takes those out, in the
// card's option order, for the side-by-side cuts slot. A timestamped note is
// plain text (`timestampNote`), appended on a new line of the message
// (`appendNote`).

export type AttachmentPairPart = "before" | "after";

interface AttachmentParts {
  caption?: string;
  pair?: AttachmentPairPart;
}

export interface ImageAttachment extends AttachmentParts {
  kind: "image";
  name: string;
  path: string;
  /** Null when the server cannot serve it; shown as unavailable with its path. */
  src: string | null;
}

export interface VideoAttachment extends AttachmentParts {
  kind: "video";
  name: string;
  path: string;
  /** Null when the server cannot serve it; shown as unavailable with its path. */
  src: string | null;
  /** The poster image's URL, or null without one (or when it cannot be served). */
  poster: string | null;
  /** The id of the card option this video is the cut of. */
  option?: string;
}

export interface MermaidAttachment extends AttachmentParts {
  kind: "mermaid";
  source: string;
}

export interface DiffAttachment extends AttachmentParts {
  kind: "diff";
  source: string;
}

export type ReviewAttachment = ImageAttachment | VideoAttachment | MermaidAttachment | DiffAttachment;

export type ReviewAttachmentKind = ReviewAttachment["kind"];

/** A card attachment as `boardItem` serves it (server/dto.ts `ReviewCardAttachmentDto`). */
export type CardAttachmentInput =
  | { kind: "image"; path: string; name: string; url: string | null; caption?: string; pair?: AttachmentPairPart }
  | {
      kind: "video";
      path: string;
      name: string;
      url: string | null;
      posterUrl: string | null;
      caption?: string;
      pair?: AttachmentPairPart;
      option?: string;
    }
  | { kind: "mermaid" | "diff"; source: string; caption?: string; pair?: AttachmentPairPart };

/**
 * The attachments of a board item (`boardItem`'s answer), in the card's own
 * order. The version query keeps a re-requested screenshot or video (same
 * path, new bytes) from showing the old one.
 */
export function reviewAttachments(item: { updatedAt: string; card: { attachments: readonly CardAttachmentInput[] } | null }): ReviewAttachment[] {
  if (item.card === null) return [];
  return item.card.attachments.map((a): ReviewAttachment => {
    const parts: AttachmentParts = { ...(a.caption !== undefined ? { caption: a.caption } : {}), ...(a.pair !== undefined ? { pair: a.pair } : {}) };
    const versioned = (url: string | null) => (url === null ? null : `${url}?v=${encodeURIComponent(item.updatedAt)}`);
    if (a.kind === "image") {
      return { kind: "image", name: a.name, path: a.path, src: versioned(a.url), ...parts };
    }
    if (a.kind === "video") {
      return {
        kind: "video",
        name: a.name,
        path: a.path,
        src: versioned(a.url),
        poster: versioned(a.posterUrl),
        ...(a.option !== undefined ? { option: a.option } : {}),
        ...parts,
      };
    }
    return { kind: a.kind, source: a.source, ...parts };
  });
}

/** The attachments of one kind, order kept. */
export function attachmentsOfKind<K extends ReviewAttachmentKind>(attachments: readonly ReviewAttachment[], kind: K): Array<Extract<ReviewAttachment, { kind: K }>> {
  return attachments.filter((a): a is Extract<ReviewAttachment, { kind: K }> => a.kind === kind);
}

/**
 * Splits out the videos that name an option, in the card's option order
 * (`optionIds`), from the rest, whose order is kept. A video naming an id
 * the card does not offer stays in the rest (the server's contract refuses
 * one; this never hides an attachment).
 */
export function optionVideos(
  attachments: readonly ReviewAttachment[],
  optionIds: readonly string[],
): { byOption: Array<{ optionId: string; video: VideoAttachment }>; rest: ReviewAttachment[] } {
  const byOption: Array<{ optionId: string; video: VideoAttachment }> = [];
  const taken = new Set<ReviewAttachment>();
  for (const optionId of optionIds) {
    const video = attachments.find((a): a is VideoAttachment => a.kind === "video" && a.option === optionId && !taken.has(a));
    if (video === undefined) continue;
    byOption.push({ optionId, video });
    taken.add(video);
  }
  return { byOption, rest: attachments.filter((a) => !taken.has(a)) };
}

/** A player time as `m:ss`, or `h:mm:ss` from an hour; whole seconds, rounded down; `0:00` for NaN or a negative. */
export function formatVideoTime(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** What a Note press puts in the message: the time, behind the option id for an option's cut, and a space to type after. */
export function timestampNote(seconds: number, optionId?: string): string {
  const time = formatVideoTime(seconds);
  return optionId === undefined ? `${time} ` : `${optionId} ${time} `;
}

/** `note` on a new line of `message` (or as the whole message when it is empty). */
export function appendNote(message: string, note: string): string {
  if (message === "") return note;
  return message.endsWith("\n") ? `${message}${note}` : `${message}\n${note}`;
}

export interface AttachmentPair {
  before: ReviewAttachment;
  after: ReviewAttachment;
}

/**
 * Splits the list into side-by-side pairs — a `before` immediately followed
 * by an `after` — and the rest, order kept in both. A `before` with no
 * `after` right behind it, or an `after` with no `before` right ahead of it,
 * stays in the rest and is shown with its kind (labelled, see `pairLabel`).
 */
export function pairAttachments(attachments: readonly ReviewAttachment[]): { pairs: AttachmentPair[]; rest: ReviewAttachment[] } {
  const pairs: AttachmentPair[] = [];
  const rest: ReviewAttachment[] = [];
  for (let i = 0; i < attachments.length; i++) {
    const a = attachments[i]!;
    const next = attachments[i + 1];
    if (a.pair === "before" && next?.pair === "after") {
      pairs.push({ before: a, after: next });
      i++;
    } else {
      rest.push(a);
    }
  }
  return { pairs, rest };
}

export function pairLabel(part: AttachmentPairPart): string {
  return part === "before" ? "Before" : "After";
}

/** What an attachment is called where it is listed: its caption, else (an image or video) its file name, behind its Before/After label when it has one. */
export function attachmentLabel(a: ReviewAttachment): string | undefined {
  const own = a.caption ?? (a.kind === "image" || a.kind === "video" ? a.name : undefined);
  if (a.pair === undefined) return own;
  return own === undefined ? pairLabel(a.pair) : `${pairLabel(a.pair)}: ${own}`;
}
