// The four write tools: brain_write, brain_link, brain_merge,
// brain_update_work_item (brain_hangar_request lives in hangar.ts). Every
// argument here is untrusted model output — validated by `schema` before
// the handler runs (server.ts), and never interpolated as anything but
// literal text/parameter values by the `@breakdown/core` functions these
// call (there is no SQL passthrough anywhere in this server).
//
// brain_write/brain_link wrap their per-item schema in a top-level
// `{ items: ... }` object rather than accepting a bare array or union at
// the top level: MCP tool call arguments are always a JSON object, so a
// tool's input schema must be `type: "object"` — the "single item or a
// batch in one call" flexibility the spec asks for lives in the `items`
// field's own union, not at the argument root.

import type { EdgeInput, NodeInput } from "@breakdown/core";
import {
  assertNoReservedHangarEdges,
  assertSessionCreatedAbsentKeys,
  assertSessionMayWriteInboxItems,
  DEFAULT_MAX_METADATA_LENGTH,
  HANGAR_SESSION_NODE_TYPE,
  HANGAR_SOURCE_SYSTEM,
  MAX_ASSIGNEE_LENGTH,
  MAX_CLOSED_REASON_LENGTH,
  MAX_SPEC_ID_LENGTH,
  MAX_WORK_ITEM_PRIORITY,
  MIN_WORK_ITEM_PRIORITY,
  mergeNodes,
  normalizeOccurredAt,
  normalizeViewMetadata,
  normalizeInboxItemMetadata,
  carryForwardInboxDecisions,
  loadStoredInboxMetadata,
  INBOX_ITEM_NODE_TYPE,
  normalizeWorkItemMetadata,
  patchWorkItem,
  ReservedHangarNodeError,
  upsertEdges,
  upsertNodes,
  VIEW_NODE_TYPE,
  WORK_ITEM_NODE_TYPE,
  WORK_ITEM_STATUSES,
  type WorkItemPatch,
} from "@breakdown/core";
import { z } from "zod";
import { AGENT_SOURCE_SYSTEM, withAgentIngestRun } from "../attribution.js";
import { boundResponse } from "../budget.js";
import type { ToolContext, ToolDef } from "../types.js";

function toArray<T>(value: T | readonly T[]): T[] {
  return Array.isArray(value) ? value : [value as T];
}

/**
 * Hard ceiling on how many items one brain_write/brain_link call — or one
 * brain_get lookup — can carry (bd-vt2.5 review: an unbounded batch of
 * 30,000 items succeeded in testing). 1,000 stays comfortably above the
 * spec's own bulk-load scenario (50 nodes) and above upsertNodes'/
 * upsertEdges' own internal chunk size, while keeping one call's
 * transaction — and its potential rollback — bounded to something a
 * single request is meant to carry, not tens of gigabytes.
 */
const MAX_BATCH_ITEMS = 1000;

/**
 * A `Record<string, unknown>` field capped at `maxChars` of serialized
 * JSON — the Zod-layer counterpart to core's `MetadataTooLargeError`
 * (`packages/core/src/nodes.ts`). `metadata`/`props` are for small
 * structured key/value data, not document content; nothing bounded them
 * at the MCP boundary before this (bd-vt2.5 review: 5MB of metadata wrote
 * successfully in 114ms and then reappeared in full in every brain_get
 * response that returned it, at ~200x the response budget). This is a
 * boundary check — reject obviously-bad input before it reaches core at
 * all — not a substitute for core's own guard, which is the actual
 * invariant a caller other than this MCP server (e.g. a future db:seed
 * loader) would otherwise miss.
 */
function boundedRecordSchema(maxChars: number, fieldLabel: string) {
  return z
    .record(z.string(), z.unknown())
    .refine((value) => JSON.stringify(value).length <= maxChars, `${fieldLabel} must serialize to at most ${maxChars} characters — it is for small structured data, not documents`);
}

// --- brain_write -----------------------------------------------------------

const nodeItemSchema = z.object({
  nodeType: z.string().min(1),
  externalId: z.string().min(1),
  /** Defaults to "agent" — see attribution.ts. Set explicitly (e.g. "github") when loading content whose provenance should read as that source rather than the agent itself. */
  sourceSystem: z.string().min(1).optional(),
  title: z.string().optional(),
  content: z.string().optional(),
  metadata: boundedRecordSchema(DEFAULT_MAX_METADATA_LENGTH, "metadata").optional(),
});

const writeSchema = z.object({
  items: z.union([nodeItemSchema, z.array(nodeItemSchema).min(1, "batch must contain at least one item").max(MAX_BATCH_ITEMS, `batch must contain at most ${MAX_BATCH_ITEMS} items`)]),
});

export const writeTool: ToolDef<typeof writeSchema> = {
  name: "brain_write",
  description:
    "Create or update one node, or a batch of nodes in one call (pass items as a single object or an array, up to 1000 items). Each item is upserted on (sourceSystem, externalId) — re-writing identical content is a no-op reported as 'unchanged'; changed content is 'updated'; a new key is 'created'. sourceSystem defaults to \"agent\" when omitted. All items in one call share a single ingest run attributed to source_system='agent' and to this client as actor, so this call's writes are identifiable and revertible as a unit. Items with nodeType \"work_item\" are validated against the work-item contract (metadata status/priority/assignee/closed_at/closed_reason/spec_id/project, where project is 1-64 characters of [a-z0-9._-]; missing status defaults to open, priority to 2; optional decisions [{at, decision, note, item?}] and signals [{at, title, url?, gist}], the work's memory of what the person decided and what arrived about it, capped at the newest 50 each; a write replaces the node, so resend the whole metadata when appending) and one bad item rejects the whole batch. Items with nodeType \"view\" are validated against the view contract (metadata renderer is one of graph, feed, code, timeline, board; filter is the same selection brain_list accepts, without limit or cursor), and a node's default view is declared by linking a default_view edge from it to the view with brain_link — its child_of descendants inherit it. Items with nodeType \"inbox_item\" are things waiting on the person's decision (see the inbox-ingest skill); with a hangar session's token, only a new key or an item this session filed may be written (any other rejects the whole batch), and the item is bound to the session: use sourceSystem \"inbox\" and externalId = the canonical artifact key (e.g. asana:task/<gid>, gmail:thread/<id>) so signals about the same artifact dedupe; content is the markdown the person reads (context, then the proposed draft); metadata is validated against the inbox contract (source required; status one of pending, changes, accepted, dismissed, done — a new item is always stored pending (undigested until its url is read), and accepted, changes, and dismissed are the person's decisions, which no agent write sets: sending one leaves the stored status as it is; action e.g. reply/create_task/comment/review/ignore; url; from; priority 0-4; verdict; links [{label,url}]; feedback is the person's decision history, written only by their decisions — whatever you send is ignored and the stored history kept; revision is the one-line note an agent leaves when it re-queues an item after the person's note; close_reason is why it closed one on the note). Link an inbox item to the work_item it is a decision about with brain_link edgeType \"about\" (weight = match confidence). A batch's candidates link child_of the batch item. Hangar sessions are reserved: an item with nodeType \"hangar_session\" or sourceSystem \"hangar\" rejects the whole batch, since only the hangar queue writes them; queue one with brain_hangar_request instead. Any item's metadata may carry occurred_at — the moment the item belongs at on a timeline — as an ISO-8601 timestamp carrying a zone (Z or ±HH:MM) or a date alone (UTC); it is stored canonically (UTC, milliseconds, e.g. 2026-03-04T08:00:00.000Z), null removes it, and an unparseable value rejects the whole batch naming the item.",
  schema: writeSchema,
  isWrite: true,
  async handler(ctx: ToolContext, args) {
    const items = toArray(args.items);
    const input: NodeInput[] = items.map((item, index) => {
      const nodeType = item.nodeType.trim();
      const sourceSystem = item.sourceSystem ?? AGENT_SOURCE_SYSTEM;
      // Hangar sessions are written only by packages/core/src/hangar.ts, so
      // no agent can forge a session or its state. Refused before any run
      // opens, so the batch persists nothing. The type and the source system
      // are each reserved on their own; hangar.ts's reads also require the
      // source system, as defense in depth.
      if (nodeType === HANGAR_SESSION_NODE_TYPE || sourceSystem.trim() === HANGAR_SOURCE_SYSTEM) {
        throw new ReservedHangarNodeError(`at batch index ${index} (${sourceSystem}/${item.externalId})`);
      }
      // The event-time, work-item, and view contracts are enforced here,
      // at the tool boundary, not in upsertNodes (knowledge-store spec,
      // work-items spec, node-views spec): a bad item rejects the whole
      // batch before any run is opened, naming the item and field. Event
      // time runs first and on every type, so a bad occurred_at on a
      // work item or view is named as occurred_at, not by its type's
      // contract.
      const itemLabel = `at batch index ${index} (${sourceSystem}/${item.externalId})`;
      const timed = normalizeOccurredAt(item.metadata, { itemLabel });
      const metadata =
        nodeType === WORK_ITEM_NODE_TYPE
          ? normalizeWorkItemMetadata(timed, { index })
          : nodeType === VIEW_NODE_TYPE
            ? normalizeViewMetadata(timed, { itemLabel })
            : nodeType === INBOX_ITEM_NODE_TYPE
              ? normalizeInboxItemMetadata(timed, { itemLabel })
              : timed;
      // Keys as the upsert stores them (trimmed), so every pre-read below
      // reads the row the upsert will write.
      return {
        nodeType: item.nodeType,
        externalId: item.externalId.trim(),
        sourceSystem: sourceSystem.trim(),
        title: item.title,
        content: item.content,
        metadata,
      };
    });

    // A session-bound caller (a hangar session's token) writes only new
    // inbox keys and its own session's items, never another session's, a
    // local pane's, or an ingested one (hangar-queue decision 9). Checked
    // before the run opens, so a refused batch writes nothing. That read
    // takes no lock, so the keys it found absent are checked again inside
    // the upsert's transaction (`beforeCommit`): one another writer inserted
    // in between comes back `updated`, and the batch rolls back.
    const session = ctx.hangarSessionId;
    const absent = session === null ? null : await assertSessionMayWriteInboxItems(ctx.db, session, input.map((n) => ({ nodeType: n.nodeType, sourceSystem: n.sourceSystem!, externalId: n.externalId })));

    // Inbox items: the person's decisions survive a re-ingest (inbox.ts,
    // carryForwardInboxDecisions) — read before the run opens, like every
    // other validation here.
    const inboxInputs = input.filter((n) => n.nodeType.trim() === INBOX_ITEM_NODE_TYPE);
    if (inboxInputs.length > 0) {
      const stored = await loadStoredInboxMetadata(ctx.db, inboxInputs.map((n) => ({ sourceSystem: n.sourceSystem!, externalId: n.externalId })));
      for (const n of inboxInputs) {
        n.metadata = carryForwardInboxDecisions(n.metadata ?? {}, stored.get(`${n.sourceSystem}\u0000${n.externalId}`) ?? null);
        // Bound to the writing session, as requestInboxItem binds it, so the
        // person's decision reaches that session's messages, not a pane.
        if (session !== null) {
          const { pane: _pane, socket: _socket, ...rest } = n.metadata;
          n.metadata = normalizeInboxItemMetadata({ ...rest, session });
        }
      }
    }

    const { ingestRunId, result } = await withAgentIngestRun(ctx.db, ctx.actor(), (run) =>
      upsertNodes(ctx.db, run, input, session === null || absent === null ? {} : { beforeCommit: (r) => assertSessionCreatedAbsentKeys(session, absent, r.rows) }),
    );

    return boundResponse(
      result.rows,
      (r) => r.id,
      (kept, meta) => ({
        ingestRunId,
        created: result.created,
        updated: result.updated,
        unchanged: result.unchanged,
        items: kept,
        truncated: meta.truncated,
        ...(meta.truncated
          ? {
              truncationNote:
                `The response-size budget was reached (created/updated/unchanged counts above are exact regardless). ` +
                (meta.droppedIds.length > 0 ? `${meta.droppedIds.length} result row(s) were dropped from this listing — fetch content with brain_get using droppedNodeIds. ` : "") +
                (meta.shrunkIds.length > 0 ? `${meta.shrunkIds.length} result row(s) had oversized fields truncated in place — droppedNodeIds does not apply to those.` : ""),
            }
          : {}),
        droppedNodeIds: meta.droppedIds,
        shrunkNodeIds: meta.shrunkIds,
      }),
      ctx.responseCharBudget,
    );
  },
};

// --- brain_link ------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidField = z.string().regex(UUID_RE, "must be a valid uuid (a node id returned by brain_search, brain_get, or brain_write)");

const edgeItemSchema = z.object({
  srcId: uuidField,
  dstId: uuidField,
  edgeType: z.string().min(1),
  /** Defaults to "agent" — see attribution.ts. */
  sourceSystem: z.string().min(1).optional(),
  weight: z.number().min(0).max(1).optional(),
  props: boundedRecordSchema(DEFAULT_MAX_METADATA_LENGTH, "props").optional(),
});

const linkSchema = z.object({
  items: z.union([edgeItemSchema, z.array(edgeItemSchema).min(1, "batch must contain at least one item").max(MAX_BATCH_ITEMS, `batch must contain at most ${MAX_BATCH_ITEMS} items`)]),
});

export const linkTool: ToolDef<typeof linkSchema> = {
  name: "brain_link",
  description:
    "Assert one edge, or a batch of edges in one call (pass items as a single object or an array, up to 1000 items), between existing node ids. Each edge is upserted on (srcId, dstId, edgeType, sourceSystem) — re-asserting the same edge just updates its weight/props. A `blocks` edge that would make a node transitively block itself is refused with the path, and nothing from the call is stored. weight defaults to 1.0 when omitted; sourceSystem defaults to \"agent\". All edges in one call share a single ingest run attributed to source_system='agent' and to this client as actor. Hangar sessions' edges are reserved: an edge under sourceSystem \"hangar\", or one whose srcId is a hangar session, rejects the whole call.",
  schema: linkSchema,
  isWrite: true,
  async handler(ctx: ToolContext, args) {
    const items = toArray(args.items);
    const input: EdgeInput[] = items.map((item) => ({
      srcId: item.srcId,
      dstId: item.dstId,
      edgeType: item.edgeType,
      sourceSystem: item.sourceSystem ?? AGENT_SOURCE_SYSTEM,
      weight: item.weight,
      props: item.props,
    }));
    // A session's work item is its `run_by` edge, written only by the hangar
    // queue (hangar.ts selectSessions counts only those). Refused before any
    // run opens, so the call persists nothing.
    await assertNoReservedHangarEdges(ctx.db, input.map((e) => ({ srcId: e.srcId, sourceSystem: e.sourceSystem! })));

    const { ingestRunId, result } = await withAgentIngestRun(ctx.db, ctx.actor(), (run) => upsertEdges(ctx.db, run, input));

    return boundResponse(
      result.rows,
      (r) => r.id,
      (kept, meta) => ({
        ingestRunId,
        created: result.created,
        updated: result.updated,
        items: kept,
        truncated: meta.truncated,
        ...(meta.truncated
          ? {
              truncationNote:
                `The response-size budget was reached (created/updated counts above are exact regardless). Edges have no brain_get equivalent — match ` +
                `dropped/shrunk edge ids against your own input items to see what they were.`,
            }
          : {}),
        droppedEdgeIds: meta.droppedIds,
        shrunkEdgeIds: meta.shrunkIds,
      }),
      ctx.responseCharBudget,
    );
  },
};

// --- brain_merge -----------------------------------------------------------

const mergeSchema = z.object({
  loserId: uuidField,
  survivorId: uuidField,
});

export const mergeTool: ToolDef<typeof mergeSchema> = {
  name: "brain_merge",
  description:
    "Merge a duplicate node (loserId) into a survivor (survivorId) — for when you notice two nodes describe the same thing (no similarity scoring runs automatically). Hangar sessions are never merged, as either id. Idempotent: merging a node that is already merged into the same survivor succeeds and changes nothing. Afterward, brain_get/brain_neighbors/brain_search on loserId resolve to survivorId. The merge is attributed to an ingest run (source_system 'agent', actor = this client), whose id is returned.",
  schema: mergeSchema,
  isWrite: true,
  async handler(ctx: ToolContext, args) {
    const { ingestRunId, result } = await withAgentIngestRun(ctx.db, ctx.actor(), (run) => mergeNodes(ctx.db, args.loserId, args.survivorId, run));
    return {
      ingestRunId,
      survivorId: result.survivorId,
      mergedNodeIds: result.mergedNodeIds,
      noOp: result.mergedNodeIds.length === 0,
    };
  },
};

// --- brain_update_work_item ------------------------------------------------

const nullableString = (max: number) => z.string().max(max).nullable().optional();

const updateWorkItemSchema = z.object({
  id: uuidField,
  status: z.enum(WORK_ITEM_STATUSES).optional(),
  priority: z.number().int().min(MIN_WORK_ITEM_PRIORITY).max(MAX_WORK_ITEM_PRIORITY).optional(),
  assignee: nullableString(MAX_ASSIGNEE_LENGTH),
  closedReason: nullableString(MAX_CLOSED_REASON_LENGTH),
  specId: nullableString(MAX_SPEC_ID_LENGTH),
  closedAt: z.string().datetime({ offset: true }).nullable().optional(),
});

export const updateWorkItemTool: ToolDef<typeof updateWorkItemSchema> = {
  name: "brain_update_work_item",
  description:
    "Change specific fields of a work_item node without re-sending its title or content: status (open, in_progress, blocked, closed, deferred), priority (0 most urgent to 4), " +
    "assignee, closedReason, specId, closedAt. Omitted fields are left alone; null removes a field. Closing stamps closedAt when you do not supply one; leaving closed clears " +
    "closedAt and closedReason. Applied in one transaction under a row lock, attributed to an ingest run (source_system 'agent', actor = this client), and recorded in the node's " +
    "history. An id naming a merged-away node patches its survivor. Refused for nodes that are not work items.",
  schema: updateWorkItemSchema,
  isWrite: true,
  async handler(ctx: ToolContext, args) {
    const patch: WorkItemPatch = {
      status: args.status,
      priority: args.priority,
      assignee: args.assignee,
      closedReason: args.closedReason,
      specId: args.specId,
      closedAt: args.closedAt,
    };
    const { ingestRunId, result } = await withAgentIngestRun(ctx.db, ctx.actor(), (run) => patchWorkItem(ctx.db, run, args.id, patch));
    return {
      ingestRunId,
      id: result.id,
      requestedId: result.requestedId,
      resolvedFromMerge: result.id !== result.requestedId,
      action: result.action,
      before: result.before,
      after: result.after,
    };
  },
};

export const writeTools: ToolDef[] = [writeTool, linkTool, mergeTool, updateWorkItemTool];
