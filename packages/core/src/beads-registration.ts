// Registering a beads project without running `bd` (register-beads-project).
// A Breakdown without `bd` (the Jetson) cannot run `pnpm ingest:beads`, so
// a person (tRPC) or Claude (MCP) registers a project by key and path here,
// and the laptop relay, which holds the checkout, loads and pushes it.
//
// `registerBeadsProject` writes ONLY the project's registry node — the same
// `{ beads_project, external_id 'project:<key>', metadata { project, path } }`
// row `applyBeadsIngest` writes — inside a `beads` ingest run attributed to
// the caller, so it passes the provenance rule (`listBeadsProjects`'
// `registeredByBeads`, `getRegisteredBeadsProject`) exactly as a local
// ingest's registration does. It deliberately does not call
// `applyBeadsIngest` with no issues: that reconciles the project's
// `blocks`/`child_of` edges against an empty set and would delete every
// edge of an already-registered project (design.md decision 1).
//
// The key is canonicalized by the ingest's own `canonicalProject`. A key
// registered at another path is refused (`BeadsProjectConflictError`, kind
// `path`) before a run opens, so a registration never re-points a project;
// the same key and path again is `unchanged` (content_hash decides).
//
// The path is checked by the caller, which knows where `bd` will run
// (design.md decision 2): `checkLocalCheckout` on a server that has `bd`
// (the path exists here, is its own realpath, is a directory, holds
// `.beads/` — the relay's own checks), `checkRemoteCheckoutPath` on one
// that does not (shape only; the server cannot see the Mac's disk, and the
// relay validates before it serves). This module never runs `bd`.

import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { nodes, type Database } from "@breakdown/db";
import { and, eq, sql } from "drizzle-orm";
import { BEADS_SOURCE_SYSTEM } from "./beads.js";
import { BEADS_PROJECT_NODE_TYPE, canonicalProject } from "./beads-ingest.js";
import { BeadsProjectConflictError, InvalidCheckoutPathError, InvalidWorkItemError } from "./errors.js";
import { closeIngestRun, openIngestRun } from "./ingest-runs.js";
import { upsertNodes } from "./nodes.js";

export const MAX_CHECKOUT_PATH_LENGTH = 1024;

/** The default actor of a registration run when the caller names none. */
const REGISTRATION_ACTOR = "register:beads";

export interface RegisterBeadsProjectOptions {
  /** The project key (contract form `[a-z0-9._-]{1,64}`, trimmed). */
  project: string;
  /** The checkout path, already through `checkLocalCheckout` or `checkRemoteCheckoutPath`. */
  path: string;
  /** The run's actor: the web's `<client>` or MCP's `<client> via <name> <version>`. */
  actor?: string;
}

export interface RegisterBeadsProjectResult {
  project: string;
  path: string;
  status: "created" | "updated" | "unchanged";
  ingestRunId: string;
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/** Shape only, for a server that cannot see the path (module header): absolute, normalized, no trailing slash, bounded, no control characters. Returns the path. */
export function checkRemoteCheckoutPath(input: unknown): string {
  if (typeof input !== "string" || input === "") throw new InvalidCheckoutPathError(String(input ?? ""), "must be a non-empty string");
  if (input.length > MAX_CHECKOUT_PATH_LENGTH) throw new InvalidCheckoutPathError(input.slice(0, 80) + "…", `must be at most ${MAX_CHECKOUT_PATH_LENGTH} characters`);
  if (CONTROL_CHARACTERS.test(input)) throw new InvalidCheckoutPathError(input, "must not contain control characters");
  if (!input.startsWith("/")) throw new InvalidCheckoutPathError(input, "must be absolute");
  if (input !== "/" && input.endsWith("/")) throw new InvalidCheckoutPathError(input, "must not end with a slash");
  if (path.posix.normalize(input) !== input) throw new InvalidCheckoutPathError(input, "must be normalized (no '.', '..', or repeated slashes)");
  if (input === "/") throw new InvalidCheckoutPathError(input, "must not be the root directory");
  return input;
}

/** For a server that runs `bd` in the path (module header): the shape checks, then it exists here, is its own realpath, is a directory, and holds `.beads/`. Returns the path. */
export function checkLocalCheckout(input: unknown): string {
  const dir = checkRemoteCheckoutPath(input);
  let real: string;
  try {
    real = realpathSync.native(dir);
  } catch {
    throw new InvalidCheckoutPathError(dir, "does not exist on this server");
  }
  if (real !== dir) throw new InvalidCheckoutPathError(dir, `is not its own real path (it resolves to ${JSON.stringify(real)}); register the real path`);
  if (!statSync(dir).isDirectory()) throw new InvalidCheckoutPathError(dir, "is not a directory");
  let beads = false;
  try {
    beads = statSync(path.join(dir, ".beads")).isDirectory();
  } catch {
    beads = false;
  }
  if (!beads) throw new InvalidCheckoutPathError(dir, "holds no .beads/ directory");
  return dir;
}

/**
 * Registers `project` at `path` (module header): refuses a key registered
 * at another path, then writes the registry node alone in one `beads` run.
 * Throws `InvalidWorkItemError` (a bad key, naming `project`),
 * `BeadsProjectConflictError`, or the write path's own errors.
 */
export async function registerBeadsProject(db: Database, options: RegisterBeadsProjectOptions): Promise<RegisterBeadsProjectResult> {
  if (typeof options.project !== "string") throw new InvalidWorkItemError("project", options.project, "must be a string");
  const project = canonicalProject(options.project)!;
  const checkoutPath = options.path;

  const [existing] = await db
    .select({ path: sql<string | null>`${nodes.metadata}->>'path'` })
    .from(nodes)
    .where(and(eq(nodes.sourceSystem, BEADS_SOURCE_SYSTEM), eq(nodes.externalId, `project:${project}`)))
    .limit(1);
  if (existing !== undefined && existing.path !== null && existing.path !== "" && existing.path !== checkoutPath) {
    throw new BeadsProjectConflictError(project, "path", checkoutPath, existing.path);
  }

  const stats = { project, path: checkoutPath, registration: true };
  const run = await openIngestRun(db, BEADS_SOURCE_SYSTEM, { actor: options.actor ?? REGISTRATION_ACTOR });
  try {
    const result = await upsertNodes(db, run, [
      {
        nodeType: BEADS_PROJECT_NODE_TYPE,
        sourceSystem: BEADS_SOURCE_SYSTEM,
        externalId: `project:${project}`,
        title: project,
        content: "",
        metadata: { project, path: checkoutPath },
      },
    ]);
    await closeIngestRun(db, run, stats);
    const action = result.rows[0]?.action ?? "unchanged";
    return { project, path: checkoutPath, status: action, ingestRunId: run.id };
  } catch (err) {
    await closeIngestRun(db, run, { ...stats, error: err instanceof Error ? err.message : String(err) }).catch(() => undefined);
    throw err;
  }
}
