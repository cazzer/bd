// The real HTTP entrypoint (src/http.ts) spawned as a child process
// (brain-mcp spec, "HTTP mode is local only" → "Non-loopback bind
// requested"; "Fail fast on misconfiguration" → "Port already in use").
// http-server.test.ts drives the server itself in-process.
//
// A child still running when a test ends gets SIGTERM, never SIGKILL: tsx
// forwards SIGTERM to the real node child, while SIGKILL would orphan it.

import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:net";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const mcpRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsxBin = path.join(mcpRoot, "node_modules", ".bin", "tsx");
const entry = path.join(mcpRoot, "src", "http.ts");

const children: ChildProcess[] = [];
const netServers: Server[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
  await Promise.all(netServers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

interface Exited {
  code: number | null;
  stderr: string;
}

function spawnHttp(args: string[]): { child: ChildProcess; exited: Promise<Exited>; stderr: () => string } {
  const env = { ...process.env } as Record<string, string>;
  delete env["BRAIN_READ_ONLY"];
  const child = spawn(tsxBin, [entry, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let stderr = "";
  child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  const exited = new Promise<Exited>((resolve) => child.on("exit", (code) => resolve({ code, stderr })));
  return { child, exited, stderr: () => stderr };
}

async function holdPort(): Promise<number> {
  const server = createServer();
  netServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  return (server.address() as AddressInfo).port;
}

async function freePort(): Promise<number> {
  const port = await holdPort();
  const server = netServers.pop()!;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe("http entrypoint", () => {
  it("exits before listening when --host is not loopback", async () => {
    const { exited } = spawnHttp(["--host", "0.0.0.0"]);
    const { code, stderr } = await exited;
    expect(code).toBe(1);
    expect(stderr).toContain("network exposure is not supported");
    expect(stderr).not.toContain("ready on");
  }, 30_000);

  it("exits naming the port when it is already in use", async () => {
    const port = await holdPort();
    const { exited } = spawnHttp(["--port", String(port)]);
    const { code, stderr } = await exited;
    expect(code).toBe(1);
    expect(stderr).toContain(`port ${port} on 127.0.0.1 is already in use`);
    expect(stderr).not.toContain("ready on");
  }, 30_000);

  it("serves /healthz once ready, and exits 0 on SIGTERM", async () => {
    const port = await freePort();
    const { child, exited, stderr } = spawnHttp(["--port", String(port)]);
    const ready = `ready on http://127.0.0.1:${port}/mcp`;
    const deadline = Date.now() + 20_000;
    while (!stderr().includes(ready)) {
      if (child.exitCode !== null || Date.now() > deadline) throw new Error(`never became ready — stderr=${stderr()}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(200);

    child.kill("SIGTERM");
    const { code } = await exited;
    expect(code).toBe(0);
  }, 30_000);
});
