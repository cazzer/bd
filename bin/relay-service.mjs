#!/usr/bin/env node
// Entry point; the flow lives in relay-service-lib.mjs. Run as
// `pnpm relay:service <install|uninstall|status>`.
import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { readTokenFile } from "./relay-lib.mjs";
import { runService } from "./relay-service-lib.mjs";

const run = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve({ code: 0, stdout, stderr });
      if (err.code === "ENOENT") return resolve({ code: 127, stdout: "", stderr: err.message });
      resolve({ code: typeof err.code === "number" ? err.code : 1, stdout: stdout ?? "", stderr: stderr || err.message });
    });
  });

/** The first executable regular file named `binary` on `pathEnv` (core host-binaries.ts `findOnPath`, copied: this script runs without the workspace). */
function findOnPath(binary, pathEnv = process.env.PATH) {
  for (const dir of (pathEnv ?? "").split(path.delimiter)) {
    if (dir === "") continue;
    const candidate = path.join(dir, binary);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

const { exitCode } = await runService({
  argv: process.argv.slice(2),
  platform: process.platform,
  homedir: homedir(),
  uid: process.getuid?.(),
  execPath: process.execPath,
  repoRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  run,
  findOnPath,
  readTokenFile: (file) => readTokenFile(file),
  sleep,
  now: Date.now,
  out: console.log,
  warn: console.error,
});
process.exitCode = exitCode;
