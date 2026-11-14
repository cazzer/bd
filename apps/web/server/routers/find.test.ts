// search-results-view, tasks.md 2.3: the `find` read the results view
// calls, proven through the real router chain (Zod -> packages/core ->
// mapCoreError -> the response budget). packages/core/src/find.test.ts
// covers matching, facets, and paging in isolation and is trusted, not
// re-proven, here.
//
// The database is shared with every other test file and with real data, so
// every fixture carries this file's own source system, project, and
// alphabetic text tokens, and nothing is asserted store-wide.

import { randomUUID } from "node:crypto";
import { closeIngestRun, openIngestRun, upsertNodes, type IngestRunHandle } from "@breakdown/core";
import { createDb, createPool, ingestRuns, nodes, resolveDatabaseUrl, type Database } from "@breakdown/db";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Context } from "../context.js";
import { appRouter } from "../router.js";
import { nextFindOffset } from "./read.js";
import { createCallerFactory } from "../trpc.js";

const SUFFIX = randomUUID().replace(/-/g, "");
const SRC = `find-router-test-${SUFFIX}`;
const P = `find-router-p-${SUFFIX}`;
const TYPE = `find-router-type-${SUFFIX}`;
const word = () => randomUUID().replace(/-/g, "").replace(/\d/g, (d) => "ghijklmnop"[Number(d)] ?? "g");
const TOKEN = word();
const BUDGET = word();
const BUDGET_ROWS = 12;

let pool: ReturnType<typeof createPool>;
let db: Database;
let run: IngestRunHandle;

type Spec = { externalId: string; nodeType?: string; title: string; metadata: Record<string, unknown> };

async function write(spec: Spec): Promise<void> {
  await upsertNodes(db, run, [{ sourceSystem: SRC, nodeType: spec.nodeType ?? TYPE, externalId: spec.externalId, title: spec.title, content: `content of ${spec.externalId}`, metadata: spec.metadata }]);
}

beforeAll(async () => {
  pool = createPool(resolveDatabaseUrl());
  db = createDb(pool);
  run = await openIngestRun(db, SRC, { actor: "find-router-suite" });
  // One at a time, oldest first: a single batch shares one updated_at.
  const specs: Spec[] = [
    { externalId: "rev-old", title: `old review ${TOKEN}`, metadata: { project: P, labels: ["review"], status: "closed", closed_at: "2026-02-03T04:05:06.000Z", comments: ["never on the wire"] } },
    { externalId: "rev-mid", title: `mid review ${TOKEN}`, metadata: { project: P, labels: ["review", "ui"], status: "open" } },
    { externalId: "plain", title: `plain item ${TOKEN}`, metadata: { project: P, labels: ["ui"], status: "open" } },
    { externalId: "rev-new", nodeType: "work_item", title: `new review ${TOKEN}`, metadata: { project: P, labels: ["review"], status: "in_progress" } },
  ];
  for (const spec of specs) await write(spec);
  const longTitle = (i: number) => `${BUDGET} ${String(i).padStart(2, "0")} ${"x".repeat(460)}`;
  for (let i = 0; i < BUDGET_ROWS; i += 1) await write({ externalId: `budget-${i}`, title: longTitle(i), metadata: {} });
});

afterAll(async () => {
  await closeIngestRun(db, run);
  await db.delete(nodes).where(eq(nodes.sourceSystem, SRC));
  await db.delete(ingestRuns).where(inArray(ingestRuns.id, [run.id]));
  await pool.end();
});

const createCaller = createCallerFactory(appRouter);

function caller(extra: Partial<Context> = {}) {
  return createCaller({ db, ...extra });
}

/** Throws on any property access — proves Zod rejected the call before the resolver ran. */
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

describe("find (local-web-api spec, 'Finding nodes serves the search results view')", () => {
  it("lists a project's reviews with no text, newest first, with summary fields and facets", async () => {
    const result = await caller().find({ projects: [P], reviewsOnly: true });
    expect(result.nodes.map((n) => n.externalId)).toEqual(["rev-new", "rev-mid", "rev-old"]);
    expect(result.total).toBe(3);
    expect(result.hasMore).toBe(false);
    expect(result.nextOffset).toBeNull();
    expect(result.defaultsUsed).toEqual({ limit: 50 });
    expect(result.facets.reviews).toBe(3);
    expect(result.facets.projects[0]).toEqual({ value: P, count: 3 });
    expect(result.facets.nodeTypes).toEqual(
      expect.arrayContaining([
        { value: TYPE, count: 2 },
        { value: "work_item", count: 1 },
      ]),
    );

    const old = result.nodes[2];
    expect(old).toMatchObject({ project: P, status: "closed", closedAt: "2026-02-03T04:05:06.000Z", isReview: true, snippet: null, sourceSystem: SRC });
    expect(typeof old?.updatedAt).toBe("string");
    expect(Object.keys(old ?? {}).sort()).toEqual(
      ["closedAt", "externalId", "id", "isReview", "nodeType", "project", "snippet", "sourceSystem", "status", "title", "updatedAt"].sort(),
    );
    expect(JSON.stringify(result)).not.toContain("never on the wire");
  });

  it("highlights a snippet when there is text and maps stopword-only text to BAD_REQUEST", async () => {
    const result = await caller().find({ text: `  ${TOKEN}  `, projects: [P] });
    expect(result.total).toBe(4);
    for (const n of result.nodes) expect(n.snippet).toContain(`[[`);
    await expect(caller().find({ text: "the of and" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("drops an over-budget page from the tail, reports more, and the next offset resumes at the first dropped row", async () => {
    const full = await caller().find({ text: BUDGET, limit: 50 });
    expect(full.nodes).toHaveLength(BUDGET_ROWS);
    expect(full.truncated).toBe(false);

    const first = await caller({ responseCharBudget: 4000 }).find({ text: BUDGET, limit: 50 });
    expect(first.truncated).toBe(true);
    expect(first.hasMore).toBe(true);
    expect(first.nodes.length).toBeGreaterThan(0);
    expect(first.nodes.length).toBeLessThan(BUDGET_ROWS);
    expect(first.nextOffset).toBe(first.nodes.length);
    expect(first.droppedNodeIds[0]).toBe(full.nodes[first.nodes.length]?.id);
    expect(first.total).toBe(BUDGET_ROWS);

    const seen = first.nodes.map((n) => n.id);
    let offset = first.nextOffset;
    for (let guard = 0; offset !== null && guard < BUDGET_ROWS; guard += 1) {
      const page = await caller({ responseCharBudget: 4000 }).find({ text: BUDGET, limit: 50, offset });
      seen.push(...page.nodes.map((n) => n.id));
      offset = page.nextOffset;
    }
    expect(offset).toBeNull();
    expect(seen).toEqual(full.nodes.map((n) => n.id));
  });

  it("rejects invalid input at the Zod boundary naming the field — ctx.db is never touched", async () => {
    const bad = createCaller({ db: poisonedDb() });
    const cases: Array<[string, Parameters<typeof bad.find>[0]]> = [
      ["nodeTypes", { nodeTypes: [""] }],
      ["limit", { limit: 201 }],
      ["offset", { offset: 5001 }],
      ["projects", { projects: [] }],
      ["text", { text: "x".repeat(501) }],
      ["nodeTypes", { nodeTypes: ["x".repeat(501)] }],
      ["projects", { projects: ["ok", "x".repeat(501)] }],
    ];
    for (const [field, input] of cases) {
      await expect(bad.find(input)).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining(field) });
    }
    const listCases: Array<[string, Parameters<typeof bad.list>[0]]> = [
      ["nodeTypes", { nodeTypes: ["x".repeat(501)] }],
      ["sourceSystems", { sourceSystems: ["x".repeat(501)] }],
    ];
    for (const [field, input] of listCases) {
      await expect(bad.list(input)).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining(field) });
    }
  });

  it("reports capped instead of a next offset past MAX_FIND_OFFSET", async () => {
    expect(nextFindOffset(0, 50, false)).toEqual({ nextOffset: null, capped: false });
    expect(nextFindOffset(0, 50, true)).toEqual({ nextOffset: 50, capped: false });
    expect(nextFindOffset(4950, 50, true)).toEqual({ nextOffset: 5000, capped: false });
    expect(nextFindOffset(4960, 50, true)).toEqual({ nextOffset: null, capped: true });
    const page = await caller().find({ projects: [P] });
    expect(page.capped).toBe(false);
  });

  it("serves when the server is read-only", async () => {
    const result = await caller({ readOnly: true }).find({ projects: [P], reviewsOnly: true });
    expect(result.total).toBe(3);
  });
});

describe("list accepts a contains predicate", () => {
  it("selects exactly the nodes whose labels hold the value", async () => {
    const result = await caller().list({ sourceSystems: [SRC], where: [{ key: "labels", op: "contains", value: "review" }] });
    expect(result.nodes.map((n) => n.externalId)).toEqual(["rev-new", "rev-mid", "rev-old"]);
  });
});
