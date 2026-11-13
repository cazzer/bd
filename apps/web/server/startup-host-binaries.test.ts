// The real web entrypoint (server/index.ts) spawned with a PATH that holds
// neither `bd` nor `herdr` (tailnet-hosting design.md decision 8, task 2.2):
// it starts, says once per binary that it is unavailable, serves health and
// the built client, refuses a review decision naming `bd`, and keeps
// serving. Node itself is `process.execPath` and tsx is loaded with
// `--import`, so nothing needs PATH. Nothing here writes to the database:
// the watcher reads no registry without `bd`, and the decision is refused
// before any lookup.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const base = mkdtempSync(path.join(tmpdir(), "web-no-binaries-"));
const emptyPath = path.join(base, "bin");
const clientDir = path.join(base, "client");
const INDEX = "<!doctype html><title>board</title>";

let child: ChildProcess | undefined;

afterAll(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child!.once("exit", resolve));
    child.kill("SIGTERM");
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  }
  rmSync(base, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe("web server with neither bd nor herdr on PATH", () => {
  it("starts, logs each missing binary once, serves, and refuses a review decision naming bd", async () => {
    mkdirSync(emptyPath, { recursive: true });
    mkdirSync(clientDir, { recursive: true });
    writeFileSync(path.join(clientDir, "index.html"), INDEX);
    const port = await freePort();

    const env: Record<string, string> = { ...(process.env as Record<string, string>), PATH: emptyPath };
    delete env["BRAIN_READ_ONLY"];
    const spawned = spawn(process.execPath, ["--import", "tsx", "server/index.ts", "--port", String(port), "--client-dir", clientDir], {
      cwd: webRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child = spawned;
    let stderr = "";
    spawned.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));

    const deadline = Date.now() + 20_000;
    while (!stderr.includes("ready on")) {
      if (spawned.exitCode !== null || Date.now() > deadline) throw new Error(`never became ready — stderr=${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const origin = `http://127.0.0.1:${port}`;

    expect(stderr.split("\n").filter((l) => l.includes("bd is unavailable on this server"))).toHaveLength(1);
    expect(stderr.split("\n").filter((l) => l.includes("herdr is unavailable on this server"))).toHaveLength(1);
    expect(stderr).toContain("beads watcher: bd not found on PATH; no beads project is watched by this server");

    const health = await fetch(`${origin}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ready: true });

    const index = await fetch(`${origin}/`);
    expect(index.status).toBe(200);
    expect(await index.text()).toBe(INDEX);

    const decision = await fetch(`${origin}/trpc/reviewDecision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: "no-such-project-zz", item: "zz-1", decision: "accept", message: "" }),
    });
    expect(decision.status).toBe(412);
    expect(JSON.stringify(await decision.json())).toContain("bd is unavailable on this server: not found on PATH");

    expect((await fetch(`${origin}/healthz`)).status).toBe(200);
    expect(spawned.exitCode).toBeNull();

    const exited = new Promise<number | null>((resolve) => spawned.once("exit", (code) => resolve(code)));
    spawned.kill("SIGTERM");
    expect(await exited).toBe(0);
  }, 30_000);
});
