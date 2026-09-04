// Unit coverage of the error-mapping table itself: one test per
// `@breakdown/core` error class mapError() knows about, constructed
// directly (no database, no protocol round trip — server.test.ts already
// exercises a realistic subset of these end-to-end). Confirms each maps
// to a message that (a) is not a raw stack trace and (b) tells the model
// what to do, not just what broke.

import {
  ContentTooLargeError,
  DuplicateEdgeInBatchError,
  DuplicateNodeInBatchError,
  EdgeUpsertFailedError,
  EmptyQueryError,
  InvalidEdgeInputError,
  InvalidEdgeWeightError,
  InvalidEventTimeError,
  InvalidIngestRunError,
  InvalidLookupIdError,
  InvalidLookupOptionError,
  NotAWorkItemError,
  InvalidViewError,
  InvalidWorkItemError,
  InvalidListOptionError,
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
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DrizzleQueryError } from "drizzle-orm";
import { formatZodError, mapError } from "./errors.js";

/** A raw stack trace line looks like "    at functionName (file:line:col)". */
const STACK_LINE = /\s+at\s+\S+\s+\(/;

function textOf(result: ReturnType<typeof mapError>): string {
  const first = result.content[0];
  if (!first || first.type !== "text") throw new Error("expected text content");
  return first.text;
}

describe("mapError", () => {
  it("is always isError: true with a single text block", () => {
    const result = mapError("brain_write", new NodeNotFoundError("x"));
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe("text");
  });

  it("maps ContentTooLargeError: names the item and says what to do", () => {
    const text = textOf(mapError("brain_write", new ContentTooLargeError(2, "github", "issue-1", 5000, 1000)));
    expect(text).toContain("batch index 2");
    expect(text).toContain("github/issue-1");
    expect(text).toMatch(/shorten|split/i);
    expect(text).not.toMatch(STACK_LINE);
  });

  it("maps InvalidNodeContentError: names the field and position", () => {
    const text = textOf(mapError("brain_write", new InvalidNodeContentError(0, "github", "issue-1", "title", 4, 0)));
    expect(text).toContain("title");
    expect(text).toMatch(/control character/i);
    expect(text).not.toMatch(STACK_LINE);
  });

  it("maps DuplicateNodeInBatchError: names both indexes and says the key must be unique", () => {
    const text = textOf(mapError("brain_write", new DuplicateNodeInBatchError("github", "issue-1", 0, 3)));
    expect(text).toContain("indexes 0 and 3");
    expect(text).toMatch(/unique/i);
  });

  it("maps InvalidNodeInputError: names the batch index", () => {
    const text = textOf(mapError("brain_write", new InvalidNodeInputError("nodeType must be a non-empty string", 1, "github", "issue-1")));
    expect(text).toContain("batch index 1");
  });

  it("maps NodeUpsertFailedError: tells the model to retry, not to fix its input", () => {
    const text = textOf(mapError("brain_write", new NodeUpsertFailedError("db write failed", 0, 4, { cause: new Error("connection reset") })));
    expect(text).toMatch(/database problem/i);
    expect(text).toMatch(/retry/i);
    expect(text).not.toMatch(STACK_LINE);
  });

  it("maps InvalidEdgeWeightError: names the offending edge and the valid range", () => {
    const text = textOf(mapError("brain_link", new InvalidEdgeWeightError(0, "src", "dst", "mentions", "agent", 1.4)));
    expect(text).toContain("weight 1.4");
    expect(text).toMatch(/between 0 and 1/i);
  });

  it("maps DuplicateEdgeInBatchError: names both indexes", () => {
    const text = textOf(mapError("brain_link", new DuplicateEdgeInBatchError("src", "dst", "mentions", "agent", 0, 2)));
    expect(text).toContain("indexes 0 and 2");
  });

  it("maps InvalidEdgeInputError: names the batch index and suggests brain_get to verify ids", () => {
    const text = textOf(mapError("brain_link", new InvalidEdgeInputError("srcId is not a valid uuid", 0, "bad", "dst", "mentions", "agent")));
    expect(text).toContain("batch index 0");
    expect(text).toMatch(/brain_get/);
  });

  it("maps EdgeUpsertFailedError wrapping a genuine database failure (no pg foreign-key code): tells the model to retry, no brain_get steer", () => {
    // A deadlock or connectivity failure — not a caller mistake, so
    // retrying the same call can succeed once the transient condition
    // clears, unlike a foreign-key violation (see the next test).
    const text = textOf(mapError("brain_link", new EdgeUpsertFailedError("deadlock detected", 0, 1, { cause: { code: "40P01" } })));
    expect(text).toMatch(/database problem/i);
    expect(text).toMatch(/retry/i);
    expect(text).not.toMatch(/brain_get/);
  });

  it("maps EdgeUpsertFailedError wrapping a postgres foreign-key violation (23503) to input-fixing guidance, not a contradictory retry hint (bd-vt2.5 review: the two sentences disagreed)", () => {
    const text = textOf(
      mapError(
        "brain_link",
        new EdgeUpsertFailedError("insert failed", 0, 1, {
          cause: { code: "23503", constraint: "edges_src_id_fkey", detail: 'Key (src_id)=(00000000-0000-0000-0000-000000000000) is not present in table "nodes".' },
        }),
      ),
    );
    expect(text).toMatch(/brain_get/);
    expect(text).toMatch(/input problem/i);
    // The contradiction the review found: telling the model to retry a
    // call that will deterministically fail again with the same ids.
    expect(text).not.toMatch(/you may retry the call/i);
  });

  it("maps SelfMergeError: suggests a different survivorId", () => {
    const text = textOf(mapError("brain_merge", new SelfMergeError("a", "a")));
    expect(text).toMatch(/itself/i);
    expect(text).toMatch(/survivorId/);
  });

  it("maps MergeFailedError: tells the model to retry", () => {
    const text = textOf(mapError("brain_merge", new MergeFailedError("deadlock", "a", "b", { cause: new Error("40P01") })));
    expect(text).toMatch(/database problem/i);
    expect(text).toMatch(/retry/i);
  });

  it("maps NodeNotFoundError (shared by brain_merge and brain_neighbors): suggests brain_search/brain_map/brain_get", () => {
    const text = textOf(mapError("brain_neighbors", new NodeNotFoundError("00000000-0000-0000-0000-000000000000")));
    expect(text).toMatch(/does not exist/i);
    expect(text).toMatch(/brain_search|brain_map|brain_get/);
  });

  it("maps InvalidRetrievalOptionError: names the option and its value", () => {
    const text = textOf(mapError("brain_search", new InvalidRetrievalOptionError("minRelevance", 0, "must be a positive number")));
    expect(text).toContain("minRelevance");
    expect(text).toMatch(/adjust/i);
  });

  it("maps EmptyQueryError: says to provide a meaningful search term", () => {
    const text = textOf(mapError("brain_search", new EmptyQueryError("the of and")));
    expect(text).toMatch(/no searchable terms/i);
    expect(text).toMatch(/search term/i);
  });

  it("maps RetrievalFailedError: tells the model to retry", () => {
    const text = textOf(mapError("brain_search", new RetrievalFailedError("query failed", "exact", { cause: new Error("timeout") })));
    expect(text).toMatch(/database problem/i);
  });

  it("maps InvalidLookupIdError: says ids must be uuids from another tool", () => {
    const text = textOf(mapError("brain_get", new InvalidLookupIdError("not-a-uuid", "must be a valid uuid")));
    expect(text).toContain("not-a-uuid");
    expect(text).toMatch(/uuid/i);
  });

  it("maps InvalidLookupOptionError (brain_history's limit/before): names the option and says to adjust it", () => {
    const text = textOf(mapError("brain_history", new InvalidLookupOptionError("before", 0, "must be a positive integer")));
    expect(text).toContain("before");
    expect(text).toMatch(/adjust/i);
    expect(text).not.toMatch(STACK_LINE);
  });

  it("maps LookupFailedError: tells the model to retry", () => {
    const text = textOf(mapError("brain_get", new LookupFailedError("query failed", "getNodes", { cause: new Error("timeout") })));
    expect(text).toMatch(/database problem/i);
  });

  it("maps InvalidIngestRunError as a server-side setup problem", () => {
    const text = textOf(mapError("brain_write", new InvalidIngestRunError("sourceSystem must be a non-empty string")));
    expect(text).toMatch(/server-side/i);
  });

  it("maps an unrecognized KnowledgeStoreError subclass safely (never crashes, never a bare 'internal error')", () => {
    class SomeFutureError extends KnowledgeStoreError {}
    const text = textOf(mapError("brain_search", new SomeFutureError("a new failure mode")));
    expect(text).toContain("SomeFutureError");
    expect(text).toContain("a new failure mode");
    expect(text.toLowerCase()).not.toBe("internal error");
  });

  it("maps a Zod validation error to a message naming the offending field(s)", () => {
    const schema = z.object({ query: z.string().min(1, "must not be empty") });
    const parseResult = schema.safeParse({ query: "" });
    expect(parseResult.success).toBe(false);
    const text = textOf(formatZodError("brain_search", parseResult.error!));
    expect(text).toContain("query");
    expect(text).toContain("must not be empty");
    expect(text).not.toMatch(STACK_LINE);
  });

  it("maps a truly unrecognized error (not a KnowledgeStoreError) to a safe generic message, never a raw stack trace", () => {
    const weird = new TypeError("Cannot read properties of undefined (reading 'foo')");
    const text = textOf(mapError("brain_search", weird));
    expect(text).toMatch(/unexpectedly/i);
    expect(text).toMatch(/server-side/i);
    expect(text).not.toMatch(STACK_LINE);
    // The message content itself is allowed through (it can help
    // diagnosis) but the stack must not be — Error#stack always contains
    // "\n    at ", which STACK_LINE catches structurally regardless of
    // exact wording, so this also guards against a future refactor that
    // starts interpolating err.stack instead of err.message.
  });

  it("maps a non-Error thrown value without crashing", () => {
    const text = textOf(mapError("brain_search", "a plain string throw"));
    expect(text).toContain("a plain string throw");
    expect(text).not.toMatch(STACK_LINE);
  });
});


describe("mapError: work-items change", () => {
  it("maps the blocks-acyclic trigger's check violation to a cycle explanation that says nothing was stored", () => {
    const pgError = Object.assign(new Error("blocks edge x -> y would form a cycle"), { code: "23514", detail: "path: y -> x -> y" });
    const err = new EdgeUpsertFailedError("edge x -[blocks]-> y (batch index 0) failed to write (postgres: 23514 - path: y -> x -> y)", 0, 0, { cause: pgError });
    const result = mapError("brain_link", err);
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/would make a node transitively block itself/);
    expect(text).toMatch(/Nothing from this call was stored/);
    expect(text).toContain("path: y -> x -> y");
  });

  it("maps InvalidListOptionError, InvalidWorkItemError, and NotAWorkItemError to actionable messages", () => {
    const list = (mapError("brain_list", new InvalidListOptionError("where[0].op", "like", "must be equals or oneOf")).content[0] as { text: string }).text;
    expect(list).toMatch(/where\[0\]\.op/);
    expect(list).toMatch(/oneOf/);

    const item = (mapError("brain_write", new InvalidWorkItemError("priority", 7, "must be an integer from 0 to 4", 1)).content[0] as { text: string }).text;
    expect(item).toMatch(/batch index 1/);
    expect(item).toMatch(/nothing from this call was persisted/i);

    const notItem = (mapError("brain_update_work_item", new NotAWorkItemError("00000000-0000-4000-8000-000000000000", "note")).content[0] as { text: string }).text;
    expect(notItem).toMatch(/not a work item/);
    expect(notItem).toMatch(/brain_write/);
  });

  it("maps InvalidViewError to a message naming the item, the field, and what a valid view carries", () => {
    const text = (mapError("brain_write", new InvalidViewError("at batch index 2 (agent/open-work)", "renderer", "kanban", "must be one of graph, feed, code, timeline")).content[0] as { text: string }).text;
    expect(text).toMatch(/batch index 2 \(agent\/open-work\)/);
    expect(text).toMatch(/renderer \(got "kanban"\)/);
    expect(text).toMatch(/nothing from this call was persisted/i);
    expect(text).toMatch(/graph, feed, code, timeline/);
    expect(text).toMatch(/without limit or cursor/);
  });

  it("maps InvalidEventTimeError to a message naming the item, occurred_at, and the canonical form (timeline-view)", () => {
    const text = (mapError("brain_write", new InvalidEventTimeError("at batch index 0 (agent/late)", "last Tuesday", "must parse as an instant")).content[0] as { text: string }).text;
    expect(text).toMatch(/batch index 0 \(agent\/late\)/);
    expect(text).toMatch(/occurred_at \(got "last Tuesday"\)/);
    expect(text).toMatch(/nothing from this call was persisted/i);
    expect(text).toContain("2026-03-04T08:00:00.000Z");
    expect(text).not.toMatch(STACK_LINE);
  });
});


describe("mapError: driver errors that escaped core", () => {
  it("never echoes drizzle's SQL-and-params message; it emits only the retry hint", () => {
    const err = new DrizzleQueryError("SELECT secret FROM nodes WHERE id = $1", ["00000000-0000-4000-8000-000000000000"], new Error("connection reset"));
    const result = mapError("brain_update_work_item", err);
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).not.toContain("SELECT secret");
    expect(text).not.toContain("params");
    expect(text).toMatch(/you may retry/);
  });
});
