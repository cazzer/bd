// What a review shows beside its summary and thread, as a list of
// attachments keyed by kind (review-queue, design.md decision 6). The
// review panel renders the list through one slot that maps each kind to
// its renderer (components/ReviewAttachments.tsx), so the follow-on bd-4zn
// (diagrams, ERDs, before/recommendation parts) adds a kind here and a
// renderer there without reshaping the drawer, the run-through modal, or
// their props. Images are the only kind today. Structural types only, so
// nothing from the server reaches the bundle.

export interface ImageAttachment {
  kind: "image";
  name: string;
  path: string;
  /** Null when the server cannot serve it; shown as unavailable with its path. */
  src: string | null;
}

export type ReviewAttachment = ImageAttachment;

export type ReviewAttachmentKind = ReviewAttachment["kind"];

/**
 * The attachments of a board item (`boardItem`'s answer), in the review's
 * own order. The version query keeps a re-requested screenshot (same path,
 * new bytes) from showing the old one.
 */
export function reviewAttachments(item: { updatedAt: string; reviewImages: ReadonlyArray<{ name: string; path: string; url: string | null }> }): ReviewAttachment[] {
  return item.reviewImages.map((img) => ({
    kind: "image",
    name: img.name,
    path: img.path,
    src: img.url === null ? null : `${img.url}?v=${encodeURIComponent(item.updatedAt)}`,
  }));
}

/** The attachments of one kind, order kept. */
export function attachmentsOfKind<K extends ReviewAttachmentKind>(attachments: readonly ReviewAttachment[], kind: K): Array<Extract<ReviewAttachment, { kind: K }>> {
  return attachments.filter((a): a is Extract<ReviewAttachment, { kind: K }> => a.kind === kind);
}
