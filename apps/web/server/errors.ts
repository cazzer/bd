// Error mapping (bd-hmd.3): every `@breakdown/core` error becomes a
// `TRPCError` that names the offending field and what to do about it —
// the same shape apps/mcp/src/errors.ts already gives agent callers, laid
// out here for the browser instead.
//
// The one hazard that matters more here than it did for MCP (stdio, no
// browser devtools inspecting the wire): `LookupFailedError`'s (and
// `RetrievalFailedError`'s / `NodeUpsertFailedError`'s / etc.) `.cause` is
// whatever the database driver threw, which for drizzle-orm's
// node-postgres adapter is a `DrizzleQueryError` whose own `.message` is
// literally `"Failed query: <the full SQL text>\nparams: ..."` — every
// inline comment in packages/core/src/{retrieval,lookup,nodes,edges}.ts
// included. `actionable()` below builds every `TRPCError` from
// `err.message` (which core already keeps safe — see
// packages/core/src/errors.ts) and NEVER passes `cause` into the
// `TRPCError` it constructs, so that SQL text has no path into the
// response. server/trpc.ts's `errorFormatter` is the second, independent
// guard: it never forwards `error.cause` or a stack trace either, so even
// a future call site that mistakenly attaches `cause` still can't leak it
// over the wire — see that file's header for why both layers exist.
//
// The full original error (SQL text and all) still goes to the server's
// own stderr via `console.error` below, for whoever is running this
// locally to read — never sent to the client.

import {
  asPgError,
  ContentTooLargeError,
  DuplicateEdgeInBatchError,
  DuplicateNodeInBatchError,
  EdgeNotFoundError,
  EdgeUpsertFailedError,
  EmptyQueryError,
  InvalidEdgeInputError,
  InvalidEdgeWeightError,
  InvalidEventTimeError,
  InvalidIngestRunError,
  InvalidListOptionError,
  InvalidLookupIdError,
  InvalidLookupOptionError,
  InvalidNodeContentError,
  InvalidNodeInputError,
  InvalidRetrievalOptionError,
  InvalidViewError,
  KnowledgeStoreError,
  LookupFailedError,
  MergeFailedError,
  MetadataTooLargeError,
  NodeNotEditableError,
  NodeNotFoundError,
  NodeUpsertFailedError,
  RetrievalFailedError,
  SelfMergeError,
} from "@breakdown/core";
import { TRPCError } from "@trpc/server";

type TRPCErrorCode = ConstructorParameters<typeof TRPCError>[0]["code"];

const RETRY_HINT = "This is a database problem, not a problem with your input — you may retry.";

/** Postgres SQLSTATE for a foreign-key violation — see isForeignKeyViolation below. */
const POSTGRES_FOREIGN_KEY_VIOLATION = "23503";

/**
 * True when `err` (an `EdgeUpsertFailedError`) wraps a foreign-key
 * violation — i.e. `srcId`/`dstId` named a node that does not exist. This
 * is an input problem, not a database problem: unlike a genuine
 * connectivity/deadlock failure, retrying the exact same call fails
 * again, deterministically, until the ids are fixed. Mirrors
 * apps/mcp/src/errors.ts's identical check exactly — same bug, same fix,
 * only the transport differs (bd-vt2.5 review found this for MCP first).
 * Reads `.code` off the unwrapped pg error only — never `.cause`'s
 * `.message`, which is where the SQL text lives (see this module's
 * header).
 */
function isForeignKeyViolation(err: EdgeUpsertFailedError): boolean {
  return asPgError(err.cause)?.code === POSTGRES_FOREIGN_KEY_VIOLATION;
}

/**
 * Builds a `TRPCError` from a `KnowledgeStoreError`, using only its own
 * `.message` (already safe — see the module header) plus a plain-language
 * hint. Deliberately never reads or forwards `err.cause`.
 */
function actionable(code: TRPCErrorCode, err: KnowledgeStoreError, hint: string): TRPCError {
  return new TRPCError({ code, message: `${err.message} ${hint}` });
}

/**
 * Maps any error a procedure's core call can throw to a `TRPCError`.
 * `procedureName` is only used for the unrecognized-error log line and
 * fallback message — every mapped `KnowledgeStoreError` already names
 * itself and the offending value in `err.message`.
 */
export function mapCoreError(procedureName: string, err: unknown): TRPCError {
  // --- Nodes ---
  if (err instanceof ContentTooLargeError) {
    return actionable("BAD_REQUEST", err, "Shorten the content, or split it into multiple nodes, then retry.");
  }
  if (err instanceof MetadataTooLargeError) {
    return actionable("BAD_REQUEST", err, "metadata is for small structured data, not documents — shorten it, move large values into content instead, then retry.");
  }
  if (err instanceof InvalidNodeContentError) {
    return actionable("BAD_REQUEST", err, "Remove the disallowed control character from that field and retry.");
  }
  if (err instanceof DuplicateNodeInBatchError) {
    return actionable("BAD_REQUEST", err, "Use a unique (sourceSystem, externalId) and retry.");
  }
  if (err instanceof InvalidNodeInputError) {
    return actionable("BAD_REQUEST", err, "Fix that field and retry.");
  }
  if (err instanceof NodeNotEditableError) {
    return actionable("FORBIDDEN", err, "This node is file-backed and cannot be edited directly — annotate it instead.");
  }
  if (err instanceof NodeUpsertFailedError) {
    return actionable("INTERNAL_SERVER_ERROR", err, RETRY_HINT);
  }

  // --- Edges ---
  if (err instanceof InvalidEdgeWeightError) {
    return actionable("BAD_REQUEST", err, "Provide a weight between 0 and 1 (or omit it for the default of 1.0) and retry.");
  }
  if (err instanceof DuplicateEdgeInBatchError) {
    return actionable("BAD_REQUEST", err, "That edge is already asserted — drop the duplicate and retry.");
  }
  if (err instanceof InvalidEdgeInputError) {
    return actionable("BAD_REQUEST", err, "Fix that field and retry. If srcId/dstId look right but are rejected, confirm them with getNodes first.");
  }
  if (err instanceof EdgeNotFoundError) {
    return actionable("NOT_FOUND", err, "Verify srcId, dstId, and edgeType with getNeighbors, then retry.");
  }
  if (err instanceof EdgeUpsertFailedError) {
    if (isForeignKeyViolation(err)) {
      return actionable("BAD_REQUEST", err, "srcId and/or dstId do not reference an existing node — verify both with getNodes (or find the right ones with search), then retry with corrected ids.");
    }
    return actionable("INTERNAL_SERVER_ERROR", err, RETRY_HINT);
  }

  // --- Merge-adjacent (NodeNotFoundError is also thrown by getNeighbors/annotateNode) ---
  if (err instanceof SelfMergeError) {
    return actionable("BAD_REQUEST", err, "Choose a different node.");
  }
  if (err instanceof MergeFailedError) {
    return actionable("INTERNAL_SERVER_ERROR", err, RETRY_HINT);
  }
  if (err instanceof NodeNotFoundError) {
    return actionable("NOT_FOUND", err, "Use search to find a valid node id, or getNodes to verify one you already have.");
  }

  // --- Search ---
  if (err instanceof InvalidRetrievalOptionError) {
    return actionable("BAD_REQUEST", err, "Adjust that option to a value in range and retry.");
  }
  if (err instanceof EmptyQueryError) {
    return actionable("BAD_REQUEST", err, "Provide at least one meaningful search term (not just whitespace or common stopwords) and retry.");
  }
  if (err instanceof RetrievalFailedError) {
    return actionable("INTERNAL_SERVER_ERROR", err, RETRY_HINT);
  }

  // --- Lookup ---
  if (err instanceof InvalidLookupIdError) {
    return actionable("BAD_REQUEST", err, "Ids must be uuids returned by search or getNodes — verify the id and retry.");
  }
  if (err instanceof InvalidLookupOptionError) {
    return actionable("BAD_REQUEST", err, "Adjust that option to a value in range and retry.");
  }
  if (err instanceof LookupFailedError) {
    return actionable("INTERNAL_SERVER_ERROR", err, RETRY_HINT);
  }

  // --- Structured listing (list) — Zod rejects malformed options first, so
  // this is reached only for what the schema cannot see, e.g. a cursor
  // that is well-formed text but not a keyset position core issued. ---
  if (err instanceof InvalidListOptionError) {
    return actionable("BAD_REQUEST", err, "Fix that option and retry: predicates are { key, op: \"equals\", value } or { key, op: \"oneOf\", values }, values are scalars, cursor is a nextCursor from a previous list response.");
  }

  // --- Views (node-views). No web procedure writes a view today (MCP
  // only, design.md's Non-Goals), so this cannot surface yet; mapped now,
  // beside the listing error the view contract reuses, so the first web
  // writer inherits a field-naming BAD_REQUEST instead of the unmapped
  // fallback below. ---
  if (err instanceof InvalidViewError) {
    return actionable("BAD_REQUEST", err, "Fix that field on the named item and retry; nothing from this call was persisted. renderer is one of graph, feed, code, timeline; filter is an object of list options (nodeTypes, sourceSystems, updatedSince, where) without limit or cursor.");
  }

  // --- Event time (timeline-view). No web procedure writes metadata a
  // caller supplies today, so this cannot surface yet; mapped now for the
  // same reason the view error is. ---
  if (err instanceof InvalidEventTimeError) {
    return actionable("BAD_REQUEST", err, "Fix occurred_at on the named item and retry; nothing from this call was persisted. It is an ISO-8601 timestamp, stored canonically as UTC with milliseconds (2026-03-04T08:00:00.000Z), or null to remove it.");
  }

  // --- Attribution plumbing (should not surface in practice — every write
  // procedure below always supplies a non-empty source_system — but
  // mapped for completeness, matching apps/mcp/src/errors.ts's rationale). ---
  if (err instanceof InvalidIngestRunError) {
    return actionable("INTERNAL_SERVER_ERROR", err, "This is a server-side setup problem, not an input problem — retry.");
  }

  // Any other KnowledgeStoreError subclass this table has not been
  // updated for: still safe (its .message is never a raw stack), but
  // flagged distinctly so it is easy to spot in the server log and add
  // above.
  if (err instanceof KnowledgeStoreError) {
    console.error(`[web] unmapped KnowledgeStoreError in ${procedureName}:`, err);
    return new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `${err.constructor.name}: ${err.message} Retry, or adjust the input this names.` });
  }

  // Truly unrecognized. Full detail — including any stack — goes to the
  // server's own stderr for whoever is running this locally to read; the
  // client only ever sees a safe, generic notice.
  console.error(`[web] unexpected error in ${procedureName}:`, err);
  return new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: `${procedureName} failed unexpectedly. This is a server-side problem, not something in your input to fix. You may retry.`,
  });
}
