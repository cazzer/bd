#!/usr/bin/env node
// `pnpm relay:e2e`: the laptop relay end to end on this Mac (laptop-relay
// tasks.md 1.8). It starts everything it needs and stops it again:
//
//   queue mode   a web server whose PATH has neither `bd` nor `herdr` (so it
//                queues), a forwarding proxy in front of it, and the real
//                relay (bin/relay.mjs) pointed at the proxy. Accept with an
//                option, request changes, and an inbox reply each queue an
//                action the relay runs and reports; a bead edit in the
//                scratch checkout reaches the board's SSE stream.
//   direct mode  the web server again with `bd` and the stub `herdr` on PATH:
//                the same three decisions run in the server, and none is
//                queued.
//
// Safety:
// - It refuses to start while any relay action is queued or claimed: the
//   relay would claim it, and it could be a real decision.
// - `herdr` is a stub (a node script appending its argv, HERDR_SOCKET_PATH,
//   and its parent pid to a log) in a temp bin directory, and the socket
//   it is pointed at is a real unix socket this script listens on, so the
//   real herdr is never run. Both PATHs are asserted before anything starts.
// - The only beads checkout written is the scratch one at
//   ~/Library/Caches/breakdown/relay-e2e, emptied at the start of each run
//   and registered as project `e2e-relay`; the relay runs with
//   `--project e2e-relay`. (The direct-mode server's own watcher reads the
//   other registered checkouts with `bd list`, as `pnpm dev` does.)
// - Admission trusts a loopback request without reading its token, so the
//   relay talks to a proxy that adds `X-Forwarded-For: 192.0.2.10` (a
//   documentation address) and sets Host to the allowed name: the token
//   path, as from another machine. The person's calls are tokenless loopback.
// - The relay token (`e2e-relay-<run>`, scope relay) lives in a 0600 file
//   in the temp directory and is revoked at the end.
//
// Left in place: the scratch checkout and its beads, the store's
// `e2e-relay` project and its items, the two inbox items (completed), the
// relay actions, and the relay's check-in row. The ids are printed. Not
// part of `pnpm check`: it needs the database, `bd`, and a few minutes.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, chmodSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB_DIR = path.join(REPO_ROOT, "apps", "web");
const RUN = randomBytes(4).toString("hex");
const RELAY_CLIENT = `e2e-relay-${RUN}`;
const PROJECT = "e2e-relay";
const ALLOWED_HOST = "breakdown.tail.example";
const SCRATCH = path.join(os.homedir(), "Library", "Caches", "breakdown", "relay-e2e");
const SYSTEM_PATH = "/usr/bin:/bin";
const REVIEW_PANE = "e2e-pane-1";
const INBOX_PANE = "e2e-pane-2";
const ACTION_DEADLINE_MS = 60_000;
const BOARD_EVENT_DEADLINE_MS = 15_000;

// --- Output ---------------------------------------------------------------------

let failures = 0;
const steps = [];
class StepFailed extends Error {}

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

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

const short = (value) => {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
};

// --- Processes ----------------------------------------------------------------------

function findOnPath(binary, pathEnv) {
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

/** The environment children get: ours with PATH replaced and nothing that could point bd or herdr elsewhere. */
function childEnv(pathEnv) {
  const env = { ...process.env, PATH: pathEnv };
  for (const key of ["BEADS_DIR", "BEADS_DB", "HERDR_SOCKET_PATH", "HERDR_PANE_ID", "BRAIN_READ_ONLY"]) delete env[key];
  return env;
}

/** Runs a command to completion; resolves { code, stdout, stderr }. */
function run(cmd, args, { cwd, env = childEnv(process.env.PATH), timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function must(cmd, args, options) {
  const result = await run(cmd, args, options);
  if (result.code !== 0) throw new Error(`${path.basename(cmd)} ${args.slice(0, 2).join(" ")} exited ${result.code}: ${short(result.stderr.trim() || result.stdout.trim())}`);
  return result.stdout;
}

/** A long-running child whose output is kept (prefixed) for the failure report. */
class Service {
  constructor(label, cmd, args, { cwd, env }) {
    this.label = label;
    this.lines = [];
    this.exitCode = undefined;
    this.child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
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
  get pid() {
    return this.child.pid;
  }
  has(pattern) {
    return this.lines.some((l) => pattern.test(l));
  }
  async waitFor(pattern, ms, what) {
    const deadline = Date.now() + ms;
    while (!this.has(pattern)) {
      if (this.exitCode !== undefined) throw new Error(`${this.label} exited (${this.exitCode}) before ${what}:\n${this.tail()}`);
      if (Date.now() > deadline) throw new Error(`no ${what} from ${this.label} within ${ms / 1000} s:\n${this.tail()}`);
      await sleep(100);
    }
  }
  tail(n = 25) {
    return this.lines.slice(-n).map((l) => `        ${this.label}| ${l}`).join("\n");
  }
  async stop(ms = 20_000) {
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

// --- HTTP ---------------------------------------------------------------------------

async function send(base, method, pathname, body) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text === "" ? null : JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, text, json };
}

async function trpcQuery(base, procedure, input) {
  const query = input === undefined ? "" : `?input=${encodeURIComponent(JSON.stringify(input))}`;
  const sent = await send(base, "GET", `/trpc/${procedure}${query}`);
  expect(sent.status === 200, `${procedure} answered ${sent.status}: ${short(sent.text)}`);
  return sent.json.result.data;
}

async function trpcMutation(base, procedure, input) {
  const sent = await send(base, "POST", `/trpc/${procedure}`, input);
  expect(sent.status === 200, `${procedure} answered ${sent.status}: ${short(sent.text)}`);
  return sent.json.result.data;
}

/** The relay's way in: every request forwarded to the web server as if from another machine. */
function startProxy(target) {
  const server = http.createServer((req, res) => {
    const headers = { ...req.headers, host: ALLOWED_HOST, "x-forwarded-for": "192.0.2.10" };
    const upstream = http.request({ host: "127.0.0.1", port: target.port, method: req.method, path: req.url, headers }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { code: "proxy", message: "upstream unreachable" } }));
    });
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

/** Subscribes to `boardEvents` over SSE; `events` fills as frames arrive. */
function subscribeBoard(base) {
  const controller = new AbortController();
  const events = [];
  const opened = (async () => {
    const res = await fetch(`${base}/trpc/boardEvents`, { headers: { Accept: "text/event-stream" }, signal: controller.signal });
    expect(res.status === 200, `boardEvents answered ${res.status}`);
    void (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for await (const chunk of res.body) {
          buffer += decoder.decode(chunk, { stream: true });
          let at;
          while ((at = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, at);
            buffer = buffer.slice(at + 2);
            const data = frame
              .split("\n")
              .filter((l) => l.startsWith("data:"))
              .map((l) => l.slice(5).trim())
              .join("\n");
            if (data === "") continue;
            try {
              const parsed = JSON.parse(data);
              events.push(parsed?.data ?? parsed);
            } catch {
              // not a JSON frame
            }
          }
        }
      } catch {
        // closed
      }
    })();
  })();
  return { events, opened, close: () => controller.abort() };
}

// --- The database (read-only checks) -----------------------------------------------------

const requireFromDb = createRequire(path.join(REPO_ROOT, "packages", "db", "package.json"));

function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envFile = path.join(REPO_ROOT, ".env");
  expect(existsSync(envFile), `DATABASE_URL is not set and ${envFile} does not exist`);
  const parsed = requireFromDb("dotenv").parse(readFileSync(envFile));
  expect(parsed.DATABASE_URL, `${envFile} sets no DATABASE_URL`);
  return parsed.DATABASE_URL;
}

// --- The run ---------------------------------------------------------------------------

const state = {
  tmp: null,
  socketServer: null,
  proxy: null,
  target: { port: 0 },
  web: null,
  relay: null,
  tokenFile: null,
  token: null,
  revoked: false,
  pg: null,
  reviews: {},
  inbox: [],
  actions: [],
};

function stubLog() {
  const file = path.join(state.tmp, "herdr.log");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l));
}

async function bd(args) {
  return must("bd", args, { cwd: SCRATCH, env: childEnv(process.env.PATH) });
}

async function bdJson(args) {
  const parsed = JSON.parse(await bd([...args, "--json"]));
  return Array.isArray(parsed) ? parsed[0] : parsed;
}

const OPTIONS = [
  { id: "a", label: "Keep one column" },
  { id: "b", label: "Two columns", what: "Split the review queue from the board", risk: "Narrow screens wrap" },
];
const QUESTION = "Which layout should the board use?";

async function createReview(title) {
  const created = await bdJson(["create", "--title", `e2e-relay ${RUN}: ${title}`, "--type", "task", "--labels", "review", "-d", "A fixture review filed by bin/relay-e2e.mjs.", "--acceptance", "The relay end-to-end check decides it."]);
  expect(typeof created?.id === "string", `bd create printed no id: ${short(created)}`);
  const review = { images: [], pane: REVIEW_PANE, socket: state.socket, summary: QUESTION, question: QUESTION, options: OPTIONS };
  await bd(["update", created.id, "--metadata", JSON.stringify({ review })]);
  return created.id;
}

async function ingestScratch() {
  const out = await must("pnpm", ["ingest:beads", SCRATCH, "--project", PROJECT], { cwd: REPO_ROOT });
  return out.trim().split("\n").filter((l) => /nodes|issues|created|updated/i.test(l)).slice(-1)[0] ?? "loaded";
}

async function startWeb(label, pathEnv, port) {
  const web = new Service(label, process.execPath, ["--import", "tsx", "server/index.ts", "--port", String(port), "--allow-host", ALLOWED_HOST], { cwd: WEB_DIR, env: childEnv(pathEnv) });
  await web.waitFor(/\[breakdown-web\] ready on /, 60_000, "ready line");
  return web;
}

async function waitForAction(base, id) {
  const deadline = Date.now() + ACTION_DEADLINE_MS;
  for (;;) {
    const action = await trpcQuery(base, "relayAction", { id });
    if (action.state === "done" || action.state === "failed") return action;
    if (Date.now() > deadline) throw new Error(`action ${id} still ${action.state} after ${ACTION_DEADLINE_MS / 1000} s`);
    await sleep(250);
  }
}

function seenB() {
  const b = OPTIONS[1];
  return { question: QUESTION, label: b.label, what: b.what, risk: b.risk };
}

async function decideAndCheckReviews(base, mode, ids, check) {
  const acceptMessage = `e2e-relay ${RUN} ${mode}: ship it`;
  await step(`${mode}: accept ${ids.accept} with option b`, async () => {
    const answered = await trpcMutation(base, "reviewDecision", { project: PROJECT, item: ids.accept, decision: "accept", message: acceptMessage, option: "b", seen: seenB() });
    const detail = await check.accept(answered);
    const shown = await bdJson(["show", ids.accept]);
    expect(shown.status === "closed", `bead ${ids.accept} is ${shown.status}, not closed`);
    const comments = JSON.parse(await bd(["comments", ids.accept, "--json"]));
    const want = `Accepted: b \u2014 ${acceptMessage}`;
    expect(comments.some((c) => c.text === want), `no comment ${JSON.stringify(want)} on ${ids.accept}: ${short(comments.map((c) => c.text))}`);
    const prompt = stubLog().find((e) => e.argv[2] === REVIEW_PANE && e.argv[3] === `Review ${ids.accept} accepted: b \u2014 ${acceptMessage}`);
    expect(prompt, `the stub herdr log has no prompt to ${REVIEW_PANE} for ${ids.accept}: ${short(stubLog())}`);
    expect(prompt.argv[0] === "agent" && prompt.argv[1] === "prompt" && prompt.socket === state.socket, `the prompt ran as ${short(prompt)}`);
    expect(prompt.ppid === check.runner(), `the prompt came from pid ${prompt.ppid}, not the ${mode === "queue" ? "relay" : "web server"} (${check.runner()})`);
    return { detail: `${detail}; bead closed with the comment; herdr agent prompt ${REVIEW_PANE} on the e2e socket, from the ${mode === "queue" ? "relay" : "server"}` };
  });

  const changesMessage = `e2e-relay ${RUN} ${mode}: widen the gutters`;
  await step(`${mode}: request changes on ${ids.changes}`, async () => {
    const answered = await trpcMutation(base, "reviewDecision", { project: PROJECT, item: ids.changes, decision: "changes", message: changesMessage });
    const detail = await check.changes(answered);
    const shown = await bdJson(["show", ids.changes]);
    expect(shown.status !== "closed" && (shown.labels ?? []).includes("review:changes"), `bead ${ids.changes} reads ${short({ status: shown.status, labels: shown.labels })}`);
    const comments = JSON.parse(await bd(["comments", ids.changes, "--json"]));
    expect(comments.some((c) => c.text === `Changes requested: ${changesMessage}`), `no changes comment on ${ids.changes}`);
    return { detail: `${detail}; label review:changes added` };
  });
}

async function fileInbox(base, suffix) {
  const filed = await trpcMutation(base, "inboxRequest", {
    key: `session:e2e-relay-${RUN}-${suffix}`,
    title: `e2e-relay ${RUN}: may the agent proceed (${suffix})?`,
    content: "Filed by bin/relay-e2e.mjs; completed when the run ends.",
    metadata: { source: "session", pane: INBOX_PANE, socket: state.socket },
  });
  expect(typeof filed?.id === "string", `inboxRequest returned ${short(filed)}`);
  state.inbox.push(filed.id);
  return filed.id;
}

function inboxPrompted(after) {
  return stubLog().slice(after).find((e) => e.argv[0] === "agent" && e.argv[1] === "prompt" && e.argv[2] === INBOX_PANE && e.socket === state.socket);
}

async function run_() {
  const bdPath = findOnPath("bd", process.env.PATH);
  await step("preflight: bd is installed, and no relay action is queued or claimed", async () => {
    expect(bdPath !== null, "bd is not on PATH");
    const { Client } = requireFromDb("pg");
    state.pg = new Client({ connectionString: databaseUrl() });
    await state.pg.connect();
    const { rows } = await state.pg.query("SELECT count(*) FILTER (WHERE state = 'queued')::int AS queued, count(*) FILTER (WHERE state = 'claimed')::int AS claimed FROM relay_actions");
    expect(rows[0].queued === 0 && rows[0].claimed === 0, `${rows[0].queued} relay action(s) queued and ${rows[0].claimed} claimed: the relay would take them, so the run is refused`);
    return { detail: `bd ${bdPath}; relay_actions: 0 queued, 0 claimed` };
  });

  const stubDir = await step("stub herdr and a real unix socket in a temp directory", async () => {
    state.tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "relay-e2e-")));
    const dir = path.join(state.tmp, "bin");
    mkdirSync(dir);
    const stub = path.join(dir, "herdr");
    const log = path.join(state.tmp, "herdr.log");
    writeFileSync(
      stub,
      `#!${process.execPath}\n// relay-e2e stub herdr: records the call, runs nothing.\nrequire("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), socket: process.env.HERDR_SOCKET_PATH ?? null, ppid: process.ppid }) + "\\n");\n`,
      { mode: 0o755 },
    );
    state.socket = path.join(state.tmp, "herdr.sock");
    state.socketServer = net.createServer((c) => c.destroy());
    await new Promise((resolve, reject) => {
      state.socketServer.on("error", reject);
      state.socketServer.listen(state.socket, resolve);
    });
    expect(statSync(state.socket).isSocket(), `${state.socket} is not a socket`);
    return { value: dir, detail: `${stub}; socket ${state.socket}` };
  });
  const queuePath = SYSTEM_PATH;
  const relayPath = `${stubDir}:${path.dirname(bdPath)}:${SYSTEM_PATH}`;
  await step("PATHs: the queue-mode server finds neither binary; the relay finds bd and the stub herdr", async () => {
    expect(findOnPath("bd", queuePath) === null && findOnPath("herdr", queuePath) === null, `${queuePath} holds bd or herdr`);
    expect(findOnPath("herdr", relayPath) === path.join(stubDir, "herdr"), `herdr on ${relayPath} resolves to ${findOnPath("herdr", relayPath)}, not the stub`);
    expect(findOnPath("bd", relayPath) === bdPath, `bd on ${relayPath} resolves to ${findOnPath("bd", relayPath)}`);
    return { detail: `server PATH ${queuePath}; relay PATH ${relayPath}` };
  });

  await step(`scratch beads checkout at ${SCRATCH}`, async () => {
    rmSync(SCRATCH, { recursive: true, force: true });
    mkdirSync(SCRATCH, { recursive: true });
    expect(realpathSync(SCRATCH) === SCRATCH, `${SCRATCH} is not its own realpath (${realpathSync(SCRATCH)})`);
    await must("bd", ["init", "--non-interactive", "-q", "--prefix", "e2e", "--skip-hooks", "--skip-agents"], { cwd: SCRATCH });
    expect(existsSync(path.join(SCRATCH, ".beads")), "bd init made no .beads/");
    return { detail: "bd init --prefix e2e" };
  });

  await step("queue fixtures: two review beads, registered as e2e-relay", async () => {
    state.reviews.queueAccept = await createReview("accept me (queued)");
    state.reviews.queueChanges = await createReview("send me back (queued)");
    state.reviews.edit = (await bdJson(["create", "--title", `e2e-relay ${RUN}: edit me`, "--type", "task", "-d", "A fixture bead whose edit must reach the board.", "--acceptance", "Its priority change shows on the board."])).id;
    const summary = await ingestScratch();
    return { detail: `${state.reviews.queueAccept}, ${state.reviews.queueChanges}, plain ${state.reviews.edit}; ${summary}` };
  });

  const port = await freePort();
  state.target.port = port;
  const base = `http://127.0.0.1:${port}`;
  state.web = await step("queue mode: web server with PATH=/usr/bin:/bin", async () => {
    const web = await startWeb("web", queuePath, port);
    const status = await trpcQuery(base, "relayStatus");
    expect(JSON.stringify(status.missingBinaries) === '["bd","herdr"]', `missingBinaries is ${short(status.missingBinaries)}`);
    expect(status.queued === 0 && status.claimed === 0, `relayStatus counts ${status.queued} queued, ${status.claimed} claimed`);
    return { value: web, detail: `${base}, missing bd and herdr; relay ${status.status}` };
  });

  state.token = await step(`mint the relay token ${RELAY_CLIENT} into a 0600 file`, async () => {
    const token = (await must("pnpm", ["-s", "client-token", "create", RELAY_CLIENT, "--scope", "relay"], { cwd: REPO_ROOT })).trim();
    expect(/^bdt_\S+$/.test(token), "client-token create printed no token");
    state.tokenFile = path.join(state.tmp, "relay-token");
    writeFileSync(state.tokenFile, `${token}\n`, { mode: 0o600 });
    chmodSync(state.tokenFile, 0o600);
    return { value: token, detail: state.tokenFile };
  });

  state.proxy = await startProxy(state.target);
  const proxyUrl = `http://127.0.0.1:${state.proxy.address().port}`;
  await step("the proxy admits the token path: GET /relay/v1/projects", async () => {
    const res = await fetch(`${proxyUrl}/relay/v1/projects`, { headers: { Authorization: `Bearer ${state.token}` } });
    const body = await res.json();
    expect(res.status === 200, `answered ${res.status}: ${short(body)}`);
    expect(body.push === true && body.projects.some((p) => p.key === PROJECT && p.path === SCRATCH), `answered ${short(body)}`);
    return { detail: `push: true, ${body.projects.length} project(s) registered` };
  });

  state.relay = await step("start the relay (bin/relay.mjs --project e2e-relay) against the proxy", async () => {
    const relay = new Service("relay", process.execPath, ["--import", "tsx", "../../bin/relay.mjs", "--url", proxyUrl, "--token-file", state.tokenFile, "--name", RELAY_CLIENT, "--project", PROJECT], { cwd: WEB_DIR, env: childEnv(relayPath) });
    await relay.waitFor(/^\[relay\] checked in to /, 60_000, "check-in");
    await relay.waitFor(/^\[relay\] project e2e-relay is the checkout at /, 30_000, "registry line");
    await relay.waitFor(/has no bd: watching 1 checkout\(s\)/, 30_000, "push watcher start");
    const status = await trpcQuery(base, "relayStatus");
    expect(status.status === "online" && status.relay === RELAY_CLIENT, `relayStatus reads ${short(status)}`);
    return { value: relay, detail: `relayStatus online as ${status.relay} (${status.version}); herdr ${findOnPath("herdr", relayPath)}` };
  });

  const relayRunner = () => state.relay.pid;
  await decideAndCheckReviews(base, "queue", { accept: state.reviews.queueAccept, changes: state.reviews.queueChanges }, {
    runner: relayRunner,
    accept: async (answered) => {
      expect(answered.queued === true && Number.isInteger(answered.actionId), `reviewDecision answered ${short(answered)}`);
      state.actions.push(answered.actionId);
      const action = await waitForAction(base, answered.actionId);
      expect(action.state === "done", `action ${answered.actionId} is ${action.state}: ${action.error}`);
      expect(action.result?.ok === true && action.result?.notified?.ok === true && action.result.notified.pane === REVIEW_PANE, `action result ${short(action.result)}`);
      return `queued as action ${answered.actionId} → done, written ${action.result.written.join(", ")}`;
    },
    changes: async (answered) => {
      expect(answered.queued === true, `reviewDecision answered ${short(answered)}`);
      state.actions.push(answered.actionId);
      const action = await waitForAction(base, answered.actionId);
      expect(action.state === "done" && action.result?.ok === true, `action ${answered.actionId} is ${action.state}: ${action.error ?? short(action.result)}`);
      return `queued as action ${answered.actionId} → done`;
    },
  });

  await step("queue: an inbox accept queues a herdr prompt the relay delivers", async () => {
    const id = await fileInbox(base, "queued");
    const before = stubLog().length;
    const decided = await trpcMutation(base, "inboxDecision", { id, decision: "accept", message: `e2e-relay ${RUN}: go ahead` });
    expect(decided.notified?.ok === true && Number.isInteger(decided.notified.relay), `notified ${short(decided.notified)}`);
    state.actions.push(decided.notified.relay);
    const action = await waitForAction(base, decided.notified.relay);
    expect(action.state === "done" && action.result?.pane === INBOX_PANE, `action ${decided.notified.relay} is ${action.state}: ${action.error ?? short(action.result)}`);
    const prompt = inboxPrompted(before);
    expect(prompt && prompt.ppid === state.relay.pid, `no stub herdr prompt to ${INBOX_PANE} from the relay: ${short(stubLog().slice(before))}`);
    return { detail: `inbox item ${id}; notified.relay ${decided.notified.relay} → done; herdr agent prompt ${INBOX_PANE} from the relay` };
  });

  await step(`queue: a bead edit in the scratch checkout reaches the board (boardEvents) within ${BOARD_EVENT_DEADLINE_MS / 1000} s`, async () => {
    // Let the pushes the decisions caused land first, so the event counted is the edit's.
    await sleep(3000);
    const board = subscribeBoard(base);
    try {
      await board.opened;
      await sleep(300);
      const already = board.events.length;
      const edited = Date.now();
      await bd(["update", state.reviews.edit, "--priority", "1"]);
      const deadline = edited + BOARD_EVENT_DEADLINE_MS;
      let event;
      while (!(event = board.events.slice(already).find((e) => e?.kind === "changed" && e.project === PROJECT))) {
        expect(Date.now() < deadline, `no changed event for ${PROJECT} within ${BOARD_EVENT_DEADLINE_MS / 1000} s (saw ${short(board.events.slice(already))})`);
        await sleep(100);
      }
      return { detail: `changed event ${Date.now() - edited} ms after bd update --priority 1 (${event.changedNodeIds.length} node(s))` };
    } finally {
      board.close();
    }
  });

  await step("stop the relay and the queue-mode server", async () => {
    const relayCode = await state.relay.stop();
    expect(relayCode === 0 && state.relay.has(/^\[relay\] stopped$/), `the relay exited ${relayCode}:\n${state.relay.tail()}`);
    const webCode = await state.web.stop();
    return { detail: `relay exited 0 after "[relay] stopped"; server exited ${webCode}` };
  });

  await step("direct fixtures: two more review beads, re-registered", async () => {
    state.reviews.directAccept = await createReview("accept me (direct)");
    state.reviews.directChanges = await createReview("send me back (direct)");
    const summary = await ingestScratch();
    return { detail: `${state.reviews.directAccept}, ${state.reviews.directChanges}; ${summary}` };
  });

  state.web = await step("direct mode: web server with bd and the stub herdr on PATH", async () => {
    const web = await startWeb("web2", relayPath, port);
    const status = await trpcQuery(base, "relayStatus");
    expect(status.missingBinaries.length === 0, `missingBinaries is ${short(status.missingBinaries)}`);
    return { value: web, detail: `${base}, PATH ${relayPath}` };
  });

  const serverRunner = () => state.web.pid;
  await decideAndCheckReviews(base, "direct", { accept: state.reviews.directAccept, changes: state.reviews.directChanges }, {
    runner: serverRunner,
    accept: async (answered) => {
      expect(answered.queued === undefined && answered.ok === true && answered.notified?.ok === true && answered.notified.pane === REVIEW_PANE, `reviewDecision answered ${short(answered)}`);
      return `ran directly: written ${answered.written.join(", ")}`;
    },
    changes: async (answered) => {
      expect(answered.queued === undefined && answered.ok === true, `reviewDecision answered ${short(answered)}`);
      return "ran directly";
    },
  });

  await step("direct: an inbox accept prompts the pane from the server", async () => {
    const id = await fileInbox(base, "direct");
    const before = stubLog().length;
    const decided = await trpcMutation(base, "inboxDecision", { id, decision: "accept", message: `e2e-relay ${RUN}: go ahead, directly` });
    expect(decided.notified?.ok === true && decided.notified.pane === INBOX_PANE, `notified ${short(decided.notified)}`);
    const prompt = inboxPrompted(before);
    expect(prompt && prompt.ppid === state.web.pid, `no stub herdr prompt to ${INBOX_PANE} from the server: ${short(stubLog().slice(before))}`);
    return { detail: `inbox item ${id}; notified ${JSON.stringify(decided.notified)}` };
  });

  await step("direct: no relay action was queued for any direct decision", async () => {
    const { rows: nodes } = await state.pg.query("SELECT id FROM nodes WHERE source_system = 'beads' AND external_id = ANY($1)", [[state.reviews.directAccept, state.reviews.directChanges]]);
    const origins = [...nodes.map((n) => n.id), state.inbox[1]];
    expect(origins.length === 3, `found ${nodes.length} review node(s) for the direct fixtures`);
    const { rows } = await state.pg.query("SELECT id, kind FROM relay_actions WHERE origin_node_id = ANY($1::uuid[])", [origins]);
    expect(rows.length === 0, `relay actions exist for direct decisions: ${short(rows)}`);
    const { rows: queued } = await state.pg.query("SELECT count(*)::int AS n FROM relay_actions WHERE id = ANY($1::bigint[]) AND state <> 'done'", [state.actions]);
    expect(queued[0].n === 0, `${queued[0].n} of this run's queued actions are not done`);
    return { detail: `0 rows for ${origins.length} origin nodes; this run's ${state.actions.length} queued actions all done` };
  });
}

async function cleanup() {
  const notes = [];
  if (state.relay !== null && state.relay.exitCode === undefined) notes.push(`stopped relay: ${await state.relay.stop()}`);
  // Accepted items wait for an agent to carry them out; complete them so none does.
  if (state.inbox.length > 0) {
    let web = state.web !== null && state.web.exitCode === undefined ? state.web : null;
    let port = state.target.port;
    if (web === null) {
      port = await freePort();
      web = await startWeb("cleanup-web", SYSTEM_PATH, port).catch((err) => {
        notes.push(`could not start a server to complete the inbox items: ${err.message}`);
        return null;
      });
      if (web !== null) state.web = web;
    }
    if (web !== null) {
      for (const id of state.inbox) {
        await trpcMutation(`http://127.0.0.1:${port}`, "inboxComplete", { id, note: `e2e-relay ${RUN}: fixture, nothing to do` }).then(
          () => notes.push(`completed inbox item ${id}`),
          (err) => notes.push(`could not complete inbox item ${id}: ${err.message}`),
        );
      }
    }
  }
  if (state.web !== null && state.web.exitCode === undefined) notes.push(`stopped ${state.web.label}: ${await state.web.stop()}`);
  if (state.proxy !== null) await new Promise((resolve) => state.proxy.close(resolve));
  if (state.socketServer !== null) await new Promise((resolve) => state.socketServer.close(resolve));
  if (state.token !== null && !state.revoked) {
    await must("pnpm", ["-s", "client-token", "revoke", RELAY_CLIENT], { cwd: REPO_ROOT }).then(
      () => {
        state.revoked = true;
        notes.push(`revoked ${RELAY_CLIENT}`);
      },
      (err) => notes.push(`could not revoke ${RELAY_CLIENT}: ${err.message}`),
    );
  }
  if (state.pg !== null) await state.pg.end().catch(() => {});
  if (state.tmp !== null) rmSync(state.tmp, { recursive: true, force: true });
  return notes;
}

let interrupted = false;
process.on("SIGINT", () => {
  if (interrupted) process.exit(130);
  interrupted = true;
  console.log("      interrupted: cleaning up (again to exit now)");
});

try {
  await run_();
} catch (err) {
  if (!(err instanceof StepFailed)) {
    failures += 1;
    console.log(`FAIL  unexpected error — ${err instanceof Error ? err.stack : String(err)}`);
  }
  for (const service of [state.relay, state.web]) if (service !== null) console.log(service.tail());
} finally {
  const notes = await cleanup();
  for (const note of notes) console.log(`      cleanup: ${note}`);
  const reviews = Object.entries(state.reviews).map(([what, id]) => `${what} ${id}`);
  console.log(`      left in place: scratch checkout ${SCRATCH} (project ${PROJECT}); beads ${reviews.join(", ") || "none"}; inbox items ${state.inbox.join(", ") || "none"}; relay actions ${state.actions.join(", ") || "none"}; check-in row ${RELAY_CLIENT}`);
  console.log(failures === 0 ? `relay e2e: all ${steps.length} steps passed` : `relay e2e: ${failures} failed of ${steps.length} run`);
  process.exitCode = failures === 0 ? 0 : 1;
}
