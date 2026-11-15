#!/usr/bin/env node
// `DATABASE_URL=<throwaway> pnpm hangar:release-e2e`: releasing hangar
// sessions end to end (hangar-release tasks.md 1.5), with this script as
// the fake hangar. It starts its own web server and MCP HTTP server on free
// loopback ports against DATABASE_URL, and stops them again.
//
// The database must be a throwaway one, created and migrated for the run and
// dropped after it: the run tables, accepts, and releases sessions, which a
// real hangar would act on. So DATABASE_URL must be set in the environment,
// the repo's .env must exist and name the live store's DATABASE_URL, the two
// must not share host, port, and database name, and the database name must
// start with `bd_test_` or end with `_test` or `_e2e`; the script refuses
// otherwise. It drops nothing itself.
//
// It plays four parts:
// - a fake hangar: its own `hangar` token (minted and revoked here), which
//   checks in, claims, reports state, and acknowledges releases;
// - an agent: a plain `agent` token (no session), the sessions' driver,
//   which releases a session itself over MCP (brain_hangar_outcome);
// - the person: tokenless loopback tRPC and MCP;
// - nobody else: every tokened call carries `X-Forwarded-For: 192.0.2.10`
//   (a documentation address), which makes it a remote request whose token
//   is checked, as hangar's are in production.
//
// Three sessions are requested for one fixture work item:
//   A  stopped → listed with outcome null → the person tables it → listed
//      first with outcome tabled → hangar's ack (container and disk_path
//      null) → released → a changed outcome is refused (CONFLICT), and so is
//      un-releasing it (409 session_ended)
//   B  stopped → an ack before any outcome is refused (409 session_ended) →
//      the agent cannot write an outcome request's key with brain_write →
//      the retired brain_hangar_outcome_request files nothing → the driver
//      releases it itself with brain_hangar_outcome → outcome accepted, by
//      the agent's client (hangar-driver-decisions)
//   C  a `reason` sent with state running is ignored → failed with a reason
//      → failure_reason shown on the board's listing
// Not part of `pnpm check`: it spawns servers and needs a database.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REMOTE = { "X-Forwarded-For": "192.0.2.10" };
const CLIENT_INFO = { name: "hangar-release-e2e", version: "1" };
const PROTOCOL_VERSION = "2025-06-18";
const RUN = randomBytes(4).toString("hex");
const HANGAR = `e2e-release-hangar-${RUN}`;
const AGENT = `e2e-release-agent-${RUN}`;
const ACCEPT_NOTE = "The work landed; nothing on the disk is needed.";

// --- Output ---------------------------------------------------------------------

let failures = 0;
const steps = [];

/** Runs one step; prints PASS or FAIL with its detail. A failure stops the run (cleanup still runs). */
async function step(name, fn) {
  const started = Date.now();
  try {
    const { value, detail } = (await fn()) ?? {};
    const line = `PASS  ${name}${detail ? ` — ${detail}` : ""} (${Date.now() - started} ms)`;
    steps.push(line);
    console.log(line);
    return value;
  } catch (err) {
    failures += 1;
    const line = `FAIL  ${name} — ${err instanceof Error ? err.message : String(err)}`;
    steps.push(line);
    console.log(line);
    throw new StepFailed();
  }
}

class StepFailed extends Error {}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

const short = (value) => {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
};

// --- The database guard -------------------------------------------------------------

/** Host (loopback names folded together), port (5432 when absent), and database name of a postgres URL; null when it does not parse. */
function databaseTarget(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (name === "") return null;
  return { host: ["localhost", "127.0.0.1", "::1"].includes(host) ? "loopback" : host, port: parsed.port || "5432", name };
}

const THROWAWAY_NAME = /^bd_test_|_test$|_e2e$/;

function refuse(message) {
  console.error(message);
  process.exit(2);
}

function assertThrowawayDatabase() {
  const url = process.env.DATABASE_URL;
  if (!url) refuse("DATABASE_URL is not set. Create and migrate a throwaway database, then run with DATABASE_URL pointing at it.");
  const target = databaseTarget(url);
  if (target === null) refuse("DATABASE_URL does not parse as a postgres URL with a database name.");
  const envFile = path.join(REPO_ROOT, ".env");
  if (!existsSync(envFile)) refuse(`${envFile} does not exist, so there is no telling which database is the live store. Create it (see .env.example) before running this.`);
  const parsed = createRequire(path.join(REPO_ROOT, "packages", "db", "package.json"))("dotenv").parse(readFileSync(envFile));
  const live = parsed.DATABASE_URL ? databaseTarget(parsed.DATABASE_URL) : null;
  if (live === null) refuse(`${envFile} names no parseable DATABASE_URL, so there is no telling which database is the live store.`);
  if (live.host === target.host && live.port === target.port && live.name === target.name) {
    refuse(`DATABASE_URL names database "${target.name}" on ${target.host}:${target.port}, the one in ${envFile} (the live store). Use a throwaway database.`);
  }
  if (!THROWAWAY_NAME.test(target.name)) refuse(`Database "${target.name}" is not named as a throwaway one: its name must start with bd_test_ or end with _test or _e2e.`);
  return target.name;
}

// --- Servers ----------------------------------------------------------------------------

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function childEnv() {
  const env = { ...process.env };
  for (const key of ["BRAIN_READ_ONLY", "HERDR_SOCKET_PATH", "HERDR_PANE_ID"]) delete env[key];
  return env;
}

/** A long-running child whose output is kept for the failure report. */
class Service {
  constructor(label, args, cwd) {
    this.label = label;
    this.lines = [];
    this.exitCode = undefined;
    this.child = spawn(process.execPath, args, { cwd, env: childEnv(), stdio: ["ignore", "pipe", "pipe"] });
    this.exited = new Promise((resolve) => this.child.on("exit", (code, signal) => resolve((this.exitCode = code ?? signal))));
    for (const stream of [this.child.stdout, this.child.stderr]) {
      let partial = "";
      stream.on("data", (chunk) => {
        partial += chunk;
        const parts = partial.split("\n");
        partial = parts.pop();
        this.lines.push(...parts);
      });
    }
  }
  tail(n = 20) {
    return this.lines.slice(-n).map((l) => `        ${this.label}| ${l}`).join("\n");
  }
  async stop(ms = 15_000) {
    if (this.exitCode !== undefined) return this.exitCode;
    this.child.kill("SIGTERM");
    const code = await Promise.race([this.exited, sleep(ms).then(() => null)]);
    if (code === null) {
      this.child.kill("SIGKILL");
      return `killed after ${ms / 1000} s`;
    }
    return code;
  }
}

/** Polls `probe` until it answers true, the service exits, or `ms` passes. */
async function waitUntilUp(service, probe, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (service.exitCode !== undefined) throw new Error(`${service.label} exited (${service.exitCode}):\n${service.tail()}`);
    if (await probe().catch(() => false)) return;
    if (Date.now() > deadline) throw new Error(`${service.label} did not answer within ${ms / 1000} s:\n${service.tail()}`);
    await sleep(200);
  }
}

// --- HTTP -----------------------------------------------------------------------

let WEB = "";
let MCP = "";

function headersFor(token, extra = {}) {
  return { ...(token ? { Authorization: `Bearer ${token}`, ...REMOTE } : {}), ...extra };
}

async function send(base, method, pathname, { token, body, headers } = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: headersFor(token, { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text === "" ? null : JSON.parse(text);
  } catch {
    // not JSON; the caller reports the text
  }
  return { status: res.status, headers: res.headers, text, json };
}

const hangarApi = (method, pathname, options) => send(WEB, method, `/hangar/v1${pathname}`, options);

async function trpcQuery(procedure, input, token) {
  const query = input === undefined ? "" : `?input=${encodeURIComponent(JSON.stringify(input))}`;
  const sent = await send(WEB, "GET", `/trpc/${procedure}${query}`, { token });
  expect(sent.status === 200, `${procedure} answered ${sent.status}: ${short(sent.text)}`);
  return sent.json.result.data;
}

/** A tRPC mutation's raw answer: callers that expect a refusal read `status` and `json.error`. */
const trpcSend = (procedure, input, token) => send(WEB, "POST", `/trpc/${procedure}`, { token, body: input });

async function trpcMutation(procedure, input, token) {
  const sent = await trpcSend(procedure, input, token);
  expect(sent.status === 200, `${procedure} answered ${sent.status}: ${short(sent.text)}`);
  return sent.json.result.data;
}

/** PATCH a session as the fake hangar; expects 200 and returns the session JSON. */
async function patchSession(id, body) {
  const sent = await hangarApi("PATCH", `/sessions/${id}`, { token: state.hangarToken, body });
  expect(sent.status === 200, `PATCH ${short(body)} answered ${sent.status}: ${short(sent.text)}`);
  return sent.json.session;
}

async function endedSessions() {
  const sent = await hangarApi("GET", "/sessions?state=stopped&state=failed", { token: state.hangarToken });
  expect(sent.status === 200, `GET /sessions answered ${sent.status}: ${short(sent.text)}`);
  return sent.json.sessions;
}

// --- MCP over Streamable HTTP (JSON responses) -------------------------------------

class McpSession {
  constructor(token) {
    this.token = token;
    this.sessionId = null;
    this.protocolVersion = PROTOCOL_VERSION;
    this.nextId = 1;
  }

  headers() {
    return {
      Accept: "application/json, text/event-stream",
      ...(this.sessionId ? { "mcp-session-id": this.sessionId, "mcp-protocol-version": this.protocolVersion } : {}),
    };
  }

  async open() {
    const sent = await send(MCP, "POST", "", {
      token: this.token,
      headers: this.headers(),
      body: { jsonrpc: "2.0", id: this.nextId++, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO } },
    });
    if (sent.status !== 200) return sent.status;
    this.sessionId = sent.headers.get("mcp-session-id");
    this.protocolVersion = sent.json?.result?.protocolVersion ?? PROTOCOL_VERSION;
    expect(this.sessionId, "initialize returned no mcp-session-id");
    const ack = await send(MCP, "POST", "", { token: this.token, headers: this.headers(), body: { jsonrpc: "2.0", method: "notifications/initialized" } });
    expect(ack.status === 202 || ack.status === 200, `notifications/initialized answered ${ack.status}`);
    return 200;
  }

  async call(name, args) {
    const sent = await send(MCP, "POST", "", { token: this.token, headers: this.headers(), body: { jsonrpc: "2.0", id: this.nextId++, method: "tools/call", params: { name, arguments: args } } });
    expect(sent.status === 200, `${name} answered HTTP ${sent.status}: ${short(sent.text)}`);
    expect(!sent.json.error, `${name}: ${short(sent.json.error)}`);
    const text = sent.json.result?.content?.[0]?.text ?? "";
    expect(!sent.json.result.isError, `${name} refused: ${short(text)}`);
    return JSON.parse(text);
  }

  /** A tool call whose refusal is expected: `{ isError, text }`. */
  async callRaw(name, args) {
    const sent = await send(MCP, "POST", "", { token: this.token, headers: this.headers(), body: { jsonrpc: "2.0", id: this.nextId++, method: "tools/call", params: { name, arguments: args } } });
    expect(sent.status === 200, `${name} answered HTTP ${sent.status}: ${short(sent.text)}`);
    expect(!sent.json.error, `${name}: ${short(sent.json.error)}`);
    return { isError: sent.json.result?.isError === true, text: sent.json.result?.content?.[0]?.text ?? "" };
  }

  async close() {
    if (this.sessionId === null) return;
    await send(MCP, "DELETE", "", { token: this.token, headers: this.headers() }).catch(() => {});
    this.sessionId = null;
  }
}

// --- The host CLI ---------------------------------------------------------------------

function clientToken(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["-s", "client-token", ...args], { cwd: REPO_ROOT, env: childEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(stdout.trim()) : reject(new Error(`client-token ${args[0]} exited ${code}: ${stderr.trim()}`))));
  });
}

// --- The run ---------------------------------------------------------------------------

const state = {
  hangarToken: null,
  hangarRevoked: false,
  agentToken: null,
  agentRevoked: false,
  workItemId: null,
  /** label → { id, token, ended } */
  sessions: new Map(),
  inboxItemId: null,
};
const services = [];
const person = new McpSession(null);
let agent = null;

const sessionOf = (label) => state.sessions.get(label);

async function run(dbName) {
  await step(`start a web server and an MCP server on database ${dbName}`, async () => {
    const webPort = await freePort();
    const mcpPort = await freePort();
    WEB = `http://127.0.0.1:${webPort}`;
    MCP = `http://127.0.0.1:${mcpPort}/mcp`;
    const web = new Service("web", ["--import", "tsx", "server/index.ts", "--port", String(webPort)], path.join(REPO_ROOT, "apps", "web"));
    const mcp = new Service("mcp", ["--import", "tsx", "src/http.ts", "--port", String(mcpPort), "--host", "127.0.0.1"], path.join(REPO_ROOT, "apps", "mcp"));
    services.push(web, mcp);
    await waitUntilUp(web, async () => (await send(WEB, "GET", "/trpc/hangarStatus")).status === 200, 60_000);
    await waitUntilUp(mcp, async () => (await person.open()) === 200, 60_000);
    const status = await trpcQuery("hangarStatus");
    expect(status.queued === 0, `${status.queued} session(s) are already queued in this database; a throwaway database has none`);
    return { detail: `web ${WEB}, mcp ${MCP}` };
  });

  state.hangarToken = await step(`mint the hangar token ${HANGAR} and the agent token ${AGENT}`, async () => {
    const hangar = await clientToken(["create", HANGAR, "--scope", "hangar"]);
    expect(/^bdt_\S+$/.test(hangar), "client-token create printed no hangar token");
    state.agentToken = await clientToken(["create", AGENT, "--scope", "agent"]);
    expect(/^bdt_\S+$/.test(state.agentToken), "client-token create printed no agent token");
    return { value: hangar, detail: "scopes hangar, agent" };
  });

  await step("hangar checks in", async () => {
    const sent = await hangarApi("POST", "/check-in", { token: state.hangarToken, body: { version: `e2e-${RUN}`, capacity: { slots: { headless: 3 } } } });
    expect(sent.status === 200, `check-in answered ${sent.status}: ${short(sent.text)}`);
    return { detail: `interval_s ${sent.json.interval_s}` };
  });

  state.workItemId = await step("the person writes a fixture work item over tokenless MCP", async () => {
    const written = await person.call("brain_write", { items: { nodeType: "work_item", externalId: `e2e-release-${RUN}`, title: `e2e-release ${RUN}: fixture work item`, content: "Written by bin/hangar-release-e2e.mjs.", metadata: { status: "open", priority: 4 } } });
    const id = written.items?.[0]?.id;
    expect(id, `brain_write returned no id: ${short(written)}`);
    return { value: id, detail: id };
  });

  await step("the person requests three headless sessions for it over tokenless MCP", async () => {
    for (const label of ["A", "B", "C"]) {
      const result = await person.call("brain_hangar_request", { repo: "cazzer/bd", workItemId: state.workItemId, flavor: "headless" });
      expect(result.state === "queued", `${label}: state is ${result.state}`);
      state.sessions.set(label, { id: result.sessionId, token: null, ended: false });
    }
    return { detail: [...state.sessions].map(([label, s]) => `${label} ${s.id}`).join(", ") };
  });

  await step("hangar claims all three (token path: X-Forwarded-For set)", async () => {
    const wanted = new Map([...state.sessions].map(([label, s]) => [s.id, label]));
    for (let i = 0; i < 3; i += 1) {
      const sent = await hangarApi("POST", "/claim", { token: state.hangarToken, body: { flavors: ["headless"], wait_s: 0 } });
      expect(sent.status === 200, `claim answered ${sent.status}: ${short(sent.text)}`);
      const claimed = sent.json.session;
      expect(claimed !== null, `claim ${i + 1} found nothing`);
      const label = wanted.get(claimed.id);
      expect(label !== undefined, `claimed ${claimed.id}, which this run did not request`);
      expect(claimed.claimed_by === HANGAR && claimed.outcome === null && claimed.released === false, `claimed session reads ${short(claimed)}`);
      sessionOf(label).token = sent.json.token;
    }
    return { detail: "3 claimed, each with a session token" };
  });

  await step("hangar reports A running then stopped, then B the same (B changed last)", async () => {
    for (const label of ["A", "B"]) {
      const { id } = sessionOf(label);
      const running = await patchSession(id, { state: "running", container: `c-${label}-${RUN}`, host: "e2e-host", disk_path: `/var/lib/hangar/disks/${id}.img` });
      expect(running.state === "running" && running.disk_path !== null, `${label} running reads ${short(running)}`);
      const stopped = await patchSession(id, { state: "stopped" });
      expect(stopped.state === "stopped" && stopped.outcome === null, `${label} stopped reads ${short(stopped)}`);
      sessionOf(label).ended = true;
    }
    return { detail: "A, B stopped holding disks" };
  });

  await step("hangar's ack of B before any outcome is refused (409 session_ended): B keeps its disk", async () => {
    const sent = await hangarApi("PATCH", `/sessions/${sessionOf("B").id}`, { token: state.hangarToken, body: { container: null, disk_path: null } });
    expect(sent.status === 409 && sent.json?.error?.code === "session_ended", `answered ${sent.status}: ${short(sent.text)}`);
    const b = (await endedSessions()).find((s) => s.id === sessionOf("B").id);
    expect(b.disk_path !== null && b.container !== null && b.released === false, `B reads ${short(b)}`);
    return { detail: `409: ${short(sent.json.error.message)}` };
  });

  await step("GET /sessions?state=stopped&state=failed lists A with outcome null", async () => {
    const listed = await endedSessions();
    const a = listed.find((s) => s.id === sessionOf("A").id);
    expect(a, `A is not listed: ${short(listed.map((s) => s.id))}`);
    expect(a.outcome === null && a.outcome_at === null && a.released === false, `A reads ${short(a)}`);
    expect(listed[0].id === sessionOf("B").id, `B (changed last) is not first: ${short(listed.map((s) => s.id))}`);
    return { detail: `order ${listed.map((s) => (s.id === sessionOf("A").id ? "A" : s.id === sessionOf("B").id ? "B" : s.id)).join(", ")}` };
  });

  await step("the person tables A over tokenless loopback tRPC", async () => {
    const set = await trpcMutation("hangarSessionOutcome", { id: sessionOf("A").id, outcome: "tabled" });
    expect(set.outcome === "tabled" && set.changed === true && set.released === false && set.outcomeBy === "human", `hangarSessionOutcome answered ${short(set)}`);
    return { detail: `outcome_by ${set.outcomeBy}, outcome_at ${set.outcomeAt}` };
  });

  await step("GET /sessions lists A first, with outcome tabled, not yet released", async () => {
    const listed = await endedSessions();
    expect(listed[0]?.id === sessionOf("A").id, `A is not first: ${short(listed.map((s) => s.id))}`);
    expect(listed[0].outcome === "tabled" && listed[0].outcome_by === "human" && listed[0].released === false && listed[0].disk_path !== null, `A reads ${short(listed[0])}`);
    const releasable = await person.call("brain_hangar_sessions", { workItemId: state.workItemId, releasable: true });
    expect(releasable.sessions.length === 1 && releasable.sessions[0].id === sessionOf("A").id, `brain_hangar_sessions releasable lists ${short(releasable.sessions.map((s) => s.id))}`);
    return { detail: `outcome_at ${listed[0].outcome_at}; brain_hangar_sessions releasable: A only` };
  });

  await step("the board's hangarSessions shows A tabled with its disk held", async () => {
    const board = await trpcQuery("hangarSessions", { workItemId: state.workItemId });
    const a = board.sessions.find((s) => s.id === sessionOf("A").id);
    expect(board.sessions.length === 3, `hangarSessions lists ${board.sessions.length} sessions`);
    expect(a?.outcome === "tabled" && a.diskHeld === true && a.released === false, `A reads ${short(a)}`);
    return { detail: board.sessions.map((s) => `${s.state}/${s.outcome ?? "-"}`).join(", ") };
  });

  await step("hangar acks the release (container and disk_path null): A is released", async () => {
    const acked = await patchSession(sessionOf("A").id, { container: null, disk_path: null });
    expect(acked.released === true && acked.container === null && acked.disk_path === null && acked.outcome === "tabled" && acked.state === "stopped", `ack answered ${short(acked)}`);
    const releasable = await person.call("brain_hangar_sessions", { workItemId: state.workItemId, releasable: true });
    expect(releasable.sessions.length === 0, `releasable still lists ${short(releasable.sessions.map((s) => s.id))}`);
    return { detail: "released true; releasable lists nothing" };
  });

  await step("changing A's outcome now is refused (CONFLICT), in the person's words", async () => {
    const sent = await trpcSend("hangarSessionOutcome", { id: sessionOf("A").id, outcome: "accepted" });
    expect(sent.status === 409 && sent.json?.error?.data?.code === "CONFLICT", `answered ${sent.status}: ${short(sent.text)}`);
    expect(sent.json.error.message === "This session is already released: hangar has removed its disk, so the outcome can't change.", `message: ${short(sent.json.error.message)}`);
    const board = await trpcQuery("hangarSessions", { workItemId: state.workItemId });
    const a = board.sessions.find((s) => s.id === sessionOf("A").id);
    expect(a.outcome === "tabled" && a.released === true, `A reads ${short(a)}`);
    return { detail: `409: ${short(sent.json.error.message)}` };
  });

  await step("un-releasing A (a disk_path value) is refused (409 session_ended); a repeated ack still answers 200", async () => {
    const sent = await hangarApi("PATCH", `/sessions/${sessionOf("A").id}`, { token: state.hangarToken, body: { disk_path: `/var/lib/hangar/disks/${sessionOf("A").id}.img` } });
    expect(sent.status === 409 && sent.json?.error?.code === "session_ended", `answered ${sent.status}: ${short(sent.text)}`);
    const again = await patchSession(sessionOf("A").id, { container: null, disk_path: null });
    expect(again.released === true && again.disk_path === null, `repeated ack reads ${short(again)}`);
    return { detail: "409 session_ended; repeated ack 200, released" };
  });

  agent = new McpSession(state.agentToken);
  await step("the agent cannot write B's outcome request key with brain_write: refused, nothing stored", async () => {
    expect((await agent.open()) === 200, "MCP initialize with the agent token was refused");
    const key = `hangar-outcome:${sessionOf("B").id}`;
    const refused = await agent.callRaw("brain_write", {
      items: { nodeType: "inbox_item", sourceSystem: "inbox", externalId: key, title: "Accept", content: "Releases nothing. Safe to click.", metadata: { source: "hangar", question: "Keep the disk?", options: [{ id: "accept", label: "Keep" }, { id: "table", label: "Later" }], recommend: "accept" } },
    });
    expect(refused.isError && /reserved/.test(refused.text), `brain_write answered ${short(refused)}`);
    const inbox = await trpcQuery("inbox", { statuses: ["pending", "undigested", "accepted", "done", "dismissed", "changes", "session"] });
    expect(!inbox.items.some((i) => i.externalId === key), `an item is stored at ${key}`);
    return { detail: short(refused.text.split(".")[0]) };
  });

  await step("the retired brain_hangar_outcome_request files nothing and points at brain_hangar_outcome; B's outcome is still null", async () => {
    const retired = await agent.callRaw("brain_hangar_outcome_request", { sessionId: sessionOf("B").id, outcome: "accepted", note: ACCEPT_NOTE });
    expect(retired.isError && /retired/.test(retired.text) && /brain_hangar_outcome \{/.test(retired.text), `brain_hangar_outcome_request answered ${short(retired)}`);
    const inbox = await trpcQuery("inbox", { statuses: ["pending", "undigested"] });
    expect(!inbox.items.some((i) => i.externalId === `hangar-outcome:${sessionOf("B").id}`), "an outcome request was filed");
    const b = (await endedSessions()).find((s) => s.id === sessionOf("B").id);
    expect(b.outcome === null, `B's outcome is ${b.outcome}`);
    return { detail: short(retired.text.split(".")[0]) };
  });

  await step("the driver releases B itself (brain_hangar_outcome accepted): outcome accepted by the agent's client, listed first, nothing in the inbox", async () => {
    const set = await agent.call("brain_hangar_outcome", { sessionId: sessionOf("B").id, outcome: "accepted", note: ACCEPT_NOTE });
    expect(set.outcome === "accepted" && set.outcomeBy === AGENT && set.changed === true, `brain_hangar_outcome answered ${short(set)}`);
    const listed = await endedSessions();
    expect(listed[0]?.id === sessionOf("B").id && listed[0].outcome === "accepted" && listed[0].outcome_by === AGENT, `B reads ${short(listed[0])}`);
    return { detail: `B accepted by ${AGENT}, listed first` };
  });

  await step("a reason sent with state running is ignored", async () => {
    const running = await patchSession(sessionOf("C").id, { state: "running", reason: "not a failure", container: `c-C-${RUN}` });
    expect(running.state === "running" && running.failure_reason === null, `C reads ${short(running)}`);
    return { detail: "200, failure_reason null" };
  });

  await step("hangar fails C with a reason: failure_reason shown on the board's listing", async () => {
    const failed = await patchSession(sessionOf("C").id, { state: "failed", reason: "git clone exited 128" });
    sessionOf("C").ended = true;
    expect(failed.state === "failed" && failed.failure_reason === "git clone exited 128", `C reads ${short(failed)}`);
    const board = await trpcQuery("hangarSessions", { workItemId: state.workItemId });
    const c = board.sessions.find((s) => s.id === sessionOf("C").id);
    expect(c?.failureReason === "git clone exited 128" && c.outcome === null, `the board reads ${short(c)}`);
    return { detail: `failureReason "${c.failureReason}"` };
  });

  await step("revoking both tokens stops them", async () => {
    await clientToken(["revoke", HANGAR]);
    state.hangarRevoked = true;
    await clientToken(["revoke", AGENT]);
    state.agentRevoked = true;
    const checkIn = await hangarApi("POST", "/check-in", { token: state.hangarToken, body: { version: `e2e-${RUN}` } });
    expect(checkIn.status === 401, `check-in with the revoked hangar token answered ${checkIn.status}`);
    const reopened = await new McpSession(state.agentToken).open();
    expect(reopened === 401, `MCP initialize with the revoked agent token answered ${reopened}`);
    return { detail: "check-in 401, MCP 401" };
  });
}

async function cleanup() {
  const notes = [];
  if (state.hangarToken !== null && !state.hangarRevoked) {
    for (const [label, s] of state.sessions) {
      if (s.token === null || s.ended) continue;
      const sent = await hangarApi("PATCH", `/sessions/${s.id}`, { token: state.hangarToken, body: { state: "failed" } }).catch((err) => ({ status: 0, text: String(err) }));
      notes.push(`marked ${label} ${s.id} failed: ${sent.status}`);
    }
  }
  for (const [name, token, revoked] of [
    [HANGAR, state.hangarToken, state.hangarRevoked],
    [AGENT, state.agentToken, state.agentRevoked],
  ]) {
    if (token === null || revoked) continue;
    await clientToken(["revoke", name]).then(
      () => notes.push(`revoked ${name}`),
      (err) => notes.push(`could not revoke ${name}: ${err.message}`),
    );
  }
  await agent?.close();
  await person.close();
  for (const service of services) notes.push(`stopped ${service.label}: ${await service.stop()}`);
  if (failures > 0) for (const service of services) if (service.lines.length > 0) notes.push(`${service.label} output:\n${service.tail()}`);
  return notes;
}

const dbName = assertThrowawayDatabase();
try {
  await run(dbName);
} catch (err) {
  if (!(err instanceof StepFailed)) {
    failures += 1;
    console.log(`FAIL  unexpected error — ${err instanceof Error ? err.stack : String(err)}`);
  }
} finally {
  const notes = await cleanup();
  for (const note of notes) console.log(`      cleanup: ${note}`);
  console.log(`      left in database ${dbName}: work item ${state.workItemId ?? "-"}, sessions ${[...state.sessions.values()].map((s) => s.id).join(", ") || "-"}; drop the database when done`);
  console.log(failures === 0 ? `hangar release e2e: all ${steps.length} steps passed` : `hangar release e2e: ${failures} failed of ${steps.length} run`);
  process.exitCode = failures === 0 ? 0 : 1;
}
