// code-view, tasks.md 1.3: the `tree` procedure the code view draws a
// repository from, proven through the real router chain (Zod ->
// packages/core -> the error mapping), the boundary the client depends
// on. packages/core/src/tree.test.ts covers the walk itself — the fold,
// the cycle guard, the bounds — and is trusted, not re-proven, here.
//
// The fixture is a tree written through `loadGitRepoTree` under this
// file's own unique repository key, so every external id starts with
// `<key>:` and nothing here is asserted store-wide (views.test.ts's
// header on why; `bd memories test-no-run-opened-assertions` on why
// ingest_runs is never asserted on).

import { randomUUID } from "node:crypto";
import { buildRepoTree, closeIngestRun, GIT_SOURCE_SYSTEM, gitExternalId, loadGitRepoTree, openIngestRun, type IngestRunHandle, type LoadableFile } from "@breakdown/core";
import { createDb, createPool, ingestRuns, nodes, resolveDatabaseUrl, type Database } from "@breakdown/db";
import { and, eq, inArray, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Context } from "../context.js";
import { appRouter } from "../router.js";
import { createCallerFactory } from "../trpc.js";

let pool: ReturnType<typeof createPool>;
let db: Database;
let run: IngestRunHandle;

const PREFIX = `cv-tree-router-test-${randomUUID().replace(/-/g, "")}`;
const SHA = (c: string): string => c.repeat(40);

function fixtureFiles(): LoadableFile[] {
  return [
    { path: "apps/web/index.html", blobSha: SHA("1"), sizeBytes: 15, text: "<html></html>\n" },
    { path: "packages/core/src/route.ts", blobSha: SHA("2"), sizeBytes: 40, text: `export const ident${PREFIX.slice(-8)} = 1;\n` },
    { path: "readme.md", blobSha: SHA("3"), sizeBytes: 20, text: "# Fixture\n" },
  ];
}

beforeAll(async () => {
  pool = createPool(resolveDatabaseUrl());
  db = createDb(pool);
  run = await openIngestRun(db, GIT_SOURCE_SYSTEM, { actor: "tree-router-suite" });
});

afterAll(async () => {
  await closeIngestRun(db, run);
  await db.delete(nodes).where(and(eq(nodes.sourceSystem, GIT_SOURCE_SYSTEM), like(nodes.externalId, `${PREFIX}%`)));
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

describe("tree (local-web-api spec, 'Reading a repository's tree')", () => {
  it("round-trips a loaded tree with parent ids, path and language, truncated false, and no content on the wire", async () => {
    const key = `${PREFIX}/basic`;
    const loaded = await loadGitRepoTree(db, run, buildRepoTree(key, `/checkout/${key}`, fixtureFiles()));
    const idOf = (path?: string): string => loaded.nodes.rows.find((r) => r.externalId === gitExternalId(key, path))!.id;
    const rootId = idOf();

    const result = await caller().tree({ rootId });
    expect(result.rootId).toBe(rootId);
    expect(result.truncated).toBe(false);
    // root, then depth 1 by title, then depth 2, then 3, then 4.
    expect(result.nodes.map((n) => n.externalId)).toEqual(
      ["", "apps", "packages", "readme.md", "packages/core", "apps/web", "apps/web/index.html", "packages/core/src", "packages/core/src/route.ts"].map((p) => gitExternalId(key, p || undefined)),
    );
    expect(result.nodes[0]).toEqual({ id: rootId, parentId: null, nodeType: "repo", title: key, externalId: key, path: null, language: null });
    expect(result.nodes.find((n) => n.id === idOf("packages/core/src/route.ts"))).toEqual({
      id: idOf("packages/core/src/route.ts"),
      parentId: idOf("packages/core/src"),
      nodeType: "file",
      title: "route.ts",
      externalId: gitExternalId(key, "packages/core/src/route.ts"),
      path: "packages/core/src/route.ts",
      language: "typescript",
    });
    expect(result.nodes.find((n) => n.id === idOf("apps/web"))).toMatchObject({ parentId: idOf("apps"), nodeType: "directory", language: null });
    for (const row of result.nodes) {
      expect(row).not.toHaveProperty("content");
      expect(row).not.toHaveProperty("metadata");
    }
  });

  it("maps an unknown root and a malformed root to BAD_REQUEST", async () => {
    await expect(caller().tree({ rootId: "00000000-0000-4000-8000-000000000000" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller().tree({ rootId: "not-a-uuid" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects an empty root at the Zod boundary — ctx.db is never touched", async () => {
    await expect(callerWith(poisonedDb()).tree({ rootId: "" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
