// timeline-view, tasks.md 2.3: the `timeline` procedure the timeline view
// draws an anchor's history from, proven through the real router chain
// (Zod -> packages/core -> mapCoreError -> the response budget), the
// boundary the client depends on. packages/core/src/timeline.test.ts
// covers the read itself — the fold, the one-row-per-node rule, the
// narrowing, the paging — and is trusted, not re-proven, here.
//
// Every fixture carries this file's own unique source system and every
// test prefixes its external ids with a fresh `fx()`, so nothing here is
// asserted store-wide (views.test.ts's header on why; `bd memories
// test-no-run-opened-assertions` on why ingest_runs is never asserted on).

import { randomUUID } from "node:crypto";
import { closeIngestRun, normalizeOccurredAt, openIngestRun, upsertEdges, upsertNodes, type IngestRunHandle } from "@breakdown/core";
import { createDb, createPool, edges, ingestRuns, nodes, resolveDatabaseUrl, type Database } from "@breakdown/db";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Context } from "../context.js";
import { appRouter } from "../router.js";
import { createCallerFactory } from "../trpc.js";

let pool: ReturnType<typeof createPool>;
let db: Database;
let run: IngestRunHandle;

const SRC = `tl-timeline-router-test-${randomUUID().replace(/-/g, "")}`;
const fx = () => `fx-${randomUUID().replace(/-/g, "")}`;
const NO_NODE_ID = "00000000-0000-4000-8000-000000000000";

beforeAll(async () => {
  pool = createPool(resolveDatabaseUrl());
  db = createDb(pool);
  run = await openIngestRun(db, SRC, { actor: "timeline-router-suite" });
});

afterAll(async () => {
  await closeIngestRun(db, run);
  await db.delete(edges).where(eq(edges.sourceSystem, SRC));
  await db.delete(nodes).where(eq(nodes.sourceSystem, SRC));
  await db.delete(ingestRuns).where(inArray(ingestRuns.id, [run.id]));
  await pool.end();
});

const createCaller = createCallerFactory(appRouter);

function callerWith(dbInstance: Database) {
  const ctx: Context = { db: dbInstance };
  return createCaller(ctx);
}

function caller() {
  return callerWith(db);
}

/** Throws on any property access — proves Zod rejected the call before the resolver ran (write.test.ts's own device). */
function poisonedDb(): Database {
  return new Proxy(
    {},
    {
      get() {
        throw new Error("ctx.db should never be touched for a request rejected by validation before any database call");
      },
    },
  ) as Database;
}

async function writeNode(externalId: string, nodeType: string, metadata: Record<string, unknown> = {}): Promise<string> {
  const result = await upsertNodes(db, run, [{ nodeType, sourceSystem: SRC, externalId, title: `${nodeType} ${externalId}`, content: `content of ${externalId}`, metadata: normalizeOccurredAt(metadata) }]);
  const row = result.rows[0];
  if (!row) throw new Error("fixture insert returned no row");
  return row.id;
}

async function link(srcId: string, dstId: string, edgeType: string, weight?: number): Promise<void> {
  await upsertEdges(db, run, [{ srcId, dstId, edgeType, sourceSystem: SRC, weight }]);
}

/** A repository with a March issue, a June issue, and an untimed file, all `belongs-to` the repository. */
async function repositoryFixture(): Promise<{ repo: string; march: string; june: string; file: string; prefix: string }> {
  const prefix = fx();
  const repo = await writeNode(`${prefix}/repo`, "repo", { occurred_at: "2025-12-01T00:00:00Z" });
  const march = await writeNode(`${prefix}/issue-1`, "gh-issue", { occurred_at: "2026-03-04T10:00:00+02:00", number: 1, url: "https://github.com/example/repo/issues/1" });
  const june = await writeNode(`${prefix}/issue-2`, "gh-issue", { occurred_at: "2026-06-15T12:30:00Z", number: 2, url: "https://github.com/example/repo/issues/2" });
  const file = await writeNode(`${prefix}/readme.md`, "file", { path: "readme.md" });
  await link(march, repo, "belongs-to", 0.75);
  await link(june, repo, "belongs-to", 0.75);
  await link(file, repo, "belongs-to", 0.5);
  return { repo, march, june, file, prefix };
}

describe("timeline (local-web-api spec, 'Reading an anchor's timeline')", () => {
  it("round-trips a repository's timed neighbours newest first with metadata, edge type, direction, the untimed count, and no content on the wire", async () => {
    const { repo, march, june, prefix } = await repositoryFixture();

    const result = await caller().timeline({ anchorId: repo, nodeTypes: ["gh-issue", "file"] });
    expect(result.anchorId).toBe(repo);
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
    expect(result.untimedCount).toBe(1);
    expect(result.truncated).toBe(false);
    expect(result.droppedNodeIds).toEqual([]);
    expect(result.shrunkNodeIds).toEqual([]);
    expect(result.rows).toEqual([
      {
        id: june,
        nodeType: "gh-issue",
        sourceSystem: SRC,
        externalId: `${prefix}/issue-2`,
        title: `gh-issue ${prefix}/issue-2`,
        occurredAt: "2026-06-15T12:30:00.000Z",
        metadata: { occurred_at: "2026-06-15T12:30:00.000Z", number: 2, url: "https://github.com/example/repo/issues/2" },
        edgeType: "belongs-to",
        direction: "incoming",
        weight: 0.75,
      },
      {
        id: march,
        nodeType: "gh-issue",
        sourceSystem: SRC,
        externalId: `${prefix}/issue-1`,
        title: `gh-issue ${prefix}/issue-1`,
        occurredAt: "2026-03-04T08:00:00.000Z",
        metadata: { occurred_at: "2026-03-04T08:00:00.000Z", number: 1, url: "https://github.com/example/repo/issues/1" },
        edgeType: "belongs-to",
        direction: "incoming",
        weight: 0.75,
      },
    ]);
    for (const row of result.rows) {
      expect(row).not.toHaveProperty("content");
    }

    // Narrowed to issues, the untimed file is neither listed nor counted.
    const issues = await caller().timeline({ anchorId: repo, nodeTypes: ["gh-issue"] });
    expect(issues.rows.map((r) => r.id)).toEqual([june, march]);
    expect(issues.untimedCount).toBe(0);
  });

  it("continues from the returned cursor without repeating or skipping a row", async () => {
    const { repo, march, june } = await repositoryFixture();

    const first = await caller().timeline({ anchorId: repo, limit: 1 });
    expect(first.rows.map((r) => r.id)).toEqual([june]);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toEqual({ occurredAt: "2026-06-15T12:30:00.000Z", id: june });
    expect(first.untimedCount).toBe(1);

    const second = await caller().timeline({ anchorId: repo, limit: 1, cursor: first.nextCursor! });
    expect(second.rows.map((r) => r.id)).toEqual([march]);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeNull();
    expect(second.untimedCount).toBe(1);
  });

  it("maps an unknown anchor to NOT_FOUND and a malformed one to BAD_REQUEST", async () => {
    await expect(caller().timeline({ anchorId: NO_NODE_ID })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller().timeline({ anchorId: "not-a-uuid" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects an empty anchor, an over-limit page, an empty name list, and a malformed cursor at the Zod boundary — ctx.db is never touched", async () => {
    const poisoned = callerWith(poisonedDb());
    await expect(poisoned.timeline({ anchorId: "" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(poisoned.timeline({ anchorId: NO_NODE_ID, limit: 501 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(poisoned.timeline({ anchorId: NO_NODE_ID, limit: 0 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(poisoned.timeline({ anchorId: NO_NODE_ID, nodeTypes: [] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(poisoned.timeline({ anchorId: NO_NODE_ID, sourceSystems: [""] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(poisoned.timeline({ anchorId: NO_NODE_ID, cursor: { occurredAt: "", id: NO_NODE_ID } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
