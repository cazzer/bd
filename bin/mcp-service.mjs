#!/usr/bin/env node
// Entry point; the flow lives in mcp-service-lib.mjs. Run as `pnpm mcp:service <install|uninstall|status|restart>`.
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { runService } from "./mcp-service-lib.mjs";

const run = (cmd, args, { cwd, env }) =>
  new Promise((resolve) => {
    const options = { cwd, env: env ? { ...process.env, ...env } : undefined, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 };
    execFile(cmd, args, options, (err, stdout, stderr) => {
      if (!err) return resolve({ code: 0, stdout, stderr });
      if (err.code === "ENOENT") return resolve({ code: 127, stdout: "", stderr: err.message });
      const timedOut = err.killed ? `${cmd} timed out after 30 s` : "";
      resolve({ code: typeof err.code === "number" ? err.code : 1, stdout: stdout ?? "", stderr: stderr || timedOut || err.message });
    });
  });

const { exitCode } = await runService({
  argv: process.argv.slice(2),
  platform: process.platform,
  homedir: homedir(),
  uid: process.getuid?.(),
  execPath: process.execPath,
  // The checkout this script lives in, never the caller's cwd.
  repoRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  run,
  fetch: globalThis.fetch,
  sleep,
  now: Date.now,
  out: console.log,
  warn: console.error,
});
process.exitCode = exitCode;
