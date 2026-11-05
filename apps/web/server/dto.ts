// Wire-safe DTOs (bd-hmd.3).
//
// A few `@breakdown/core` result types carry `Date` objects
// (`RetrievedNode.updatedAt`, `LookedUpNode.createdAt`/`.updatedAt`,
// `RecentNode.updatedAt`). This server has no data transformer (no
// superjson — kept off the dependency list deliberately: this ticket's
// wire surface is small enough that hand-converting the handful of
// `Date` fields below is simpler than a new dependency every procedure
// would otherwise need to opt into). Serialized as plain JSON, a `Date`
// degrades to whatever `JSON.stringify` calls `.toJSON()` for — an ISO
// string — while a procedure's *inferred* return type would still say
// `Date` if left alone. That mismatch would make the client's inferred
// type lie about what actually arrives over the wire.
//
// The functions below convert every such field to `string` before a
// procedure returns it, so the inferred type the client sees always
// matches what is actually on the wire.
//
// They also attach `isEditable` (`isEditableSourceSystem(sourceSystem)`)
// to every node DTO — the one call site for that predicate. The ticket
// asks to "expose isEditableSourceSystem to the client rather than
// re-deriving 'is this editable' in the UI"; the client cannot *import*
// it directly, though: `@breakdown/core`'s barrel unconditionally
// re-exports `human-writes.ts`, which imports `@breakdown/db`, which
// imports `pg` at module scope (a Node-only driver with no browser
// build) — any static import from the barrel, even for this one
// dependency-free predicate, would pull `pg` into the Vite client
// bundle. Calling it here, once, server-side, and shipping the boolean
// keeps "one predicate, one place" (the UI still never re-derives
// `sourceSystem === "repo"` itself) without that bundling hazard.

import path from "node:path";
import {
  isEditableSourceSystem,
  REVIEW_IMAGE_ROOT,
  reviewCard,
  type BeadsProject,
  type BoardCard,
  type BoardItem,
  type ListedNode,
  type LookedUpNode,
  type Neighbor,
  type PendingReview,
  type RecentNode,
  type RetrievedNode,
  type ReviewCard,
  type ReviewImageAttachment,
  type ReviewMetadata,
  type ReviewSourceAttachment,
} from "@breakdown/core";
import { reviewImageUrl } from "./review-images.js";

export type RetrievedNodeDto = Omit<RetrievedNode, "updatedAt"> & { updatedAt: string; isEditable: boolean };
export type LookedUpNodeDto = Omit<LookedUpNode, "createdAt" | "updatedAt"> & { createdAt: string; updatedAt: string; isEditable: boolean };
export type RecentNodeDto = Omit<RecentNode, "updatedAt"> & { updatedAt: string; isEditable: boolean };
export type NeighborDto = Neighbor & { isEditable: boolean };
/** node-views: a `list` row. Keeps core's per-row `cursor` — routers/read.ts's `list` needs the LAST KEPT row's cursor after the response budget has trimmed the page, and strips it from the wire shape itself. */
export type ListedNodeDto = Omit<ListedNode, "createdAt" | "updatedAt"> & { createdAt: string; updatedAt: string; isEditable: boolean };

export function toRetrievedNodeDto(node: RetrievedNode): RetrievedNodeDto {
  return { ...node, updatedAt: node.updatedAt.toISOString(), isEditable: isEditableSourceSystem(node.sourceSystem) };
}

export function toLookedUpNodeDto(node: LookedUpNode): LookedUpNodeDto {
  return { ...node, createdAt: node.createdAt.toISOString(), updatedAt: node.updatedAt.toISOString(), isEditable: isEditableSourceSystem(node.sourceSystem) };
}

export function toRecentNodeDto(node: RecentNode): RecentNodeDto {
  return { ...node, updatedAt: node.updatedAt.toISOString(), isEditable: isEditableSourceSystem(node.sourceSystem) };
}

export function toListedNodeDto(node: ListedNode): ListedNodeDto {
  return { ...node, createdAt: node.createdAt.toISOString(), updatedAt: node.updatedAt.toISOString(), isEditable: isEditableSourceSystem(node.sourceSystem) };
}

/**
 * `isEditable` here reflects the *neighboring* node's own source system
 * (`nodeSourceSystem`) — not `edgeSourceSystem`, which is who asserted
 * the relationship, a different question (bd-hmd.3 review: bd-hmd.4
 * calls `getNeighbors` to render a node's surroundings and needs this
 * the same way every other read path already gets it, or it either
 * re-derives `sourceSystem === 'repo'` client-side — breaking the
 * one-predicate rule — or makes a redundant `getNodes` call for a
 * boolean).
 */
export function toNeighborDto(neighbor: Neighbor): NeighborDto {
  return { ...neighbor, isEditable: isEditableSourceSystem(neighbor.nodeSourceSystem) };
}

// Board DTOs (live-beads-board): the `Date`s the board read carries, as ISO strings.

export type BoardCardDto = Omit<BoardCard, "updatedAt"> & { updatedAt: string };
export type BeadsProjectDto = Omit<BeadsProject, "updatedAt"> & { updatedAt: string };
/**
 * One review screenshot as the drawer shows it: the stored absolute `path`,
 * its file `name`, and the image route's `url` for it — null when the path
 * is outside the review image root, so the drawer shows it missing without
 * a request (board-visual-reviews, design.md decision 4).
 */
export interface ReviewImageDto {
  path: string;
  name: string;
  url: string | null;
}
/**
 * A review as the drawer reads it (decision-card-reviews, design.md decision
 * 1): core's `reviewCard`, computed here because the client cannot import
 * core (header), and so the question the drawer shows — and sends back as
 * `seen` with an option — is byte-for-byte the one the decision check
 * compares. Each image attachment carries its `name` and route `url`, as
 * `reviewImages` does. `legacy` says the review carries no card key at all
 * (`images` and `summary` only, as filed before cards), which the drawer
 * shows as it always has; it is decided here so the client never copies
 * the contract's key list.
 */
export type ReviewCardAttachmentDto = (ReviewImageAttachment & { name: string; url: string | null }) | ReviewSourceAttachment;
export type ReviewCardDto = Omit<ReviewCard, "attachments"> & { attachments: ReviewCardAttachmentDto[]; legacy: boolean };

/** The card keys of the review contract (reviews.ts), checked against its type. */
const CARD_KEYS = ["question", "options", "recommend", "on_accept", "attachments"] as const satisfies ReadonlyArray<keyof ReviewMetadata>;

/**
 * `reviewImages` is empty and `card` null unless the item carries a valid
 * review. `reviewImages` predates `card` and is kept for a board tab opened
 * before cards existed, whose client still reads it.
 */
export type BoardItemDto = Omit<BoardItem, "updatedAt"> & { updatedAt: string; reviewImages: ReviewImageDto[]; card: ReviewCardDto | null };

export function toBoardCardDto(card: BoardCard): BoardCardDto {
  return { ...card, updatedAt: card.updatedAt.toISOString() };
}

export function toBoardItemDto(item: BoardItem, reviewImageRoot: string = REVIEW_IMAGE_ROOT): BoardItemDto {
  const review = item.review !== null && !("invalid" in item.review) ? item.review : null;
  const card = review === null ? null : reviewCard(review);
  return {
    ...item,
    updatedAt: item.updatedAt.toISOString(),
    reviewImages: (review?.images ?? []).map((p) => ({ path: p, name: path.basename(p), url: reviewImageUrl(p, reviewImageRoot) })),
    card:
      card === null
        ? null
        : {
            ...card,
            attachments: card.attachments.map((a) => (a.kind === "image" ? { ...a, name: path.basename(a.path), url: reviewImageUrl(a.path, reviewImageRoot) } : a)),
            legacy: CARD_KEYS.every((key) => review![key] === undefined),
          },
  };
}

export function toBeadsProjectDto(project: BeadsProject): BeadsProjectDto {
  return { ...project, updatedAt: project.updatedAt.toISOString() };
}

// Review queue DTO (review-queue): a pending review's request time as an ISO string.

export type PendingReviewDto = Omit<PendingReview, "requestedAt"> & { requestedAt: string };

export function toPendingReviewDto(review: PendingReview): PendingReviewDto {
  return { ...review, requestedAt: review.requestedAt.toISOString() };
}
