// registerBeadsProject (register-beads-project): scopes, the path check
// chosen by whether this server has `bd`, the conflict, and pick-up. Every
// DB write runs in a transaction that is rolled back.

import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getRegisteredBeadsProject, getRelayAction } from "@breakdown/core";
import { createDb, createPool, resolveDatabaseUrl, type Database } from "@breakdown/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBeadsWatcher } from "../beads-watcher.js";
import type { Context } from "../context.js";
import { appRouter } from "../router.js";
import { createCallerFactory } from "../trpc.js";

const createCaller = createCallerFactory(appRouter);
const TAG = randomUUID().slice(0, 8);
const ROOT = realpathSync(mkdtempSync(path.join(tmpdir(), "register-project-test-")));
const CHECKOUT = path.join(ROOT, "checkout");
const PLAIN = path.join(ROOT, "plain");
mkdirSync(path.join(CHECKOUT, ".beads"), { recursive: true });
mkdirSync(PLAIN);

let pool: ReturnType<typeof createPool>;
let db: Database;

beforeAll(() => {
  pool = createPool(resolveDatabaseUrl());
  db = createDb(pool);
});

afterAll(async () => {
  await pool.end();
  rmSync(ROOT, { recursive: true, force: true });
});

async function rolledBack(body: (tx: Database) => Promise<void>): Promise<void> {
  const ROLLBACK = new Error("rollback");
  await db
    .transaction(async (tx) => {
      await body(tx as unknown as Database);
      throw ROLLBACK;
    })
    .catch((err: unknown) => {
      if (err !== ROLLBACK) throw err;
    });
}

describe("registerBeadsProject without bd (the laptop relay loads it)", () => {
  it("stores a path this server cannot see, attributes the run, and queues a re-ingest for the relay", async () => {
    const project = `rp-${TAG}-a`;
    await rolledBack(async (tx) => {
      const caller = createCaller({ db: tx, client: "browser-mac", scope: "human", missingBinaries: ["bd"] } satisfies Context);
      const result = await caller.registerBeadsProject({ project, path: "/Users/nobody/dev/underground" });
      expect(result).toMatchObject({ project, path: "/Users/nobody/dev/underground", status: "created", pickup: { by: "relay", queued: expect.any(Number) } });
      const queued = (result.pickup as { queued: number }).queued;
      expect(await getRelayAction(tx, queued)).toMatchObject({ kind: "beads_reingest", payload: { project_key: project }, requestedBy: "browser-mac" });
      expect(await getRegisteredBeadsProject(tx, project)).toMatchObject({ path: "/Users/nobody/dev/underground" });

      const again = await caller.registerBeadsProject({ project, path: "/Users/nobody/dev/underground" });
      expect(again.status).toBe("unchanged");
    });
  });

  it("refuses a relative path", async () => {
    const caller = createCaller({ db, missingBinaries: ["bd"] });
    await expect(caller.registerBeadsProject({ project: `rp-${TAG}-b`, path: "dev/underground" })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("must be absolute") });
  });

  it("refuses to re-point a key, naming both paths", async () => {
    const project = `rp-${TAG}-c`;
    await rolledBack(async (tx) => {
      const caller = createCaller({ db: tx, missingBinaries: ["bd"] });
      await caller.registerBeadsProject({ project, path: "/Users/me/dev/one" });
      const err = await caller.registerBeadsProject({ project, path: "/Users/me/dev/two" }).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: "CONFLICT" });
      expect((err as Error).message).toContain("/Users/me/dev/one");
      expect((err as Error).message).toContain("/Users/me/dev/two");
    });
  });

  it("refuses a malformed key", async () => {
    const caller = createCaller({ db, missingBinaries: ["bd"] });
    await expect(caller.registerBeadsProject({ project: "Under Ground", path: "/Users/me/x" })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("project") });
  });
});

describe("registerBeadsProject with bd (this server watches it)", () => {
  it("accepts a real checkout and reloads the watcher", async () => {
    const project = `rp-${TAG}-d`;
    let reads = 0;
    const watcher = createBeadsWatcher({
      db: {} as never,
      ingest: async () => ({ changed: false, changedNodeIds: [], nodes: { created: 0, updated: 0, unchanged: 0 }, edges: { created: 0, updated: 0 } }),
      readRegistry: async () => (reads++, []),
      watchDir: () => ({ close() {} }),
      log: () => {},
    });
    await rolledBack(async (tx) => {
      const result = await createCaller({ db: tx, watcher }).registerBeadsProject({ project, path: CHECKOUT });
      expect(result).toMatchObject({ project, path: CHECKOUT, status: "created", pickup: { by: "watcher" } });
    });
    expect(reads).toBeGreaterThan(0);
    await watcher.stop();
  });

  it("refuses a directory without .beads/ and one that does not exist here", async () => {
    const caller = createCaller({ db });
    await expect(caller.registerBeadsProject({ project: `rp-${TAG}-e`, path: PLAIN })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining(".beads/") });
    await expect(caller.registerBeadsProject({ project: `rp-${TAG}-e`, path: path.join(ROOT, "missing") })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("does not exist") });
  });
});

describe("registerBeadsProject scopes", () => {
  it.each(["agent", "hangar", "relay"] as const)("refuses a %s token", async (scope) => {
    const caller = createCaller({ db, client: `t-${scope}`, scope, missingBinaries: ["bd"] });
    await expect(caller.registerBeadsProject({ project: `rp-${TAG}-f`, path: "/Users/me/x" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
