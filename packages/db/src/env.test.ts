// resolveDatabaseUrl outside a workspace (tailnet-hosting group 2): a
// bundled server has no pnpm-workspace.yaml above it, so no .env is read
// and the environment is all there is.

import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DatabaseUrlNotSetError, findWorkspaceRoot, resolveDatabaseUrl } from "./env.js";

let outside: string;
const saved = process.env["DATABASE_URL"];

beforeAll(async () => {
  outside = await realpath(await mkdtemp(path.join(os.tmpdir(), "db-env-")));
});

afterAll(async () => {
  await rm(outside, { recursive: true, force: true });
});

afterEach(() => {
  if (saved === undefined) delete process.env["DATABASE_URL"];
  else process.env["DATABASE_URL"] = saved;
});

describe("findWorkspaceRoot", () => {
  it("finds the repo root from inside it", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    expect(findWorkspaceRoot(here)).toBe(path.resolve(here, "..", "..", ".."));
  });

  it("answers null with no pnpm-workspace.yaml above the start", () => {
    expect(findWorkspaceRoot(outside)).toBeNull();
  });
});

describe("resolveDatabaseUrl outside a workspace", () => {
  it("takes DATABASE_URL from the environment", () => {
    process.env["DATABASE_URL"] = "postgres://u@db.example:5432/brain";
    expect(resolveDatabaseUrl(outside)).toBe("postgres://u@db.example:5432/brain");
  });

  it("says to set it in the environment, naming no .env path", () => {
    delete process.env["DATABASE_URL"];
    expect(() => resolveDatabaseUrl(outside)).toThrow(DatabaseUrlNotSetError);
    expect(() => resolveDatabaseUrl(outside)).toThrow(/^DATABASE_URL is not set\. Set it in the environment\.$/);
  });
});
