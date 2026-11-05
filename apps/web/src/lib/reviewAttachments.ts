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

export interface MermaidAttachment extends AttachmentParts {
  kind: "mermaid";
  source: string;
}

export interface DiffAttachment extends AttachmentParts {
  kind: "diff";
  source: string;
}

export type ReviewAttachment = ImageAttachment | MermaidAttachment | DiffAttachment;

export type ReviewAttachmentKind = ReviewAttachment["kind"];

/** A card attachment as `boardItem` serves it (server/dto.ts `ReviewCardAttachmentDto`). */
export type CardAttachmentInput =
  | { kind: "image"; path: string; name: string; url: string | null; caption?: string; pair?: AttachmentPairPart }
  | { kind: "mermaid" | "diff"; source: string; caption?: string; pair?: AttachmentPairPart };

/**
 * The attachments of a board item (`boardItem`'s answer), in the card's own
 * order. The version query keeps a re-requested screenshot (same path, new
 * bytes) from showing the old one.
 */
export function reviewAttachments(item: { updatedAt: string; card: { attachments: readonly CardAttachmentInput[] } | null }): ReviewAttachment[] {
  if (item.card === null) return [];
  return item.card.attachments.map((a): ReviewAttachment => {
    const parts: AttachmentParts = { ...(a.caption !== undefined ? { caption: a.caption } : {}), ...(a.pair !== undefined ? { pair: a.pair } : {}) };
    if (a.kind === "image") {
      return { kind: "image", name: a.name, path: a.path, src: a.url === null ? null : `${a.url}?v=${encodeURIComponent(item.updatedAt)}`, ...parts };
    }
    return { kind: a.kind, source: a.source, ...parts };
  });
}

/** The attachments of one kind, order kept. */
export function attachmentsOfKind<K extends ReviewAttachmentKind>(attachments: readonly ReviewAttachment[], kind: K): Array<Extract<ReviewAttachment, { kind: K }>> {
  return attachments.filter((a): a is Extract<ReviewAttachment, { kind: K }> => a.kind === kind);
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

/** What an attachment is called where it is listed: its caption, else (an image) its file name, behind its Before/After label when it has one. */
export function attachmentLabel(a: ReviewAttachment): string | undefined {
  const own = a.caption ?? (a.kind === "image" ? a.name : undefined);
  if (a.pair === undefined) return own;
  return own === undefined ? pairLabel(a.pair) : `${pairLabel(a.pair)}: ${own}`;
}
