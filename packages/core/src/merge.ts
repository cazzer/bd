import { sql } from "drizzle-orm";
import type { Database } from "@breakdown/db";
import { NodeNotFoundError, SelfMergeError } from "./errors.js";

export interface MergeResult {
  /** The ultimate canonical node id every merged node now points at. */
  survivorId: string;
  /**
   * Node ids whose `merged_into` this call actually changed — the loser,
   * plus any node that was already merged into the loser and got
   * repointed directly at `survivorId` (chain collapse). Empty when the
   * call was an idempotent no-op.
   */
  mergedNodeIds: string[];
}

type NodeMergeRow = {
  id: string;
  merged_into: string | null;
}

/**
 * Merges `loserId` into `survivorId`: `loserId` becomes a redirect to the
 * (ultimate) survivor, and any node previously pointing at `loserId` is
 * repointed directly at it too.
 *
 * This exists because `nodes_merged_into_canonical_trigger` (see the
 * migration) *rejects* setting `merged_into` on a node to a target that is
 * itself merged away — it enforces the one-hop invariant but does not fix
 * a chain for you. So this function does the collapsing itself, inside one
 * transaction, before ever touching `merged_into`:
 *
 *   1. Resolve `survivorId` to its ultimate canonical node — if the
 *      requested survivor is itself merged away, its own `merged_into`
 *      (guaranteed one-hop by the trigger) already names the canonical
 *      node, so merging into "the survivor" really means merging into
 *      that canonical node.
 *   2. Reject a self-merge, including the indirect form where the
 *      resolved canonical id turns out to equal `loserId` (i.e. the
 *      survivor was already, transitively, merged into the loser).
 *   3. If the loser is already merged into that same canonical node, this
 *      is a no-op — idempotent re-application succeeds and changes
 *      nothing.
 *   4. Otherwise, one UPDATE repoints every node with
 *      `id = loserId OR merged_into = loserId` directly at the canonical
 *      id. The `OR merged_into = loserId` half is the chain collapse: any
 *      node that was itself merged into the loser (the loser was a
 *      survivor of an earlier merge) gets repointed in the same
 *      statement, so nothing is ever left pointing at a now-non-canonical
 *      node — exactly the shape the trigger would otherwise reject one
 *      row at a time.
 *
 * `FOR UPDATE` on the initial lookup guards against a concurrent merge
 * racing on the same nodes; everything happens in one transaction so a
 * failure at any step leaves no partial redirect.
 */
export async function mergeNodes(db: Database, loserId: string, survivorId: string): Promise<MergeResult> {
  if (loserId === survivorId) {
    throw new SelfMergeError(loserId, survivorId);
  }

  return db.transaction(async (tx) => {
    const lookup = await tx.execute<NodeMergeRow>(sql`
      SELECT id, merged_into FROM nodes WHERE id = ${loserId} OR id = ${survivorId} FOR UPDATE
    `);

    const byId = new Map(lookup.rows.map((r) => [r.id, r.merged_into]));
    if (!byId.has(loserId)) {
      throw new NodeNotFoundError(loserId);
    }
    if (!byId.has(survivorId)) {
      throw new NodeNotFoundError(survivorId);
    }

    // The trigger guarantees this is at most one hop: survivorMergedInto,
    // if set, already points at a canonical node.
    const survivorMergedInto = byId.get(survivorId) ?? null;
    const canonicalId = survivorMergedInto ?? survivorId;

    if (canonicalId === loserId) {
      throw new SelfMergeError(loserId, survivorId, canonicalId);
    }

    const loserMergedInto = byId.get(loserId) ?? null;
    if (loserMergedInto === canonicalId) {
      // Already merged into the same (resolved) survivor: idempotent no-op.
      // Nothing else can currently point at loserId in this state — once
      // a node has a non-null merged_into, this same collapsing logic
      // guarantees no other row targets it — so there is nothing left to
      // repoint.
      return { survivorId: canonicalId, mergedNodeIds: [] };
    }

    const updated = await tx.execute<{ id: string }>(sql`
      UPDATE nodes
      SET merged_into = ${canonicalId}
      WHERE id = ${loserId} OR merged_into = ${loserId}
      RETURNING id
    `);

    return { survivorId: canonicalId, mergedNodeIds: updated.rows.map((r) => r.id) };
  });
}
