import { sql } from "drizzle-orm";
import type { Database } from "@breakdown/db";
import { HangarSessionMergeError, MergeFailedError, NodeNotFoundError, SelfMergeError } from "./errors.js";
import { HANGAR_SESSION_NODE_TYPE, HANGAR_SOURCE_SYSTEM } from "./hangar.js";
import type { IngestRunHandle } from "./ingest-runs.js";
import { asPgError, formatPgInfo } from "./sql-helpers.js";

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
  hangar: boolean;
}

/** Postgres SQLSTATE for a detected deadlock. */
const DEADLOCK_DETECTED = "40P01";

/** How many times to retry the merge transaction after a deadlock before giving up. */
const MAX_DEADLOCK_RETRIES = 3;

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
 *   4. Otherwise, explicitly lock the exact set of rows about to change —
 *      the loser, plus every node currently pointing at it — before
 *      repointing them all in one UPDATE. The `OR merged_into = loserId`
 *      half of both the lock and the UPDATE is the chain collapse: any
 *      node that was itself merged into the loser (the loser was a
 *      survivor of an earlier merge) gets repointed in the same
 *      statement, so nothing is ever left pointing at a now-non-canonical
 *      node — exactly the shape the trigger would otherwise reject one
 *      row at a time.
 *
 * A hangar session (node_type `hangar_session` or source system `hangar`)
 * is never merged, as loser, as requested survivor, as the survivor that
 * resolves, or as a chain member the merge would repoint: the refusal
 * (`HangarSessionMergeError`) comes before any write. This UPDATE is the
 * only statement in the codebase that sets `merged_into`, so the refusal
 * alone keeps every session canonical — and with it, its session token's
 * binding and its inbox items' `session` (hangar-queue, security review).
 *
 * Every step above runs inside one transaction, so a failure at any point
 * leaves no partial redirect. A genuine database failure (not one of the
 * `NodeNotFoundError`/`SelfMergeError` validation errors above, which are
 * never worth retrying) gets one automatic retry loop for a detected
 * deadlock (Postgres `40P01` — two concurrent merges can legitimately lock
 * rows in different orders and deadlock; retrying is the correct response,
 * not surfacing it), and otherwise is wrapped as `MergeFailedError` so
 * every error this function can throw is a `KnowledgeStoreError` a caller
 * can catch by type, never a raw driver error.
 *
 * `run` is required, not optional: a merge is a write like any other
 * (knowledge-store spec, "Writes are attributable to an ingest run"), and
 * the UPDATE stamps `ingest_run_id = run.id` on every row it repoints —
 * the loser and any chain members — in the same statement that sets
 * `merged_into`. The history trigger (migrations/0002_*.sql) attributes
 * the revision it records to `NEW.ingest_run_id`; without the stamp, a
 * merge's revision would name whichever run last happened to write the
 * node, not the run that merged it. The idempotent no-op path writes
 * nothing and so stamps nothing. `updated_at` is not bumped by a merge
 * (unchanged from before; out of scope here).
 */
export async function mergeNodes(db: Database, loserId: string, survivorId: string, run: IngestRunHandle): Promise<MergeResult> {
  if (loserId === survivorId) {
    throw new SelfMergeError(loserId, survivorId);
  }

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await runMergeTransaction(db, loserId, survivorId, run);
    } catch (err) {
      if (err instanceof NodeNotFoundError || err instanceof SelfMergeError || err instanceof HangarSessionMergeError) {
        throw err;
      }
      const pg = asPgError(err);
      if (pg?.code === DEADLOCK_DETECTED && attempt <= MAX_DEADLOCK_RETRIES) {
        continue;
      }
      throw new MergeFailedError(
        `failed to merge node ${loserId} into ${survivorId}${formatPgInfo(pg)}`,
        loserId,
        survivorId,
        { cause: err },
      );
    }
  }
}

const IS_HANGAR = sql`(node_type = ${HANGAR_SESSION_NODE_TYPE} OR source_system = ${HANGAR_SOURCE_SYSTEM})`;

async function runMergeTransaction(db: Database, loserId: string, survivorId: string, run: IngestRunHandle): Promise<MergeResult> {
  return db.transaction(async (tx) => {
    const lookup = await tx.execute<NodeMergeRow>(sql`
      SELECT id, merged_into, ${IS_HANGAR} AS hangar FROM nodes WHERE id = ${loserId} OR id = ${survivorId} FOR UPDATE
    `);
    for (const id of [loserId, survivorId]) {
      if (lookup.rows.some((r) => r.id === id && r.hangar)) throw new HangarSessionMergeError(loserId, survivorId, id);
    }

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

    // Lock the exact set of rows this merge is about to modify — the
    // loser, plus every node currently pointing at it (the chain members
    // a chain collapse must repoint) — before the UPDATE touches any of
    // them. This is what actually prevents a concurrent merge from racing
    // on the same rows; it is not an incidental side effect of the
    // foreign key on merged_into (that FK protects referential integrity,
    // not this operation's atomicity, and would silently stop providing
    // it if the FK were ever relaxed). The resolved survivor is locked and
    // checked with them: none of these rows may be a hangar session.
    const affected = await tx.execute<{ id: string; hangar: boolean }>(sql`
      SELECT id, ${IS_HANGAR} AS hangar FROM nodes WHERE id = ${loserId} OR merged_into = ${loserId} OR id = ${canonicalId} FOR UPDATE
    `);
    const session = affected.rows.find((r) => r.hangar);
    if (session) throw new HangarSessionMergeError(loserId, survivorId, session.id);

    // ingest_run_id is stamped in the same statement as merged_into so the
    // history trigger's revision names this run — see the doc comment on
    // mergeNodes. Chain members are stamped too: this merge changed them.
    const updated = await tx.execute<{ id: string }>(sql`
      UPDATE nodes
      SET merged_into = ${canonicalId}, ingest_run_id = ${run.id}
      WHERE id = ${loserId} OR merged_into = ${loserId}
      RETURNING id
    `);

    return { survivorId: canonicalId, mergedNodeIds: updated.rows.map((r) => r.id) };
  });
}
