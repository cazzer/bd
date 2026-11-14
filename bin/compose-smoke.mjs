#!/usr/bin/env node
// `pnpm smoke:app` (tailnet-hosting task 2.5): brings up docker-compose.app.yml
// as its own project, mints a human and an agent token inside the app
// container, exercises both servers through the published ports from the
// host (so every request is off loopback and needs a token), drives a little
// load, then checks each container's caps, OOM state, restarts, and peak
// memory. Tears the project and its volumes down at the end unless --keep,
// and on SIGINT/SIGTERM too (then exits 130/143).
//
// Not part of `pnpm check`: it needs docker and builds the image.
//
// Every compose call goes through composeArgs (project breakdown-smoke),
// never the dev database's project `bd`.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SMOKE_PROJECT, SmokeFailure, TOKEN_OUTPUT, TOTAL_LIMIT_BYTES, composeArgs, formatTable, hardeningProblems, limitProblems, mib,
  parseInspect, parseMemoryPeak, parseStatsMemUsage, sumLimits,
} from "./compose-smoke-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB_PORT = 14310;
const MCP_PORT = 15320;
const LOAD_ROUNDS = 50;
const keep = process.argv.includes("--keep");

// Compose reads these; the smoke run owns its project, file, ports, and volumes.
const env = { ...process.env };
for (const name of ["COMPOSE_PROJECT_NAME", "COMPOSE_FILE", "BREAKDOWN_PGDATA", "BREAKDOWN_MEDIA", "BREAKDOWN_ALLOW_HOSTS"]) {
  delete env[name];
}
Object.assign(env, {
  BREAKDOWN_DB_PASSWORD: randomBytes(24).toString("hex"),
  BREAKDOWN_WEB_PORT: String(WEB_PORT),
  BREAKDOWN_MCP_PORT: String(MCP_PORT),
  BREAKDOWN_PUBLISH_ADDR: "127.0.0.1",
});

function docker(args, { capture = false, allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { cwd: ROOT, env, stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => (stdout += chunk));
    child.stderr?.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0 || allowFail) resolve({ code, stdout, stderr });
      else reject(new SmokeFailure(`docker ${args.join(" ")} exited ${code}${stderr ? `:\n${stderr.trim()}` : ""}`));
    });
  });
}

const compose = (args, options) => docker(composeArgs(args), options);

function portIsFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

function request(port, { method = "GET", path: target, token, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: target,
        agent: false,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
        timeout: 15_000,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
      },
    );
    req.on("timeout", () => req.destroy(new Error(`${method} ${target} on ${port} timed out`)));
    req.on("error", reject);
    req.end(body);
  });
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
}

async function mintToken(client, scope) {
  const { stdout } = await compose(["exec", "-T", "breakdown", "node", "dist/token.mjs", "create", client, "--scope", scope], { capture: true });
  check(`token ${client} --scope ${scope} prints the token alone`, TOKEN_OUTPUT.test(stdout));
  if (!TOKEN_OUTPUT.test(stdout)) throw new SmokeFailure(`token CLI printed an unexpected shape for ${client}`);
  return stdout.trim();
}

async function checkHealth(human, agent) {
  const webAnon = await request(WEB_PORT, { path: "/healthz" });
  check("web /healthz without a token → 401 + WWW-Authenticate: Bearer", webAnon.status === 401 && webAnon.headers["www-authenticate"] === "Bearer", `${webAnon.status}`);
  const webHuman = await request(WEB_PORT, { path: "/healthz", token: human });
  check("web /healthz with the human token → 200", webHuman.status === 200, `${webHuman.status}`);
  const webAgent = await request(WEB_PORT, { path: "/healthz", token: agent });
  check("web /healthz with the agent token → 403", webAgent.status === 403, `${webAgent.status}`);
  const mcpAnon = await request(MCP_PORT, { path: "/healthz" });
  check("mcp /healthz without a token → 401 + WWW-Authenticate: Bearer", mcpAnon.status === 401 && mcpAnon.headers["www-authenticate"] === "Bearer", `${mcpAnon.status}`);
  const mcpAgent = await request(MCP_PORT, { path: "/healthz", token: agent });
  check("mcp /healthz with the agent token → 200", mcpAgent.status === 200, `${mcpAgent.status}`);
}

async function checkClient() {
  const index = await request(WEB_PORT, { path: "/" });
  check("GET / without a token → 200 HTML with the app root", index.status === 200 && /text\/html/.test(index.headers["content-type"] ?? "") && index.body.includes('id="root"'), `${index.status}`);
  const script = /["'](\/assets\/[^"']+\.js)["']/.exec(index.body)?.[1];
  if (!script) {
    check("index.html references a hashed /assets/*.js", false);
  } else {
    const asset = await request(WEB_PORT, { path: script });
    check(`GET ${script} → 200, immutable`, asset.status === 200 && /immutable/.test(asset.headers["cache-control"] ?? ""), `${asset.status} ${asset.headers["cache-control"] ?? "no cache-control"}`);
  }
  const csp = index.headers["content-security-policy"] ?? "";
  check(
    "GET / sends X-Frame-Options: DENY and a CSP with frame-ancestors 'none' and no inline script",
    index.headers["x-frame-options"] === "DENY" && csp.includes("frame-ancestors 'none'") && /script-src 'self';/.test(csp),
    csp || "no CSP header",
  );
  check("index.html has no inline <script> (the header CSP would block it)", !/<script(?![^>]*\ssrc=)[^>]*>/i.test(index.body.replace(/<!--[\s\S]*?-->/g, "")));
  const stylesheet = /href=["'](\/assets\/[^"']+\.css)["']/.exec(index.body)?.[1];
  if (stylesheet) {
    const css = await request(WEB_PORT, { path: stylesheet });
    check(`GET ${stylesheet} → 200 text/css`, css.status === 200 && /text\/css/.test(css.headers["content-type"] ?? ""), `${css.status}`);
  }
  const trpc = await request(WEB_PORT, { path: "/trpc/reviewQueue" });
  check("GET /trpc/reviewQueue without a token → 401", trpc.status === 401, `${trpc.status}`);
}

const MCP_ACCEPT = { accept: "application/json, text/event-stream", "content-type": "application/json" };

async function openMcpSession(agent) {
  const init = await request(MCP_PORT, {
    method: "POST", path: "/mcp", token: agent, headers: MCP_ACCEPT,
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "compose-smoke", version: "1" } },
    }),
  });
  const sessionId = init.headers["mcp-session-id"];
  check("MCP initialize with the agent token → 200 + mcp-session-id", init.status === 200 && typeof sessionId === "string", `${init.status}`);
  if (init.status !== 200 || typeof sessionId !== "string") throw new SmokeFailure(`MCP initialize failed: ${init.status} ${init.body}`);
  const protocolVersion = JSON.parse(init.body).result.protocolVersion;
  const headers = { ...MCP_ACCEPT, "mcp-session-id": sessionId, "mcp-protocol-version": protocolVersion };
  const initialized = await request(MCP_PORT, {
    method: "POST", path: "/mcp", token: agent, headers,
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  check("MCP notifications/initialized → 202", initialized.status === 202, `${initialized.status}`);
  let nextId = 2;
  const callMap = () => request(MCP_PORT, {
    method: "POST", path: "/mcp", token: agent, headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name: "brain_map", arguments: {} } }),
  });
  const close = () => request(MCP_PORT, { method: "DELETE", path: "/mcp", token: agent, headers });
  return { callMap, close };
}

function mapSucceeded(res) {
  if (res.status !== 200) return false;
  const message = JSON.parse(res.body);
  return message.result !== undefined && message.result.isError !== true;
}

async function checkMcp(agent) {
  const session = await openMcpSession(agent);
  const first = await session.callMap();
  check("MCP tools/call brain_map → result", mapSucceeded(first), `${first.status}`);

  // A little load, so the peaks below mean something.
  let failures = 0;
  for (let round = 0; round < LOAD_ROUNDS; round++) {
    if (!mapSucceeded(await session.callMap())) failures++;
  }
  check(`${LOAD_ROUNDS} more brain_map calls succeed`, failures === 0, `${failures} failed`);

  const closed = await session.close();
  check("MCP DELETE closes the session → 200", closed.status === 200, `${closed.status}`);
}

async function loadWeb(human) {
  let failures = 0;
  for (let round = 0; round < LOAD_ROUNDS; round++) {
    const [summary, queue] = await Promise.all([
      request(WEB_PORT, { path: "/trpc/getStoreSummary", token: human }),
      request(WEB_PORT, { path: "/trpc/reviewQueue", token: human }),
    ]);
    if (summary.status !== 200) failures++;
    if (queue.status !== 200) failures++;
  }
  check(`${LOAD_ROUNDS * 2} tRPC reads with the human token → 200`, failures === 0, `${failures} failed`);
}

async function peakOf(service, name) {
  const { code, stdout } = await compose(["exec", "-T", service, "cat", "/sys/fs/cgroup/memory.peak"], { capture: true, allowFail: true });
  if (code === 0) return { peak: parseMemoryPeak(stdout), peakSource: "cgroup" };
  // No memory.peak (cgroup v1 or an older kernel): the current usage is the best docker offers.
  const stats = await docker(["stats", "--no-stream", "--format", "{{.MemUsage}}", name], { capture: true });
  return { peak: parseStatsMemUsage(stats.stdout.trim()).used, peakSource: "stats" };
}

async function checkContainers() {
  const { stdout: ids } = await compose(["ps", "-q"], { capture: true });
  const idList = ids.split("\n").filter(Boolean);
  if (idList.length !== 2) throw new SmokeFailure(`expected 2 containers in ${SMOKE_PROJECT}, found ${idList.length}`);
  const containers = parseInspect((await docker(["inspect", ...idList], { capture: true })).stdout);
  for (const container of containers) Object.assign(container, await peakOf(container.service, container.name));
  containers.sort((a, b) => String(a.service).localeCompare(String(b.service)));

  console.log("");
  for (const line of formatTable(containers)) console.log(line);
  console.log("");

  const app = containers.find((container) => container.service === "breakdown");
  const hardening = app ? hardeningProblems(app) : ["no breakdown container"];
  check("breakdown runs hardened (read-only root, all caps dropped, no-new-privileges, init)", hardening.length === 0, hardening.join("; "));
  const probe = await compose(["exec", "-T", "breakdown", "node", "-e", "require('fs').writeFileSync('/app/write-probe', '')"], { capture: true, allowFail: true });
  check("breakdown cannot write its root filesystem", probe.code !== 0 && /EROFS|read-only/i.test(probe.stderr), `exit ${probe.code}`);

  for (const container of containers) {
    const problems = limitProblems(container);
    check(`${container.service} holds its caps`, problems.length === 0, problems.join("; ") || `peak ${mib(container.peak)} of ${mib(container.memory)}`);
  }
  const total = sumLimits(containers);
  check("memory limits sum under 1 GB", total < TOTAL_LIMIT_BYTES, mib(total));
}

async function main() {
  for (const port of [WEB_PORT, MCP_PORT]) {
    if (!(await portIsFree(port))) throw new SmokeFailure(`port ${port} on 127.0.0.1 is in use; free it before the smoke run`);
  }
  // A stack a previous --keep run left behind is this project's own.
  await compose(["down", "-v", "--remove-orphans"]);
  await compose(["build", "breakdown"]);
  await compose(["up", "-d", "--wait", "--wait-timeout", "180"]);

  const human = await mintToken("smoke-human", "human");
  const agent = await mintToken("smoke-agent", "agent");
  await checkHealth(human, agent);
  await checkClient();
  await checkMcp(agent);
  await loadWeb(human);
  await checkContainers();
}

// One teardown, shared by the normal end and a stop signal, so a signal
// arriving mid-teardown waits for it rather than starting a second.
let teardown;
async function removeProject() {
  if (keep) {
    console.log(`--keep: leaving project ${SMOKE_PROJECT} up; remove it with BREAKDOWN_DB_PASSWORD=x docker compose -p ${SMOKE_PROJECT} -f docker-compose.app.yml down -v`);
    return true;
  }
  try {
    await compose(["down", "-v", "--remove-orphans"]);
    return true;
  } catch (err) {
    console.error(`teardown failed: ${err.message}`);
    return false;
  }
}
/** Resolves true when the project is gone (or --keep), false when `down` failed. */
function tearDown() {
  teardown ??= removeProject();
  return teardown;
}

let stopSignal = null;
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  // `once`: a second signal falls back to the default and ends the run at once.
  process.once(signal, async () => {
    stopSignal ??= signal;
    console.error(`\n${signal} received; ${keep ? "leaving the project up (--keep)" : `tearing down ${SMOKE_PROJECT}`}`);
    await tearDown();
    process.exit(code);
  });
}

let exitCode = 0;
try {
  await main();
  const failed = results.filter((result) => !result.ok);
  if (failed.length > 0) {
    console.error(`\n${failed.length} check(s) failed`);
    exitCode = 1;
  } else {
    console.log(`all ${results.length} checks passed`);
  }
} catch (err) {
  exitCode = 1;
  if (stopSignal === null) {
    console.error(`\nsmoke test stopped: ${err instanceof Error ? err.message : String(err)}`);
    await compose(["logs", "--no-color", "--tail", "80"]).catch(() => {});
  }
} finally {
  if (!(await tearDown())) exitCode = 1;
}
// A signal's handler owns the exit (130/143) once it has fired.
if (stopSignal === null) process.exit(exitCode);
