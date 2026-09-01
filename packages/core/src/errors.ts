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

// --- Merge -----------------------------------------------------------------

/** `mergeNodes` was called with a node id that does not exist. */
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
 * `getNodes()` / `getNeighbors()` received an id that is not a
 * syntactically valid uuid, or an empty `ids` array. Rejected before any
 * SQL runs, naming the offending value — distinct from a syntactically
 * valid id that simply matches no node, which `getNodes()` reports back
 * in `notFoundIds` rather than throwing (per the brain-mcp spec: "Report
 * ids that matched nothing rather than silently omitting them") and
 * `getNeighbors()` reports via `NodeNotFoundError` (a single required id,
 * same treatment as `mergeNodes`).
 */
export class InvalidLookupIdError extends KnowledgeStoreError {
  constructor(
    readonly value: unknown,
    reason: string,
  ) {
    super(`invalid node id ${JSON.stringify(value)}: ${reason}`);
  }
}

/**
 * `getNodes()` / `getNeighbors()` failed at the database after passing
 * boundary validation — a genuine driver/Postgres failure, not a caller
 * mistake `InvalidLookupIdError` / `NodeNotFoundError` would already have
 * caught. Wraps the original error as `cause` so every error either
 * function can throw is a `KnowledgeStoreError`.
 */
export class LookupFailedError extends KnowledgeStoreError {
  constructor(
    message: string,
    readonly operation: "getNodes" | "getNeighbors",
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
