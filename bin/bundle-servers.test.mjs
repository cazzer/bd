// The bundles run with no workspace around them: built into a temp dir
// outside the repo, each entrypoint still starts far enough to refuse bad
// input on its own, with no node_modules to fall back on.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "bundle-servers.mjs");

/** Resolves with the exit code and output; never rejects on a non-zero exit. */
function run(args, { cwd, env = {} } = {}) {
  return new Promise((resolve) => {
    const childEnv = { ...process.env };
    delete childEnv.DATABASE_URL;
    Object.assign(childEnv, env);
    execFile(process.execPath, args, { cwd, env: childEnv, timeout: 60_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, stdout, stderr });
    });
  });
}

let outdir;

before(async () => {
  outdir = await mkdtemp(path.join(tmpdir(), "breakdown-bundle-"));
  const built = await run([script, "--outdir", outdir]);
  assert.equal(built.code, 0, built.stderr);
});

after(async () => {
  if (outdir) await rm(outdir, { recursive: true, force: true });
});

test("the web bundle refuses an unknown flag before connecting", async () => {
  const { code, stderr } = await run([path.join(outdir, "web.mjs"), "--nope"], { cwd: outdir });
  assert.equal(code, 1);
  assert.match(stderr, /\[breakdown-web\] cannot start: .*--nope/);
});

test("the MCP bundle refuses an unknown flag before connecting", async () => {
  const { code, stderr } = await run([path.join(outdir, "mcp.mjs"), "--nope"], { cwd: outdir });
  assert.equal(code, 1);
  assert.match(stderr, /\[breakdown-brain\] cannot start: .*--nope/);
});

test("the token bundle prints usage with no command, without querying", async () => {
  const { code, stdout, stderr } = await run([path.join(outdir, "token.mjs")], {
    cwd: outdir,
    // Nothing listens on port 1: a query would fail rather than print usage.
    env: { DATABASE_URL: "postgres://x:x@127.0.0.1:1/x" },
  });
  assert.equal(code, 2);
  assert.equal(stdout, "");
  assert.match(stderr, /^usage: /);
});
