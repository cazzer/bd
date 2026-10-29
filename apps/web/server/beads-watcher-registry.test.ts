// The beads watcher's default registry read against the store (board-visual-
// reviews review follow-up): the watcher runs `bd` in every path it tracks,
// so it must track only registry nodes a beads ingest last wrote. `ingest`,
// `watchDir`, and `fingerprint` are injected — no `bd` runs. Other suites'
// registry rows may be tracked too (the read is store-wide), so assertions
// name only this file's keys.

import { randomUUID } from "node:crypto";
import { closeIngestRun, openIngestRun, upsertNodes, type IngestRunHandle } from "@breakdown/core";
import { createDb, createPool, ingestRuns, nodes, resolveDatabaseUrl, type Database } from "@breakdown/db";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createBeadsWatcher, type LoadResult } from "./beads-watcher.js";

const TAG = randomUUID().replace(/-/g, "").slice(0, 10);
const TRUSTED = `wt-${TAG}`;
const HIJACKED = `wh-${TAG}`;
const FORGED = `wf-${TAG}`;

let pool: ReturnType<typeof createPool>;
let db: Database;
let beadsRun: IngestRunHandle;
let agentRun: IngestRunHandle;

const registry = (key: string, dir: string) => ({ nodeType: "beads_project", sourceSystem: "beads", externalId: `project:${key}`, title: key, content: "", metadata: { project: key, path: dir } });

beforeAll(async () => {
  pool = createPool(resolveDatabaseUrl());
  db = createDb(pool);
  beadsRun = await openIngestRun(db, "beads", { actor: "watcher-registry-suite" });
  // Any non-beads run stands in for brain_write's `agent` run; not `agent` itself, which apps/mcp's suite deletes when empty.
  agentRun = await openIngestRun(db, `agent-watcher-test-${TAG}`, { actor: "watcher-registry-suite" });
  await upsertNodes(db, beadsRun, [registry(TRUSTED, `/tmp/${TRUSTED}`), registry(HIJACKED, `/tmp/${HIJACKED}`)]);
  // An agent re-points one beads registration and forges another.
  await upsertNodes(db, agentRun, [registry(HIJACKED, "/somewhere/else"), registry(FORGED, "/")]);
});

afterAll(async () => {
  await closeIngestRun(db, beadsRun);
  await closeIngestRun(db, agentRun);
  await db.delete(nodes).where(and(eq(nodes.sourceSystem, "beads"), inArray(nodes.externalId, [TRUSTED, HIJACKED, FORGED].map((k) => `project:${k}`))));
  await db.delete(ingestRuns).where(inArray(ingestRuns.id, [beadsRun.id, agentRun.id]));
  await pool.end();
});

describe("beads watcher registry read", () => {
  it("watches a beads-registered checkout, not one an agent wrote or re-pointed", async () => {
    const ingest = vi.fn(async (_o: { dir: string; project: string }): Promise<LoadResult> => ({ changed: false, changedNodeIds: [], nodes: { created: 0, updated: 0, unchanged: 0 }, edges: { created: 0, updated: 0 } }));
    const watched: string[] = [];
    const watcher = createBeadsWatcher({
      db,
      ingest: (_db, o) => ingest(o),
      watchDir: (dir) => {
        watched.push(dir);
        return { close: () => {} };
      },
      fingerprint: () => "fp",
      log: () => {},
    });
    try {
      const projects = (await watcher.reload()).map((o) => o.project);
      expect(projects).toContain(TRUSTED);
      expect(projects).not.toContain(HIJACKED);
      expect(projects).not.toContain(FORGED);
      const loadedDirs = ingest.mock.calls.map(([o]) => o.dir);
      expect(loadedDirs).toContain(`/tmp/${TRUSTED}`);
      expect(loadedDirs).not.toContain("/somewhere/else");
      expect(loadedDirs).not.toContain("/");
      expect(watched.some((d) => d.startsWith("/somewhere/else"))).toBe(false);
    } finally {
      await watcher.stop();
    }
  });
});
