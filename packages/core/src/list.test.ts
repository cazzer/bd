import { eq, inArray } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@breakdown/db";
import { ingestRuns, nodes } from "@breakdown/db";
import { InvalidListOptionError } from "./errors.js";
import { openIngestRun, type IngestRunHandle } from "./ingest-runs.js";
import { buildListNodesQuery, listNodes, MAX_LIST_LIMIT, type ListedNode } from "./list.js";
import { mergeNodes } from "./merge.js";
import { upsertNodes } from "./nodes.js";
import { connectTestDb, type TestPool, uniqueSuffix } from "./test-helpers.js";

// Fixtures are scoped by a unique source system so nothing here asserts
// on global counts (the store is shared with other suites and other
// agents). Every listing below filters on `sourceSystems: [SRC]`.
const SRC = `list-test-${uniqueSuffix()}`;

let pool: TestPool;
let db: Database;
let run: IngestRunHandle;
let ids: Record<string, string> = {};

beforeAll(async () => {
  ({ pool, db } = connectTestDb());
  run = await openIngestRun(db, SRC);

  // Written one at a time so updated_at strictly increases in a known
  // order (a single batch shares one now()); the listing is newest-first.
  const items = [
    { externalId: "wi-1", nodeType: "work_item", title: "one", metadata: { status: "open", priority: 1, spec_id: "s" } },
    { externalId: "wi-2", nodeType: "work_item", title: "two", metadata: { status: "closed", priority: 0 } },
    { externalId: "wi-3", nodeType: "work_item", title: "three", metadata: { status: "open", priority: 3, flag: true } },
    { externalId: "wi-4", nodeType: "work_item", title: "four", metadata: { status: "in_progress", priority: 1 } },
    { externalId: "note-1", nodeType: "note", title: "note", metadata: { status: "open" } },
    { externalId: "dup", nodeType: "work_item", title: "dup", metadata: { status: "open", priority: 2 } },
  ];
  for (const item of items) {
    const result = await upsertNodes(db, run, [{ ...item, sourceSystem: SRC, content: `content ${item.externalId}` }]);
    const row = result.rows[0];
    if (!row) throw new Error("fixture insert returned no row");
    ids[item.externalId] = row.id;
  }
  const dupId = ids["dup"];
  const survivorId = ids["wi-3"];
  if (!dupId || !survivorId) throw new Error("fixture ids missing");
  await mergeNodes(db, dupId, survivorId, run);
});

afterAll(async () => {
  await db.delete(nodes).where(eq(nodes.sourceSystem, SRC));
  await db.delete(ingestRuns).where(inArray(ingestRuns.id, [run.id]));
  await pool.end();
});

const external = (listed: ListedNode[]) => listed.map((n) => n.externalId);

describe("listNodes", () => {
  it("lists by node type and an equals predicate, newest first", async () => {
    const result = await listNodes(db, { sourceSystems: [SRC], nodeTypes: ["work_item"], where: [{ key: "status", op: "equals", value: "open" }] });
    expect(external(result.nodes)).toEqual(["wi-3", "wi-1"]);
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
    expect(result.nodes[0]?.metadata).toEqual({ status: "open", priority: 3, flag: true });
    expect(result.nodes.every((n) => !("content" in n))).toBe(true);
  });

  it("supports a oneOf predicate and combines it with equals on another key", async () => {
    const result = await listNodes(db, { sourceSystems: [SRC], where: [{ key: "priority", op: "oneOf", values: [0, 1] }] });
    expect(external(result.nodes)).toEqual(["wi-4", "wi-2", "wi-1"]);

    const both = await listNodes(db, {
      sourceSystems: [SRC],
      where: [
        { key: "priority", op: "oneOf", values: [0, 1] },
        { key: "status", op: "equals", value: "open" },
      ],
    });
    expect(external(both.nodes)).toEqual(["wi-1"]);
  });

  it("matches boolean and null scalars exactly", async () => {
    const flagged = await listNodes(db, { sourceSystems: [SRC], where: [{ key: "flag", op: "equals", value: true }] });
    expect(external(flagged.nodes)).toEqual(["wi-3"]);
    const nulls = await listNodes(db, { sourceSystems: [SRC], where: [{ key: "flag", op: "equals", value: null }] });
    expect(nulls.nodes).toEqual([]);
  });

  it("does not list merged-away nodes", async () => {
    const result = await listNodes(db, { sourceSystems: [SRC] });
    expect(external(result.nodes)).not.toContain("dup");
    expect(result.nodes).toHaveLength(5);
  });

  it("pages with a keyset cursor without repeating or skipping", async () => {
    const seen: string[] = [];
    let cursor = null as Awaited<ReturnType<typeof listNodes>>["nextCursor"];
    let pages = 0;
    do {
      const page = await listNodes(db, { sourceSystems: [SRC], limit: 2, cursor });
      seen.push(...external(page.nodes));
      cursor = page.nextCursor;
      pages += 1;
      if (page.hasMore) expect(page.nodes).toHaveLength(2);
      else expect(cursor).toBeNull();
    } while (cursor !== null);
    expect(pages).toBe(3);
    expect(seen).toEqual(["note-1", "wi-4", "wi-3", "wi-2", "wi-1"]);
  });

  it("filters by updatedSince", async () => {
    const all = await listNodes(db, { sourceSystems: [SRC] });
    const third = all.nodes[2];
    if (!third) throw new Error("expected five fixtures");
    const since = await listNodes(db, { sourceSystems: [SRC], updatedSince: third.updatedAt });
    expect(external(since.nodes)).toEqual(external(all.nodes.slice(0, 3)));
  });

  it("rejects malformed options before any SQL runs", async () => {
    let executed = 0;
    const spy = { execute: async () => { executed += 1; return { rows: [] }; } } as unknown as Database;
    const cases: Array<Parameters<typeof listNodes>[1]> = [
      { limit: 0 },
      { limit: MAX_LIST_LIMIT + 1 },
      { where: [{ key: "status", op: "like" as "equals", value: "x" }] },
      { where: [{ key: "status", op: "equals", value: { nested: 1 } as unknown as string }] },
      { where: [{ key: "status", op: "oneOf", values: [] }] },
      { where: [{ key: "", op: "equals", value: "x" }] },
      { where: [{ key: "a", op: "equals", value: 1 }, { key: "a", op: "equals", value: 2 }] },
      { cursor: { updatedAt: "yesterday", id: "nope" } },
      { updatedSince: "not a date" },
      { nodeTypes: [] },
    ];
    for (const options of cases) {
      await expect(listNodes(spy, options)).rejects.toBeInstanceOf(InvalidListOptionError);
    }
    expect(executed).toBe(0);
  });

  it("buildListNodesQuery is pure and binds every value as a parameter", () => {
    const dialect = new PgDialect();
    const params = {
      nodeTypes: ["work_item"],
      sourceSystems: null,
      updatedSince: null,
      where: [{ key: "status", op: "equals" as const, value: "open'; DROP TABLE nodes; --" }],
      limit: 10,
      cursor: null,
    };
    const a = dialect.sqlToQuery(buildListNodesQuery(params));
    const b = dialect.sqlToQuery(buildListNodesQuery(params));
    expect(a.sql).toBe(b.sql);
    expect(a.params).toEqual(b.params);
    expect(a.sql).not.toContain("DROP TABLE");
    expect(a.params.some((p) => typeof p === "string" && p.includes("DROP TABLE"))).toBe(true);
  });
});
