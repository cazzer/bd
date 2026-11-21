// registerBeadsProject and its path checks (register-beads-project). DB
// fixtures are scoped to keys carrying this file's suffix; nothing asserts
// on global counts.

import { and, eq, inArray, like, or } from "drizzle-orm";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@breakdown/db";
import { edges, ingestRuns, nodes } from "@breakdown/db";
import { type BeadsIssue } from "./beads.js";
import { ingestBeadsCheckout } from "./beads-ingest.js";
import { checkLocalCheckout, checkRemoteCheckoutPath, registerBeadsProject } from "./beads-registration.js";
import { getRegisteredBeadsProject, listBeadsProjects } from "./board.js";
import { BeadsProjectConflictError, InvalidCheckoutPathError, InvalidWorkItemError } from "./errors.js";
import { connectTestDb, type TestPool, uniqueSuffix } from "./test-helpers.js";

const SUFFIX = uniqueSuffix().slice(0, 12);
const PREFIX = `br${SUFFIX}`;
const keyOf = (name: string) => `${name}-${SUFFIX}`;
const ROOT = realpathSync(mkdtempSync(path.join(tmpdir(), "beads-registration-test-")));
const CHECKOUT = path.join(ROOT, "checkout");
const PLAIN = path.join(ROOT, "plain");
const LINK = path.join(ROOT, "link");
mkdirSync(path.join(CHECKOUT, ".beads"), { recursive: true });
mkdirSync(PLAIN);
symlinkSync(CHECKOUT, LINK);

let pool: TestPool;
let db: Database;
const runIds: string[] = [];

beforeAll(() => {
  ({ pool, db } = connectTestDb());
});

afterAll(async () => {
  await db.delete(nodes).where(and(eq(nodes.sourceSystem, "beads"), or(like(nodes.externalId, `${PREFIX}-%`), like(nodes.externalId, `project:%-${SUFFIX}`))));
  if (runIds.length > 0) await db.delete(ingestRuns).where(inArray(ingestRuns.id, runIds));
  await pool.end();
  rmSync(ROOT, { recursive: true, force: true });
});

async function register(project: string, at: string, actor = "test-client") {
  const result = await registerBeadsProject(db, { project, path: at, actor });
  runIds.push(result.ingestRunId);
  return result;
}

describe("registerBeadsProject", () => {
  it("creates the registry node in a beads run attributed to the caller, then reports unchanged", async () => {
    const project = keyOf("new");
    const first = await register(` ${project} `, "/Users/me/dev/underground");
    expect(first).toMatchObject({ project, path: "/Users/me/dev/underground", status: "created" });
    const [run] = await db.select().from(ingestRuns).where(eq(ingestRuns.id, first.ingestRunId));
    expect(run).toMatchObject({ sourceSystem: "beads", actor: "test-client" });
    expect(run!.stats).toMatchObject({ project, path: "/Users/me/dev/underground", registration: true });

    const second = await register(project, "/Users/me/dev/underground");
    expect(second.status).toBe("unchanged");
    const rows = await db.select().from(nodes).where(and(eq(nodes.sourceSystem, "beads"), eq(nodes.externalId, `project:${project}`)));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ nodeType: "beads_project", title: project, metadata: { project, path: "/Users/me/dev/underground" } });
  });

  it("counts as a registration for the watcher, the relay, and the board", async () => {
    const project = keyOf("listed");
    await register(project, "/Users/me/dev/listed");
    expect(await getRegisteredBeadsProject(db, project)).toMatchObject({ key: project, path: "/Users/me/dev/listed" });
    const listed = await listBeadsProjects(db, { registeredByBeads: true });
    expect(listed.find((p) => p.key === project)).toMatchObject({ path: "/Users/me/dev/listed" });
  });

  it("refuses a key registered at another path, naming both, and writes nothing", async () => {
    const project = keyOf("conflict");
    await register(project, "/Users/me/dev/one");
    const err = await registerBeadsProject(db, { project, path: "/Users/me/tmp/two" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BeadsProjectConflictError);
    expect((err as Error).message).toContain("/Users/me/dev/one");
    expect((err as Error).message).toContain("/Users/me/tmp/two");
    expect(await getRegisteredBeadsProject(db, project)).toMatchObject({ path: "/Users/me/dev/one" });
  });

  it("refuses a malformed key naming project", async () => {
    const err = await registerBeadsProject(db, { project: "Under Ground", path: "/Users/me/x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidWorkItemError);
    expect((err as InvalidWorkItemError).field).toBe("project");
  });

  it("leaves an ingested project's items, edges, and revisions untouched", async () => {
    const project = keyOf("loaded");
    const issues: BeadsIssue[] = [
      { id: `${PREFIX}-1`, title: "One", description: "", status: "open", priority: 2, issue_type: "task", created_at: "2026-09-01T10:00:00Z" },
      {
        id: `${PREFIX}-2`, title: "Two", description: "", status: "open", priority: 2, issue_type: "task", created_at: "2026-09-01T10:00:00Z",
        dependencies: [{ issue_id: `${PREFIX}-2`, depends_on_id: `${PREFIX}-1`, type: "blocks" }],
      },
    ];
    const loaded = await ingestBeadsCheckout(db, { dir: CHECKOUT, project, runBd: async () => JSON.stringify(issues) });
    runIds.push(loaded.ingestRunId);
    const itemIds = (await db.select({ id: nodes.id }).from(nodes).where(inArray(nodes.externalId, issues.map((i) => i.id)))).map((r) => r.id);
    const edgesBefore = await db.select().from(edges).where(inArray(edges.srcId, itemIds));
    expect(edgesBefore).toHaveLength(1);

    const again = await register(project, CHECKOUT);
    expect(again.status).toBe("unchanged");
    const edgesAfter = await db.select().from(edges).where(inArray(edges.srcId, itemIds));
    expect(edgesAfter).toEqual(edgesBefore);
    const items = await db.select().from(nodes).where(inArray(nodes.id, itemIds));
    expect(items.every((r) => r.ingestRunId === loaded.ingestRunId)).toBe(true);
  });
});

describe("checkRemoteCheckoutPath", () => {
  it.each([
    ["dev/underground", "must be absolute"],
    ["/Users/me/dev/underground/", "must not end with a slash"],
    ["/Users/me/../me/dev", "must be normalized"],
    ["/Users/me/./dev", "must be normalized"],
    ["/Users//me", "must be normalized"],
    ["/", "root directory"],
    ["/Users/me\n/dev", "control characters"],
    [`/${"a".repeat(1030)}`, "at most 1024"],
    ["", "non-empty"],
  ])("refuses %j", (input, reason) => {
    expect(() => checkRemoteCheckoutPath(input)).toThrow(InvalidCheckoutPathError);
    expect(() => checkRemoteCheckoutPath(input)).toThrow(reason);
  });

  it("accepts a path this server cannot see", () => {
    expect(checkRemoteCheckoutPath("/Users/nobody/dev/underground")).toBe("/Users/nobody/dev/underground");
  });
});

describe("checkLocalCheckout", () => {
  it("accepts a real checkout holding .beads/", () => {
    expect(checkLocalCheckout(CHECKOUT)).toBe(CHECKOUT);
  });

  it.each([
    [path.join(ROOT, "missing"), "does not exist on this server"],
    [PLAIN, "holds no .beads/"],
    [LINK, "is not its own real path"],
    ["relative", "must be absolute"],
  ])("refuses %s", (input, reason) => {
    expect(() => checkLocalCheckout(input)).toThrow(reason);
  });
});
