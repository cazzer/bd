// The relay's beads push (laptop-relay design.md decisions 4 and 9): the
// beads watcher (beads-watcher.ts) runs here against this Mac's checkouts
// with this module as its `ingest`, so the scheduling — fingerprints,
// debounce, the 30 s tick — is the server's own. A load computes the
// checkout's export with core's `computeBeadsIngest` through the
// allowlisted ingest runner (runners.ts) and pushes it to
// `POST /relay/v1/beads-ingest`; Breakdown applies it and its watcher's
// `record` sends open boards the same events a local load would.
//
// `priorThreads` is an in-memory cache per project of the review threads
// last pushed, keyed by issue id with the `comment_count` they were
// fetched at, so an unchanged thread is not fetched again (the store plays
// this part for a local ingest). It is replaced only by a push Breakdown
// accepted, so a failed push re-fetches nothing it would not have.
//
// A body over the server's cap is refused here, before sending, with the
// size and the cap, rather than sent to be cut off with a 413.

import { computeBeadsIngest, type PriorReviewThread, type PriorReviewThreads, type RunBd } from "@breakdown/core";
import type { BeadsIngestRequest, LoadResult } from "../beads-watcher.js";
import { MAX_RELAY_PUSH_BYTES } from "../relay-api.js";
import type { RelayClient } from "./client.js";

/** A push gets this long: the server applies a whole export in one transaction. */
export const PUSH_TIMEOUT_MS = 120_000;

export interface PushSinkOptions {
  client: Pick<RelayClient, "send">;
  /** The allowlisted ingest runner for one project (runners.ts `ingestBdFor`). */
  runBdFor(project: string): RunBd;
  maxBytes?: number;
}

export interface PushSink {
  /** The watcher's `ingest`: compute the export of `dir`, push it, and answer what Breakdown applied. */
  push(request: BeadsIngestRequest): Promise<LoadResult>;
}

function counts(value: unknown): { created: number; updated: number; unchanged: number } {
  const v = (value ?? {}) as Record<string, unknown>;
  const n = (k: string) => (typeof v[k] === "number" ? (v[k] as number) : 0);
  return { created: n("created"), updated: n("updated"), unchanged: n("unchanged") };
}

export function createPushSink({ client, runBdFor, maxBytes = MAX_RELAY_PUSH_BYTES }: PushSinkOptions): PushSink {
  const threads = new Map<string, Map<string, PriorReviewThread>>();

  return {
    async push({ dir, project, signal }) {
      const cache = threads.get(project);
      const priorThreads: PriorReviewThreads = async (issues) => {
        const found = new Map<string, PriorReviewThread>();
        for (const issue of issues) {
          const thread = cache?.get(issue.id);
          if (thread !== undefined) found.set(issue.id, thread);
        }
        return found;
      };
      const computed = await computeBeadsIngest(runBdFor(project), dir, { priorThreads, ...(signal === undefined ? {} : { signal }) });
      const body = JSON.stringify({ project_key: project, path: dir, issues: computed.issues, comments: computed.comments });
      const bytes = Buffer.byteLength(body, "utf8");
      if (bytes > maxBytes) {
        throw new Error(`the beads export of ${project} is ${bytes} bytes, over the server's push cap of ${maxBytes} bytes (8 MiB); it was not sent`);
      }
      const answer = (await client.send("POST", "/relay/v1/beads-ingest", body, { timeoutMs: PUSH_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) })) as Record<string, unknown> | null;

      const next = new Map<string, PriorReviewThread>();
      for (const issue of computed.issues) {
        const thread = computed.comments[issue.id];
        if (thread !== undefined && typeof issue.comment_count === "number") next.set(issue.id, { count: issue.comment_count, comments: thread });
      }
      threads.set(project, next);

      const edges = counts(answer?.["edges"]);
      return {
        changed: answer?.["changed"] === true,
        changedNodeIds: Array.isArray(answer?.["changed_node_ids"]) ? (answer["changed_node_ids"] as unknown[]).filter((id): id is string => typeof id === "string") : [],
        nodes: counts(answer?.["nodes"]),
        edges: { created: edges.created, updated: edges.updated },
      };
    },
  };
}
