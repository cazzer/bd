// Host-only binaries (tailnet-hosting decision 8): PATH lookup, and the
// beads loader's default runner naming a missing `bd` as unavailable.

import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { defaultRunBd } from "./beads-ingest.js";
import { findOnPath, HostBinaryUnavailableError } from "./host-binaries.js";

const base = realpathSync(mkdtempSync(path.join(tmpdir(), "host-binaries-")));
const savedPath = process.env["PATH"];

afterEach(() => {
  process.env["PATH"] = savedPath;
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

function dir(name: string): string {
  const d = path.join(base, name);
  mkdirSync(d, { recursive: true });
  return d;
}

describe("findOnPath", () => {
  it("finds an executable file on PATH, first entry first", () => {
    const first = dir("first");
    const second = dir("second");
    for (const d of [first, second]) {
      writeFileSync(path.join(d, "tool"), "#!/bin/sh\n");
      chmodSync(path.join(d, "tool"), 0o755);
    }
    expect(findOnPath("tool", [first, second].join(path.delimiter))).toBe(path.join(first, "tool"));
  });

  it("skips a non-executable file, a directory, and empty entries", () => {
    const plain = dir("plain");
    writeFileSync(path.join(plain, "tool"), "not executable");
    chmodSync(path.join(plain, "tool"), 0o644);
    const holder = dir("holder");
    mkdirSync(path.join(holder, "tool"), { recursive: true });
    expect(findOnPath("tool", ["", plain, holder, ""].join(path.delimiter))).toBeNull();
  });

  it("answers null for an empty PATH, and reads process.env.PATH by default", () => {
    expect(findOnPath("sh", "")).toBeNull();
    process.env["PATH"] = dir("empty-path");
    expect(findOnPath("sh")).toBeNull();
  });
});

describe("HostBinaryUnavailableError", () => {
  it("names the binary", () => {
    const err = new HostBinaryUnavailableError("herdr");
    expect(err.binary).toBe("herdr");
    expect(err.message).toBe("herdr is unavailable on this server: not found on PATH");
  });
});

describe("defaultRunBd without bd on PATH", () => {
  it("throws HostBinaryUnavailableError naming bd when the checkout exists", async () => {
    process.env["PATH"] = dir("empty-path");
    const err = await defaultRunBd(["list", "--json"], dir("checkout")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostBinaryUnavailableError);
    expect((err as HostBinaryUnavailableError).binary).toBe("bd");
  });

  it("keeps the ordinary failure when the checkout is missing", async () => {
    process.env["PATH"] = dir("empty-path");
    const err = await defaultRunBd(["list", "--json"], path.join(base, "gone")).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(HostBinaryUnavailableError);
    expect((err as Error).message).toMatch(/^bd list --json failed in /);
  });
});
