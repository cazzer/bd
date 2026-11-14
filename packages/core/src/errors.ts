/**
 * Error types for the knowledge-store write path (bd-vt2.3).
 *
 * Every error here is thrown either (a) by boundary validation, before
 * any SQL runs, or (b) as a wrapper around a genuine database failure
 * that survived validation. Both cases carry enough structured detail —
 * the offending row's identity, not just a Postgres constraint name — for
 * a calling agent to know what to fix and retry, per the knowledge-store
 * spec's "Partial failure in a batch" and "Weight out of range"
 * scenarios.
 */

/** Base class for every error `@breakdown/core` throws. */
export abstract class KnowledgeStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = this.constructor.name;
  }
}

// --- Ingest runs -----------------------------------------------------

export class InvalidIngestRunError extends KnowledgeStoreError {}

// --- Nodes -------------------------------------------------------------

/** A node in the batch failed basic shape validation (empty required field). */
export class InvalidNodeInputError extends KnowledgeStoreError {
  constructor(
    message: string,
    readonly index: number,
    readonly sourceSystem: string,
    readonly externalId: string,
  ) {
    super(
      `invalid node at batch index ${index} (source_system=${JSON.stringify(sourceSystem)}, external_id=${JSON.stringify(externalId)}): ${message}`,
    );
  }
}

/**
 * A node's content exceeds the configured maximum length (see
 * `DEFAULT_MAX_CONTENT_LENGTH` / `UpsertNodesOptions.maxContentLength`).
 * Deliberately not a database CHECK constraint — see nodes.ts.
 */
export class ContentTooLargeError extends KnowledgeStoreError {
  constructor(
    readonly index: number,
    readonly sourceSystem: string,
    readonly externalId: string,
    readonly length: number,
    readonly maxLength: number,
  ) {
    super(
      `node ${sourceSystem}/${externalId} (batch index ${index}) has content of length ${length}, ` +
        `which exceeds the maximum of ${maxLength} (see UpsertNodesOptions.maxContentLength)`,
    );
  }
}

/**
 * A node's `title` exceeds the configured maximum length (see
 * `DEFAULT_MAX_TITLE_LENGTH` / `UpsertNodesOptions.maxTitleLength`).
 * Same treatment and same reason as `ContentTooLargeError` — deliberately
 * not a database CHECK constraint (see nodes.ts) — but a distinct error
 * because `title`, unlike `content`, is returned in full by every read
 * path that lists nodes (search results, `getStoreSummary`'s
 * `recentNodes`), not just single-node lookups: before this existed, an
 * unbounded title inflated every one of those list responses, not just
 * the one node that carried it (bd-hmd.3 review).
 */
export class TitleTooLargeError extends KnowledgeStoreError {
  constructor(
    readonly index: number,
    readonly sourceSystem: string,
    readonly externalId: string,
    readonly length: number,
    readonly maxLength: number,
  ) {
    super(
      `node ${sourceSystem}/${externalId} (batch index ${index}) has a title of length ${length}, ` +
        `which exceeds the maximum of ${maxLength} (see UpsertNodesOptions.maxTitleLength)`,
    );
  }
}

/**
 * A node's `metadata` serializes to more than the configured maximum
 * length (see `DEFAULT_MAX_METADATA_LENGTH` /
 * `UpsertNodesOptions.maxMetadataLength`). `metadata` is meant for small
 * structured key/value data, not document content — nothing else in the
 * write path bounds it, so an oversized value would otherwise write
 * successfully and then reappear whole in every `brain_get` response that
 * returns it (bd-vt2.5 review: a 5MB metadata value round-tripped through
 * `brain_get` at ~200x the MCP response budget). Same treatment as
 * `ContentTooLargeError`: rejected before the batch reaches the database,
 * naming the offending row.
 */
export class MetadataTooLargeError extends KnowledgeStoreError {
  constructor(
    readonly index: number,
    readonly sourceSystem: string,
    readonly externalId: string,
    readonly length: number,
    readonly maxLength: number,
  ) {
    super(
      `node ${sourceSystem}/${externalId} (batch index ${index}) has metadata that serializes to ${length} characters, ` +
        `which exceeds the maximum of ${maxLength} (see UpsertNodesOptions.maxMetadataLength)`,
    );
  }
}

/**
 * A node's `title` or `content` contains a NUL byte or other C0 control
 * character (other than tab/newline/carriage return). Postgres `text`
 * columns cannot store a literal NUL at all, and other control bytes are
 * never legitimate prose — this is almost always mis-decoded or
 * binary-contaminated scraped content. Rejected before the batch reaches
 * the database, same treatment as `ContentTooLargeError`, so the error
 * names the row instead of surfacing only a chunk's index range.
 */
export class InvalidNodeContentError extends KnowledgeStoreError {
  constructor(
    readonly index: number,
    readonly sourceSystem: string,
    readonly externalId: string,
    readonly field: "title" | "content",
    readonly charPosition: number,
    readonly codePoint: number,
  ) {
    super(
      `node ${sourceSystem}/${externalId} (batch index ${index}) has a disallowed control character ` +
        `(U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}) in ${field} at position ${charPosition}`,
    );
  }
}

/** Two rows in the same batch share the (source_system, external_id) dedup key. */
export class DuplicateNodeInBatchError extends KnowledgeStoreError {
  constructor(
    readonly sourceSystem: string,
    readonly externalId: string,
    readonly firstIndex: number,
    readonly duplicateIndex: number,
  ) {
    super(
      `duplicate node (source_system=${sourceSystem}, external_id=${externalId}) in the same batch: ` +
        `batch indexes ${firstIndex} and ${duplicateIndex}`,
    );
  }
}

/** A node batch's chunked upsert failed at the database. Wraps the original error as `cause`. */
export class NodeUpsertFailedError extends KnowledgeStoreError {
  constructor(
    message: string,
    readonly chunkStartIndex: number,
    readonly chunkEndIndex: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

// --- Edges ---------------------------------------------------------------

/** An edge in the batch failed basic shape validation (empty field, malformed uuid). */
export class InvalidEdgeInputError extends KnowledgeStoreError {
  constructor(
    message: string,
    readonly index: number,
    readonly srcId: string,
    readonly dstId: string,
    readonly edgeType: string,
    readonly sourceSystem: string,
  ) {
    super(
      `invalid edge at batch index ${index} (${srcId} -[${edgeType}]-> ${dstId}, source_system=${sourceSystem}): ${message}`,
    );
  }
}

/**
 * An edge's weight is outside [0, 1]. Rejected before the batch reaches
 * the database — see upsertEdges in edges.ts — so the error can name the
 * offending edge instead of surfacing only `edges_weight_range_check`.
 */
export class InvalidEdgeWeightError extends KnowledgeStoreError {
  constructor(
    readonly index: number,
    readonly srcId: string,
    readonly dstId: string,
    readonly edgeType: string,
    readonly sourceSystem: string,
    readonly weight: number,
  ) {
    super(
      `edge ${srcId} -[${edgeType}]-> ${dstId} (source_system=${sourceSystem}, batch index ${index}) ` +
        `has weight ${weight}, which is outside the allowed range [0, 1]`,
    );
  }
}

/** Two rows in the same batch share the (src_id, dst_id, edge_type, source_system) dedup key. */
export class DuplicateEdgeInBatchError extends KnowledgeStoreError {
  constructor(
    readonly srcId: string,
    readonly dstId: string,
    readonly edgeType: string,
    readonly sourceSystem: string,
    readonly firstIndex: number,
    readonly duplicateIndex: number,
  ) {
    super(
      `duplicate edge ${srcId} -[${edgeType}]-> ${dstId} (source_system=${sourceSystem}) in the same batch: ` +
        `batch indexes ${firstIndex} and ${duplicateIndex}`,
    );
  }
}

/** An edge batch's chunked upsert failed at the database. Wraps the original error as `cause`. */
export class EdgeUpsertFailedError extends KnowledgeStoreError {
  constructor(
    message: string,
    readonly chunkStartIndex: number,
    readonly chunkEndIndex: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/**
 * `reweightEdge` was asked to change the weight of an edge that does not
 * exist asserted by the calling source system (bd-hmd.2). Distinct from
 * `retractEdge`, which treats "nothing to remove" as an idempotent no-op —
 * silently doing nothing to a weight change the caller believes just
 * happened would be a silent failure (role lens: "fail loudly"), so this
 * is a named error instead.
 */
export class EdgeNotFoundError extends KnowledgeStoreError {
  constructor(
    readonly srcId: string,
    readonly dstId: string,
    readonly edgeType: string,
    readonly sourceSystem: string,
  ) {
    super(`edge ${srcId} -[${edgeType}]-> ${dstId} (source_system=${sourceSystem}) does not exist`);
  }
}

// --- Merge -----------------------------------------------------------------

/**
 * A single required node id names no node: `mergeNodes` (either id),
 * `getNeighbors`, or `getNodeHistory`. `getNodeHistory` does not fold
 * merges (history is per node as stored), so for it this means the id
 * matches no row at all, merged-away or otherwise.
 */
export class NodeNotFoundError extends KnowledgeStoreError {
  constructor(readonly nodeId: string) {
    super(`node ${nodeId} does not exist`);
  }
}

/**
 * `mergeNodes` was asked to merge a node into itself — either directly,
 * or indirectly (the survivor resolves, through its own merge chain, to
 * the loser).
 */
export class SelfMergeError extends KnowledgeStoreError {
  constructor(
    readonly loserId: string,
    readonly survivorId: string,
    readonly resolvedCanonicalId?: string,
  ) {
    super(
      resolvedCanonicalId && resolvedCanonicalId !== survivorId
        ? `cannot merge node ${loserId} into ${survivorId}: ${survivorId} resolves to ${resolvedCanonicalId}, which is ${loserId} itself`
        : `cannot merge node ${loserId} into itself`,
    );
  }
}

/**
 * `mergeNodes` failed for a reason other than the validation errors above
 * (`NodeNotFoundError`, `SelfMergeError`) — a genuine database failure,
 * such as a deadlock (Postgres `40P01`) that survived the bounded retry,
 * or any other unexpected error. Wrapped so every error this package
 * throws is a `KnowledgeStoreError`, never a raw driver error with no
 * hook for a caller (including the MCP server in bd-vt2.5) to catch.
 */
export class MergeFailedError extends KnowledgeStoreError {
  constructor(
    message: string,
    readonly loserId: string,
    readonly survivorId: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

// --- Retrieval (bd-vt2.4) ---------------------------------------------------

/**
 * A `retrieve()` / `getStoreSummary()` option is out of range or
 * malformed — e.g. `minRelevance <= 0` (the retrieval spec requires a
 * strictly positive floor: a query consisting only of exclusions matches
 * every document lacking the term at rank zero, so a `>= 0` floor would
 * return an arbitrary slice of the store), `maxDepth` outside `[0, 3]`,
 * `decay` outside `(0, 1]`, or a non-positive `seedLimit` / `fanout` /
 * `nodeBudget`. Rejected before any SQL runs, naming the offending
 * option.
 */
export class InvalidRetrievalOptionError extends KnowledgeStoreError {
  constructor(
    readonly option: string,
    readonly value: unknown,
    reason: string,
  ) {
    super(`invalid retrieval option ${option} (got ${JSON.stringify(value)}): ${reason}`);
  }
}

/**
 * `retrieve()` was called with query text containing no searchable terms
 * — either the empty/whitespace-only string, or text that
 * `websearch_to_tsquery` parses down to zero lexemes (stopwords only,
 * e.g. `"the of and"`; detected via `numnode(tsq) = 0`, per
 * docs/retrieval-query-design.md's "Implementation notes"). Distinct from
 * a query that parses fine but matches nothing (that returns an
 * `"empty"`-mode result, not an error) and from a pure-exclusion query
 * like `-supabase` (that has two tsquery nodes and is handled by the
 * `minRelevance` floor, not this error — see the retrieval spec's "Query
 * matching only excluded terms").
 */
export class EmptyQueryError extends KnowledgeStoreError {
  constructor(readonly queryText: string) {
    super(`query text ${JSON.stringify(queryText)} contains no searchable terms`);
  }
}

/**
 * A retrieval query (exact seeds+traversal, fuzzy fallback, or store
 * summary) failed at the database after passing boundary validation — a
 * genuine driver/Postgres failure, not a caller mistake
 * `InvalidRetrievalOptionError` / `EmptyQueryError` would already have
 * caught. Wraps the original error as `cause` so every error
 * `retrieve()` / `getStoreSummary()` can throw is a `KnowledgeStoreError`.
 */
export class RetrievalFailedError extends KnowledgeStoreError {
  constructor(
    message: string,
    readonly mode: "exact" | "fuzzy" | "summary",
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

// --- Lookup (bd-vt2.5: brain_get / brain_neighbors) -------------------------

/**
 * `getNodes()` / `getNeighbors()` / `getNodeHistory()` received an id
 * that is not a syntactically valid uuid, or an empty `ids` array.
 * Rejected before any SQL runs, naming the offending value — distinct
 * from a syntactically valid id that simply matches no node, which
 * `getNodes()` reports back in `notFoundIds` rather than throwing (per
 * the brain-mcp spec: "Report ids that matched nothing rather than
 * silently omitting them") and `getNeighbors()` / `getNodeHistory()`
 * report via `NodeNotFoundError` (a single required id, same treatment
 * as `mergeNodes`).
 */
export class InvalidLookupIdError extends KnowledgeStoreError {
  constructor(
    readonly value: unknown,
    reason: string,
    /** What `value` was meant to be — `node id` for every uuid-taking read; `getNodesByExternalId` names its `external-id pair`. */
    label = "node id",
  ) {
    super(`invalid ${label} ${JSON.stringify(value)}: ${reason}`);
  }
}

/**
 * `getNodes()` / `getNeighbors()` / `getNodeHistory()` / `getNodesByExternalId()`
 * failed at the database after passing boundary validation — a genuine driver/Postgres
 * failure, not a caller mistake `InvalidLookupIdError` /
 * `NodeNotFoundError` would already have caught. Wraps the original error
 * as `cause` so every error any of these functions can throw is a
 * `KnowledgeStoreError`.
 */
export class LookupFailedError extends KnowledgeStoreError {
  constructor(
    message: string,
    readonly operation: "getNodes" | "getNeighbors" | "getNodeHistory" | "listNodes" | "getWorkItemReadiness" | "patchWorkItem" | "resolveDefaultViews" | "getSubtree" | "getTimeline" | "getNodesByExternalId" | "getWorkBoard" | "listBeadsProjects" | "getBoardItem" | "getRegisteredBeadsProject" | "listPendingReviews" | "listInbox" | "decideInboxItem" | "findNodes" | "requestInboxItem",
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/**
 * `getNeighbors()` received an out-of-range `limit` or a malformed
 * `cursor` (bd-hmd.1), or `getNodeHistory()` received an out-of-range
 * `limit` or `before` — rejected before any SQL runs, naming the
 * offending option. Distinct from `InvalidLookupIdError`, which is about
 * the required `id` argument, not the optional paging options.
 */
export class InvalidLookupOptionError extends KnowledgeStoreError {
  constructor(
    readonly option: string,
    readonly value: unknown,
    reason: string,
  ) {
    super(`invalid lookup option ${option} (got ${JSON.stringify(value)}): ${reason}`);
  }
}

// --- Human write surface (bd-hmd.2) ---------------------------------------

/**
 * `updateNodeContent` was asked to edit a node whose `source_system` is
 * not `"human"` or `"agent"` — see `isEditableSourceSystem` in
 * editability.ts, the single place this whitelist is defined. Names the
 * node and its actual source system rather than a generic failure, so a
 * caller (the tRPC layer, the UI) knows exactly why the edit was refused.
 */
export class NodeNotEditableError extends KnowledgeStoreError {
  constructor(
    readonly nodeId: string,
    readonly sourceSystem: string,
  ) {
    super(
      `node ${nodeId} is not editable: its source_system is ${JSON.stringify(sourceSystem)}, which is file-backed ` +
        `(only nodes whose source_system is "human" or "agent" can be edited — see isEditableSourceSystem)`,
    );
  }
}

// --- Structured listing (work-items change) --------------------------------

/**
 * `listNodes()` received an out-of-range `limit`, a malformed `cursor`, an
 * unparseable `updatedSince`, or a metadata predicate outside the accepted
 * shape (unknown op, non-scalar value, too many predicates or values, a
 * key repeated across `equals` predicates). Rejected before any SQL runs,
 * naming the offending option. Predicates are validated data, never an
 * expression; this error is the boundary that keeps it so.
 */
export class InvalidListOptionError extends KnowledgeStoreError {
  constructor(
    readonly option: string,
    readonly value: unknown,
    /** Kept as a field so a wrapper (`InvalidViewError`, for a view's `filter`) can re-state it under its own prefix without parsing `message`. */
    readonly reason: string,
  ) {
    super(`invalid list option ${option} (got ${JSON.stringify(value)}): ${reason}`);
  }
}

// --- Work items (work-items change) ----------------------------------------

/**
 * A work item's metadata violates the lifecycle contract (work-items spec,
 * "Work items carry a validated lifecycle contract"): a status outside the
 * enum, a priority outside 0..4, an oversized or non-string assignee /
 * spec_id / closed_reason, or an unparseable closed_at. Names the field
 * and the offending value; `index` is the item's position when the check
 * ran over a batch, so a writer knows which item to fix.
 */
export class InvalidWorkItemError extends KnowledgeStoreError {
  constructor(
    readonly field: string,
    readonly value: unknown,
    reason: string,
    readonly index?: number,
  ) {
    super(`invalid work item${index === undefined ? "" : ` at batch index ${index}`}: ${field} (got ${JSON.stringify(value)}) ${reason}`);
  }
}

/**
 * A beads load would take over something another project owns
 * (live-beads-board design.md decision 3): an item already stored under a
 * different `project`, or a project key already registered at a different
 * checkout path. Names both sides so the person can tell a copied
 * tracker from a mistyped key. Nothing was written.
 */
export class BeadsProjectConflictError extends KnowledgeStoreError {
  constructor(
    /** The project being loaded; null for a load given no `--project`. */
    readonly project: string | null,
    readonly kind: "item" | "path",
    /** The bead id for `item`; the requested checkout path for `path`. */
    readonly subject: string,
    /** The project owning the item for `item`; the path the key is registered at for `path`. */
    readonly existing: string,
  ) {
    super(
      kind === "item"
        ? project === null
          ? `beads project conflict: item ${JSON.stringify(subject)} is owned by project ${JSON.stringify(existing)} and this load named no project, which would strip it; load with --project ${existing}`
          : `beads project conflict: item ${JSON.stringify(subject)} is already owned by project ${JSON.stringify(existing)}, so it cannot be loaded for project ${JSON.stringify(project)}`
        : `beads project conflict: project ${JSON.stringify(project)} is already registered at ${JSON.stringify(existing)}, so it cannot be loaded from ${JSON.stringify(subject)}`,
    );
  }
}

/**
 * `patchWorkItem()` was aimed at a node whose `node_type` is not
 * `"work_item"`. Names the node and its actual type so a caller knows this
 * is the wrong tool for that node, not a transient failure.
 */
export class NotAWorkItemError extends KnowledgeStoreError {
  constructor(
    readonly nodeId: string,
    readonly nodeType: string,
  ) {
    super(`node ${nodeId} is not a work item: its node_type is ${JSON.stringify(nodeType)}, not "work_item"`);
  }
}

// --- Event time (timeline-view change) --------------------------------------

/**
 * A node's `occurred_at` is neither absent, null, nor a value that parses
 * as an instant (knowledge-store spec, "Nodes may carry a validated event
 * time"): a number, an object, an empty or unparseable string, an invalid
 * `Date`, or an instant outside the years the fixed-width canonical form
 * covers. The key is the contract's one field, so the message names it
 * itself (`OCCURRED_AT_KEY` in event-time.ts). `item` is however the
 * writer labels the item — the MCP write tool passes its batch index and
 * key — so a writer knows which item to fix.
 */
export class InvalidEventTimeError extends KnowledgeStoreError {
  constructor(
    readonly item: string | null,
    readonly value: unknown,
    reason: string,
  ) {
    super(`invalid event time${item === null ? "" : ` ${item}`}: occurred_at (got ${JSON.stringify(value)}) ${reason}`);
  }
}

// --- Views (node-views change) ---------------------------------------------

/**
 * A view's metadata violates the view contract (node-views spec, "A view
 * is a node with a validated contract"): a `renderer` outside the known
 * set, a missing or non-object `filter`, a `filter` carrying the reader's
 * `limit`/`cursor`, or a filter that structured listing itself rejects
 * (in which case `field` is the offending option under `filter.`, e.g.
 * `filter.where[0].op`, and the `InvalidListOptionError` is the `cause`).
 * `item` is however the writer labels the item — the MCP write tool passes
 * its batch index and key — so a writer knows which item to fix.
 */
export class InvalidViewError extends KnowledgeStoreError {
  constructor(
    readonly item: string | null,
    readonly field: string,
    readonly value: unknown,
    reason: string,
    options?: ErrorOptions,
  ) {
    super(`invalid view${item === null ? "" : ` ${item}`}: ${field} (got ${JSON.stringify(value)}) ${reason}`, options);
  }
}

/** An `inbox_item`'s metadata breaks the inbox contract (inbox.ts). */
export class InvalidInboxItemError extends KnowledgeStoreError {
  constructor(
    readonly field: string,
    readonly value: unknown,
    reason: string,
    readonly itemLabel?: string,
  ) {
    super(`invalid inbox item${itemLabel === undefined ? "" : ` ${itemLabel}`}: ${field} (got ${JSON.stringify(value)}) ${reason}`);
  }
}

/** A decision was asked of an inbox item that is not waiting on the person (inbox.ts). */
export class InboxDecisionConflictError extends KnowledgeStoreError {
  constructor(
    readonly nodeId: string,
    readonly status: string,
  ) {
    super(`inbox item ${nodeId} is not waiting on a decision: its status is ${JSON.stringify(status)}`);
  }
}

/**
 * An inbox accept named an option the item's stored card does not offer, or
 * named none on a card that now has options: an agent rewrote the card
 * after the person opened it (unify-review-queues). Its wording carries the
 * phrases the web's `isCardMovedRefusal` reads, like a review's.
 */
export class InboxCardChangedError extends KnowledgeStoreError {
  constructor(
    readonly nodeId: string,
    readonly option: string | null,
  ) {
    super(
      option === null
        ? `inbox item ${nodeId} changed since it was opened and now asks to choose an option`
        : `inbox item ${nodeId} does not offer option ${JSON.stringify(option)}; its card was rewritten after it was opened`,
    );
  }
}

/** The node a decision targets is not an `inbox_item`. */
export class NotAnInboxItemError extends KnowledgeStoreError {
  constructor(
    readonly nodeId: string,
    readonly nodeType: string,
  ) {
    super(`node ${nodeId} is not an inbox item: its node_type is ${JSON.stringify(nodeType)}, not "inbox_item"`);
  }
}

/**
 * An accept or a send-back on an inbox item whose hangar session has ended
 * (stopped, failed, merged away, or gone): nobody reads that session's
 * messages, and the decision must not quietly become a local execution on
 * this host (hangar-queue, security review). Nothing was written. Dismiss,
 * release, and hand-off still work.
 */
export class InboxItemSessionEndedError extends KnowledgeStoreError {
  constructor(
    readonly nodeId: string,
    readonly sessionId: string,
  ) {
    super(`inbox item ${nodeId} was filed by hangar session ${sessionId}, which has ended, so an accept or a send-back would reach nobody`);
  }
}

/**
 * A session-bound token tried to complete, or re-send, an inbox item another
 * session (or no session: a local pane's or a person's) filed (hangar-queue
 * decision 9). Nothing was written.
 */
export class InboxItemNotThisSessionError extends KnowledgeStoreError {
  constructor(
    readonly nodeId: string,
    readonly sessionId: string,
    readonly attempted: "complete" | "re-send" = "complete",
  ) {
    super(`inbox item ${nodeId} was not filed by hangar session ${sessionId}, so its token cannot ${attempted} it`);
  }
}

// --- Client tokens -----------------------------------------------------

/** A client name is not a short identifier (client-tokens.ts, `CLIENT_NAME_PATTERN`). */
export class InvalidClientNameError extends KnowledgeStoreError {
  constructor(readonly client: string) {
    super(
      `invalid client name ${JSON.stringify(client)}: it must start with a letter or digit and hold at most 64 letters, digits, ".", "_", or "-"`,
    );
  }
}

/** A host-minted token named a client in the `session-` namespace, which only a hangar claim mints (client-tokens.ts). */
export class ReservedClientNameError extends KnowledgeStoreError {
  constructor(readonly client: string) {
    super(`client name ${JSON.stringify(client)} is reserved: names starting with "session-" are minted only by a hangar claim, for that session; choose another name`);
  }
}

/** A token was asked for a client that already holds a live one. */
export class ClientTokenExistsError extends KnowledgeStoreError {
  constructor(readonly client: string) {
    super(
      `client ${JSON.stringify(client)} already has a live token; revoke it first with \`pnpm -s client-token revoke ${client}\``,
    );
  }
}

/** A revoke named a client with no live token. */
export class ClientTokenNotFoundError extends KnowledgeStoreError {
  constructor(readonly client: string) {
    super(`client ${JSON.stringify(client)} has no live token`);
  }
}

// --- Hangar sessions (hangar-queue change) -----------------------------

/** A `hangar_session`'s metadata, or an argument to a hangar call, breaks the contract (hangar.ts). */
export class InvalidHangarSessionError extends KnowledgeStoreError {
  constructor(
    readonly field: string,
    readonly value: unknown,
    reason: string,
    readonly itemLabel?: string,
  ) {
    super(`invalid hangar session${itemLabel === undefined ? "" : ` ${itemLabel}`}: ${field} (got ${JSON.stringify(value)}) ${reason}`);
  }
}

/** A hangar call named a node that is not a hangar session, or none at all. */
export class HangarSessionNotFoundError extends KnowledgeStoreError {
  constructor(readonly sessionId: string) {
    super(`hangar session ${sessionId} does not exist`);
  }
}

/** A session state change outside the state machine (hangar.ts `checkHangarTransition`); nothing was written. */
export class HangarTransitionError extends KnowledgeStoreError {
  constructor(
    readonly from: string,
    readonly to: string,
  ) {
    super(`hangar session cannot move from ${JSON.stringify(from)} to ${JSON.stringify(to)}`);
  }
}

/** A hangar tried to change a session another hangar claimed, or none did. */
export class HangarSessionNotClaimedByError extends KnowledgeStoreError {
  constructor(
    readonly sessionId: string,
    readonly hangar: string,
    readonly claimedBy: string | null,
  ) {
    super(
      claimedBy === null
        ? `hangar session ${sessionId} is not claimed, so ${JSON.stringify(hangar)} cannot change it`
        : `hangar session ${sessionId} is claimed by ${JSON.stringify(claimedBy)}, not ${JSON.stringify(hangar)}`,
    );
  }
}

/**
 * A generic writer (brain_write) was given a node only the hangar paths
 * write: node_type `hangar_session`, or anything under source system
 * `hangar`. Nothing was written.
 */
export class ReservedHangarNodeError extends KnowledgeStoreError {
  constructor(readonly itemLabel: string) {
    super(`node ${itemLabel} is reserved for the hangar queue (node_type "hangar_session" and source_system "hangar" are written only by it)`);
  }
}

/**
 * `mergeNodes` was asked to merge a hangar session (node_type
 * `hangar_session` or source system `hangar`) away or into something, or to
 * merge something into one. A session's identity is its token's binding and
 * its inbox items' `session`; a merge would silently move or orphan both.
 * Nothing was written.
 */
export class HangarSessionMergeError extends KnowledgeStoreError {
  constructor(
    readonly loserId: string,
    readonly survivorId: string,
    readonly sessionNodeId: string,
  ) {
    super(`cannot merge node ${loserId} into ${survivorId}: node ${sessionNodeId} is a hangar session, which is never merged`);
  }
}

/**
 * A generic edge writer (brain_link) was given an edge only the hangar paths
 * write: one under source system `hangar`, or one whose source is a hangar
 * session (its `run_by` link is written when the session is requested).
 * Nothing was written.
 */
export class ReservedHangarEdgeError extends KnowledgeStoreError {
  constructor(readonly itemLabel: string, reason: string) {
    super(`edge ${itemLabel} is reserved for the hangar queue: ${reason}`);
  }
}
