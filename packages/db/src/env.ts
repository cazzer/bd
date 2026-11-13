import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

/**
 * Thrown by resolveDatabaseUrl() when DATABASE_URL can't be found.
 * `searchedEnvPath` is the .env file that was read, or null when there was
 * no workspace root to read one from (a bundled server outside the repo).
 */
export class DatabaseUrlNotSetError extends Error {
  constructor(searchedEnvPath: string | null) {
    super(
      searchedEnvPath === null
        ? "DATABASE_URL is not set. Set it in the environment."
        : `DATABASE_URL is not set. Set it in the environment, or in ${searchedEnvPath} (see .env.example).`,
    );
    this.name = "DatabaseUrlNotSetError";
  }
}

/**
 * Walks up from `startDir` to the pnpm workspace root, or null when there
 * is none above it: a bundled server (the container's /app/dist) runs with
 * no workspace around it and takes its environment as given.
 */
export function findWorkspaceRoot(startDir: string): string | null {
  let dir = startDir;
  for (;;) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Reads DATABASE_URL from the environment, loading the workspace root's
 * .env first (without overriding a value already set in the environment);
 * with no workspace root above `startDir` (default: this module's
 * directory), no .env is read. Throws DatabaseUrlNotSetError if
 * DATABASE_URL is still unset afterwards.
 *
 * Does nothing at module load — callers invoke this explicitly.
 */
export function resolveDatabaseUrl(startDir: string = path.dirname(fileURLToPath(import.meta.url))): string {
  const workspaceRoot = findWorkspaceRoot(startDir);
  const envPath = workspaceRoot === null ? null : path.join(workspaceRoot, ".env");
  // `quiet` keeps dotenv's "injected env" banner off stdout. The MCP server
  // frames JSON-RPC on stdout, so a single stray line there is not cosmetic:
  // the client fails to parse it and drops the transport before the server
  // has said anything (CONNECTION_CLOSED). Every entrypoint loads env
  // through here, so this is the one place that has to stay quiet.
  if (envPath !== null) dotenv.config({ path: envPath, quiet: true });

  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    throw new DatabaseUrlNotSetError(envPath);
  }
  return databaseUrl;
}
