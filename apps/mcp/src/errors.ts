// Error mapping: every `@breakdown/core` error, and Zod argument
// validation failures, become a tool result the calling model can act on
// — which input item to fix and how, or "retry, this is a database
// problem" when it isn't the caller's fault. An unrecognized error never
// leaks a raw stack trace as guidance; the full detail goes to stderr for
// an operator instead.

import {
  ContentTooLargeError,
  DuplicateEdgeInBatchError,
  DuplicateNodeInBatchError,
  EdgeUpsertFailedError,
  EmptyQueryError,
  InvalidEdgeInputError,
  InvalidEdgeWeightError,
  InvalidIngestRunError,
  InvalidLookupIdError,
  InvalidNodeContentError,
  InvalidNodeInputError,
  InvalidRetrievalOptionError,
  KnowledgeStoreError,
  LookupFailedError,
  MergeFailedError,
  NodeNotFoundError,
  NodeUpsertFailedError,
  RetrievalFailedError,
  SelfMergeError,
} from "@breakdown/core";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ZodError } from "zod";

function errorResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** Core's message already names the offending value; this appends only what to *do* about it. */
function actionable(err: KnowledgeStoreError, hint: string): CallToolResult {
  return errorResult(`${err.message} ${hint}`);
}

const RETRY_HINT = "This is a database problem, not a problem with your input — you may retry the call.";

export function formatZodError(toolName: string, err: ZodError): CallToolResult {
  const issues = err.issues.map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`).join("; ");
  return errorResult(`Invalid arguments for ${toolName}: ${issues}. Fix the listed field(s) and retry.`);
}

/**
 * Maps any error a tool handler can throw to a `CallToolResult` with
 * `isError: true` — see the module header. `toolName` is only used for
 * the unrecognized-error fallback and Zod formatting; every mapped
 * `KnowledgeStoreError` already names itself and the offending value.
 */
export function mapError(toolName: string, err: unknown): CallToolResult {
  if (err instanceof ZodError) {
    return formatZodError(toolName, err);
  }

  // --- Nodes (brain_write) ---
  if (err instanceof ContentTooLargeError) {
    return actionable(err, "Shorten the content, or split it into multiple nodes, then retry.");
  }
  if (err instanceof InvalidNodeContentError) {
    return actionable(err, "Remove the disallowed control character from that field and retry.");
  }
  if (err instanceof DuplicateNodeInBatchError) {
    return actionable(err, "Each item in one brain_write call must have a unique (sourceSystem, externalId) — merge the two items into one, or drop the duplicate, then retry.");
  }
  if (err instanceof InvalidNodeInputError) {
    return actionable(err, "Fix that field on the named item and retry.");
  }
  if (err instanceof NodeUpsertFailedError) {
    return actionable(err, RETRY_HINT);
  }

  // --- Edges (brain_link) ---
  if (err instanceof InvalidEdgeWeightError) {
    return actionable(err, "Provide a weight between 0 and 1 (or omit it for the default of 1.0), then retry.");
  }
  if (err instanceof DuplicateEdgeInBatchError) {
    return actionable(err, "Each edge in one brain_link call must be unique on (srcId, dstId, edgeType, sourceSystem) — drop the duplicate and retry.");
  }
  if (err instanceof InvalidEdgeInputError) {
    return actionable(err, "Fix that field on the named edge and retry. If srcId/dstId look right but are rejected, confirm them with brain_get first.");
  }
  if (err instanceof EdgeUpsertFailedError) {
    return actionable(err, `${RETRY_HINT} If the message mentions a missing key, verify srcId/dstId reference existing nodes with brain_get first.`);
  }

  // --- Merge (brain_merge) ---
  if (err instanceof SelfMergeError) {
    return actionable(err, "Choose a different survivorId — these ids already refer to the same node.");
  }
  if (err instanceof MergeFailedError) {
    return actionable(err, RETRY_HINT);
  }
  // NodeNotFoundError is also thrown by getNeighbors (brain_neighbors) and
  // by mergeNodes (brain_merge) for either id — same guidance either way.
  if (err instanceof NodeNotFoundError) {
    return actionable(err, "Use brain_search or brain_map to find a valid node id, or brain_get to verify one you already have.");
  }

  // --- Search / map (brain_search, brain_map) ---
  if (err instanceof InvalidRetrievalOptionError) {
    return actionable(err, "Adjust that option to a value in range and retry.");
  }
  if (err instanceof EmptyQueryError) {
    return actionable(err, "Provide at least one meaningful search term (not just whitespace or common stopwords) and retry.");
  }
  if (err instanceof RetrievalFailedError) {
    return actionable(err, RETRY_HINT);
  }

  // --- Get / neighbors (brain_get, brain_neighbors) ---
  if (err instanceof InvalidLookupIdError) {
    return actionable(err, "Ids must be uuids returned by brain_search, brain_map, brain_write, or brain_link — verify the id and retry.");
  }
  if (err instanceof LookupFailedError) {
    return actionable(err, RETRY_HINT);
  }

  // --- Attribution plumbing (should not surface in practice — the server
  // always supplies a non-empty source_system — but mapped for
  // completeness, per "every KnowledgeStoreError this package can throw
  // must be caught by type here, never generic'd away silently"). ---
  if (err instanceof InvalidIngestRunError) {
    return actionable(err, "This is a server-side setup problem, not an input problem — retry the call.");
  }

  // Any other KnowledgeStoreError subclass this table has not been
  // updated for: still safe (its .message is never a raw stack), but
  // flagged distinctly so it is easy to spot in logs and add above.
  if (err instanceof KnowledgeStoreError) {
    return errorResult(`${err.constructor.name}: ${err.message} Retry, or adjust the input this names.`);
  }

  // Truly unrecognized. Full detail — including any stack — goes to
  // stderr (never stdout, which is the stdio JSON-RPC channel) for an
  // operator to read; the model only ever sees a safe, generic notice
  // that never quotes the stack as if it were guidance.
  console.error(`[breakdown-brain] unexpected error in ${toolName}:`, err);
  const message = err instanceof Error ? err.message : String(err);
  return errorResult(
    `${toolName} failed unexpectedly (${message}). This is a server-side problem, not something in your input to fix. You may retry; if it persists, this needs operator attention.`,
  );
}
