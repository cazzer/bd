// The real HTTP entrypoint (src/http.ts) spawned as a child process
// (brain-mcp spec, "Fail fast on misconfiguration" → "Port already in
// use"). No test here binds off loopback: a 0.0.0.0 listener raises the
// macOS firewall prompt.
// http-server.test.ts drives the server itself in-process.
//
// A child still running when a test ends gets SIGTERM, never SIGKILL: tsx
// forwards SIGTERM to the real node child, while SIGKILL would orphan it.

import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type AddressInfo, type Server } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const mcpRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsxBin = path.join(mcpRoot, "node_modules", ".bin", "tsx");
const entry = path.join(mcpRoot, "src", "http.ts");

interface Exited {
  code: number | null;
  stderr: string;
}

interface Spawned {
  child: ChildProcess;
  exited: Promise<Exited>;
  stderr: () => string;
}

const spawned: Spawned[] = [];
const netServers: Server[] = [];

afterEach(async () => {
  for (const { child, exited } of spawned.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  }
  await Promise.all(netServers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

function spawnHttp(args: string[]): Spawned {
  const env = { ...process.env } as Record<string, string>;
  delete env["BRAIN_READ_ONLY"];
  const child = spawn(tsxBin, [entry, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  const exited = new Promise<Exited>((resolve) => child.on("exit", (code) => resolve({ code, stderr })));
  const result = { child, exited, stderr: () => stderr };
  spawned.push(result);
  return result;
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

describe("http entrypoint", () => {
  it("exits naming the value for a malformed --allow-host, before listening", async () => {
    const { exited } = spawnHttp(["--port", "0", "--allow-host", "breakdown.tail.example:80"]);
    const { code, stderr } = await exited;
    expect(code).toBe(1);
    expect(stderr).toContain('cannot start: --allow-host: invalid allowed host "breakdown.tail.example:80"');
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

  it("serves /healthz on the ephemeral port its ready line names, and exits 0 on SIGTERM", async () => {
    const { child, exited, stderr } = spawnHttp(["--port", "0"]);
    const readyLine = /ready on http:\/\/127\.0\.0\.1:(\d+)\/mcp/;
    const deadline = Date.now() + 20_000;
    let match: RegExpMatchArray | null;
    while (!(match = stderr().match(readyLine))) {
      if (child.exitCode !== null || Date.now() > deadline) throw new Error(`never became ready — stderr=${stderr()}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const port = Number(match[1]);
    expect(port).toBeGreaterThan(0);
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(200);

    child.kill("SIGTERM");
    const { code } = await exited;
    expect(code).toBe(0);
  }, 30_000);
});
