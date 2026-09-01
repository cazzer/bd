import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

/** Thrown by resolveDatabaseUrl() when DATABASE_URL can't be found. */
export class DatabaseUrlNotSetError extends Error {
  constructor(searchedEnvPath: string) {
    super(
      `DATABASE_URL is not set. Set it in the environment, or in ${searchedEnvPath} (see .env.example).`,
    );
    this.name = "DatabaseUrlNotSetError";
  }
}

/** Walks up from `startDir` to find the pnpm workspace root. */
function findWorkspaceRoot(startDir: string): string {
  let dir = startDir;
  for (;;) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(
        `Could not locate the workspace root (no pnpm-workspace.yaml found above ${startDir})`,
      );
    }
    dir = parent;
  }
}

/**
 * Reads DATABASE_URL from the environment, loading the workspace root's
 * .env first (without overriding a value already set in the environment).
 * Throws DatabaseUrlNotSetError if DATABASE_URL is still unset afterwards.
 *
 * Does nothing at module load — callers invoke this explicitly.
 */
export function resolveDatabaseUrl(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const workspaceRoot = findWorkspaceRoot(here);
  const envPath = path.join(workspaceRoot, ".env");
  dotenv.config({ path: envPath });

  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    throw new DatabaseUrlNotSetError(envPath);
  }
  return databaseUrl;
}
