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
