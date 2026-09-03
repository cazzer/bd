// Error mapping: every `@breakdown/core` error, and Zod argument
// validation failures, become a tool result the calling model can act on
// — which input item to fix and how, or "retry, this is a database
// problem" when it isn't the caller's fault. An unrecognized error never
// leaks a raw stack trace as guidance; the full detail goes to stderr for
// an operator instead.

import {
  asPgError,
  isDrizzleQueryError,
  ContentTooLargeError,
  DuplicateEdgeInBatchError,
  DuplicateNodeInBatchError,
  EdgeUpsertFailedError,
  EmptyQueryError,
  InvalidEdgeInputError,
  InvalidEdgeWeightError,
  InvalidIngestRunError,
  InvalidListOptionError,
  InvalidLookupIdError,
  InvalidLookupOptionError,
  InvalidNodeContentError,
  InvalidNodeInputError,
  InvalidRetrievalOptionError,
  InvalidWorkItemError,
  KnowledgeStoreError,
  LookupFailedError,
  MergeFailedError,
  MetadataTooLargeError,
  NodeNotFoundError,
  NodeUpsertFailedError,
  NotAWorkItemError,
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

/** Postgres SQLSTATE for a foreign-key violation — see the EdgeUpsertFailedError branch below. */
const POSTGRES_FOREIGN_KEY_VIOLATION = "23503";

/**
 * True when `err` (an `EdgeUpsertFailedError`) wraps a foreign-key
 * violation — i.e. `srcId`/`dstId` named a node that does not exist. This
 * is an input problem, not a database problem: unlike a genuine
 * connectivity/deadlock failure, retrying the exact same call fails
 * again, deterministically, until the ids are fixed (bd-vt2.5 review: the
 * un-conditioned message told the model both "retry" and "verify the
 * ids," which sends it into a retry loop that can never succeed).
 */
function isForeignKeyViolation(err: EdgeUpsertFailedError): boolean {
  return asPgError(err.cause)?.code === POSTGRES_FOREIGN_KEY_VIOLATION;
}

/** Postgres SQLSTATE for a check violation: the blocks-acyclic trigger raises it (migrations/0003_*.sql). */
const POSTGRES_CHECK_VIOLATION = "23514";

/**
 * True when `err` (an `EdgeUpsertFailedError`) wraps the blocks-acyclic
 * trigger's rejection. Like a foreign-key violation this is an input
 * problem: the same call fails again until the offending edge is removed.
 * The weight range check is the only other CHECK on `edges`, and weight is
 * validated before SQL, so a check violation here is the cycle trigger.
 */
function isBlocksCycle(err: EdgeUpsertFailedError): boolean {
  return asPgError(err.cause)?.code === POSTGRES_CHECK_VIOLATION;
}

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
  if (err instanceof MetadataTooLargeError) {
    return actionable(err, "metadata is for small structured data, not documents — shorten it, move large values into content instead, or split across multiple nodes, then retry.");
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
    if (isBlocksCycle(err)) {
      return actionable(
        err,
        "A `blocks` edge in this call would make a node transitively block itself; the message above names its endpoints. Nothing from this call was stored. Remove or reverse that edge and retry. If the cycle already exists (a merge can create one), brain_ready lists its members.",
      );
    }
    if (isForeignKeyViolation(err)) {
      return actionable(err, "srcId and/or dstId do not reference an existing node — this is an input problem, not a database one; retrying with the same ids will fail again. Verify both ids with brain_get (or find the right ones with brain_search/brain_map), then retry with corrected ids.");
    }
    return actionable(err, RETRY_HINT);
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

  // --- Get / neighbors / history (brain_get, brain_neighbors, brain_history) ---
  if (err instanceof InvalidLookupIdError) {
    return actionable(err, "Ids must be uuids returned by brain_search, brain_map, brain_write, or brain_link — verify the id and retry.");
  }
  // Reachable from brain_history (a `before` past int4 slips through the
  // Zod schema, which bounds only `limit`); brain_neighbors' own schema
  // takes no paging options yet, so core's check is the only one for it.
  if (err instanceof InvalidLookupOptionError) {
    return actionable(err, "Adjust that option to a value in range and retry.");
  }
  if (err instanceof LookupFailedError) {
    return actionable(err, RETRY_HINT);
  }

  // --- Structured listing (brain_list) ---
  if (err instanceof InvalidListOptionError) {
    return actionable(err, "Fix that option and retry: predicates are { key, op: \"equals\", value } or { key, op: \"oneOf\", values }, values are scalars, cursor is a nextCursor from a previous brain_list response.");
  }

  // --- Work items (brain_write of a work_item, brain_update_work_item) ---
  if (err instanceof InvalidWorkItemError) {
    return actionable(err, "Fix that field on the named item and retry; nothing from this call was persisted. status is one of open, in_progress, blocked, closed, deferred; priority is an integer 0-4.");
  }
  if (err instanceof NotAWorkItemError) {
    return actionable(err, "brain_update_work_item only patches nodes whose nodeType is work_item. Use brain_write to change other nodes, or write this one as a work_item first.");
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

  // A driver failure that escaped core's wrapping: drizzle's message is the
  // SQL text and its parameters, which belong in the operator's log, not
  // in a tool result.
  if (isDrizzleQueryError(err)) {
    console.error(`[breakdown-brain] unexpected database error in ${toolName}:`, err);
    return errorResult(`${toolName} failed at the database. ${RETRY_HINT}`);
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
