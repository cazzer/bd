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

import { isEditableSourceSystem, type LookedUpNode, type Neighbor, type RecentNode, type RetrievedNode } from "@breakdown/core";

export type RetrievedNodeDto = Omit<RetrievedNode, "updatedAt"> & { updatedAt: string; isEditable: boolean };
export type LookedUpNodeDto = Omit<LookedUpNode, "createdAt" | "updatedAt"> & { createdAt: string; updatedAt: string; isEditable: boolean };
export type RecentNodeDto = Omit<RecentNode, "updatedAt"> & { updatedAt: string; isEditable: boolean };
export type NeighborDto = Neighbor & { isEditable: boolean };

export function toRetrievedNodeDto(node: RetrievedNode): RetrievedNodeDto {
  return { ...node, updatedAt: node.updatedAt.toISOString(), isEditable: isEditableSourceSystem(node.sourceSystem) };
}

export function toLookedUpNodeDto(node: LookedUpNode): LookedUpNodeDto {
  return { ...node, createdAt: node.createdAt.toISOString(), updatedAt: node.updatedAt.toISOString(), isEditable: isEditableSourceSystem(node.sourceSystem) };
}

export function toRecentNodeDto(node: RecentNode): RecentNodeDto {
  return { ...node, updatedAt: node.updatedAt.toISOString(), isEditable: isEditableSourceSystem(node.sourceSystem) };
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
