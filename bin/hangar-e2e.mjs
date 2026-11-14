#!/usr/bin/env node
// `pnpm hangar:e2e --web http://127.0.0.1:<port> --mcp http://127.0.0.1:<port>/mcp`:
// the hangar loop end to end against running servers (hangar-queue tasks.md
// 2.9). It plays three parts: a throwaway hangar (its own `hangar` token,
// minted and revoked here), the worker that hangar starts (the session
// token the claim returns), and the local person (tokenless loopback).
//
// Admission trusts a loopback request without reading its token, so every
// tokened call here carries `X-Forwarded-For: 192.0.2.10` (a documentation
// address), which makes it a remote request that must present a token, as
// hangar's are in production. The person's calls send no token and no such
// header. Both servers must therefore be on loopback.
//
// It refuses to start while any session is queued: its claim takes the
// oldest queued headless request, which would be a real one. Should a claim
// return a session it did not request anyway, it requeues that one at once.
//
// What it leaves behind, all prefixed `e2e-hangar`: the fixture work item
// (closed at the end), the session's note, the inbox item (completed), the
// stopped session, and the hangar's check-in row. Nothing here deletes;
// the ids are printed. Not part of `pnpm check`: it needs live servers.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REMOTE = { "X-Forwarded-For": "192.0.2.10" };
const CLIENT_INFO = { name: "hangar-e2e", version: "1" };
const PROTOCOL_VERSION = "2025-06-18";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
/** How soon a long-polling claim must answer once the request is queued (it polls once a second). */
const CLAIM_LATENCY_MS = 5000;

function usage(message) {
  process.stderr.write(`${message}\nusage: pnpm hangar:e2e --web http://127.0.0.1:<port> --mcp http://127.0.0.1:<port>/mcp\n`);
  process.exit(2);
}

function loopbackUrl(flag, value) {
  if (value === undefined) usage(`--${flag} is required`);
  let url;
  try {
    url = new URL(value);
  } catch {
    usage(`--${flag} is not a URL: ${value}`);
  }
  if (url.protocol !== "http:" || !LOOPBACK.has(url.hostname)) usage(`--${flag} must be an http URL on loopback (the person's calls are tokenless loopback): ${value}`);
  return url.href.replace(/\/$/, "");
}

const { values } = parseArgs({ options: { web: { type: "string" }, mcp: { type: "string" } } });
const WEB = loopbackUrl("web", values.web);
const MCP = loopbackUrl("mcp", values.mcp);
const RUN = randomBytes(4).toString("hex");
const HANGAR = `e2e-hangar-${RUN}`;

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

// --- HTTP -----------------------------------------------------------------------

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

async function trpcQuery(procedure, token) {
  const sent = await send(WEB, "GET", `/trpc/${procedure}`, { token });
  expect(sent.status === 200, `${procedure} answered ${sent.status}: ${short(sent.text)}`);
  return sent.json.result.data;
}

async function trpcMutation(procedure, input, token) {
  const sent = await send(WEB, "POST", `/trpc/${procedure}`, { token, body: input });
  expect(sent.status === 200, `${procedure} answered ${sent.status}: ${short(sent.text)}`);
  return sent.json.result.data;
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

  /** Initializes; returns the HTTP status so a caller can expect a refusal. */
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

  async close() {
    if (this.sessionId === null) return;
    await send(MCP, "DELETE", "", { token: this.token, headers: this.headers() }).catch(() => {});
    this.sessionId = null;
  }
}

// --- The host CLI ---------------------------------------------------------------------

function clientToken(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["-s", "client-token", ...args], { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(stdout.trim()) : reject(new Error(`client-token ${args[0]} exited ${code}: ${stderr.trim()}`))));
  });
}

// --- The run ---------------------------------------------------------------------------

const state = { hangarToken: null, hangarRevoked: false, sessionId: null, sessionToken: null, sessionEnded: false, strayClaims: [], workItemId: null, noteId: null, inboxItemId: null };
const person = new McpSession(null);
let worker = null;

async function run() {
  await step("preflight: both servers answer and no session is queued", async () => {
    const status = await trpcQuery("hangarStatus");
    expect(status.queued === 0, `${status.queued} session(s) are queued; a claim here would take a real request, so the run is refused`);
    expect((await person.open()) === 200, "tokenless loopback MCP initialize was refused");
    return { detail: `hangar ${status.status}, ${status.claimed} claimed, ${status.running} running` };
  });

  state.hangarToken = await step(`mint the hangar token for ${HANGAR}`, async () => {
    const token = await clientToken(["create", HANGAR, "--scope", "hangar"]);
    expect(/^bdt_\S+$/.test(token), "client-token create printed no token");
    return { value: token, detail: "scope hangar" };
  });

  await step("hangar checks in", async () => {
    const sent = await hangarApi("POST", "/check-in", { token: state.hangarToken, body: { version: `e2e-${RUN}`, capacity: { slots: { headless: 1 } } } });
    expect(sent.status === 200, `check-in answered ${sent.status}: ${short(sent.text)}`);
    expect(Number.isInteger(sent.json.interval_s), "check-in returned no interval_s");
    const status = await trpcQuery("hangarStatus");
    expect(status.status === "online", `hangarStatus reads ${status.status} right after a check-in`);
    return { detail: `interval_s ${sent.json.interval_s}; hangarStatus online (last: ${status.hangar} ${status.version})` };
  });

  const claimStarted = Date.now();
  const claim = hangarApi("POST", "/claim", { token: state.hangarToken, body: { flavors: ["headless"], wait_s: 25 } });
  claim.catch(() => {});
  // Let the long-poll find nothing first, so the request below arrives mid-poll.
  await sleep(1500);

  state.workItemId = await step("person writes a fixture work item over tokenless MCP", async () => {
    const written = await person.call("brain_write", { items: { nodeType: "work_item", externalId: `e2e-hangar-${RUN}`, title: `e2e-hangar ${RUN}: fixture work item`, content: "Written by bin/hangar-e2e.mjs; closed when the run ends.", metadata: { status: "open", priority: 4 } } });
    const id = written.items?.[0]?.id;
    expect(id, `brain_write returned no id: ${short(written)}`);
    return { value: id, detail: id };
  });

  let requestedAt = 0;
  state.sessionId = await step("brain_hangar_request queues a headless session", async () => {
    const result = await person.call("brain_hangar_request", { repo: "cazzer/bd", workItemId: state.workItemId, flavor: "headless" });
    requestedAt = Date.now();
    expect(result.state === "queued", `state is ${result.state}`);
    expect(result.hangar?.status === "online", `hangar status is ${short(result.hangar)}`);
    return { value: result.sessionId, detail: `${result.sessionId}; "${result.hangar.text}"` };
  });

  state.sessionToken = await step("the long-polling claim answers with that session and a session token", async () => {
    const sent = await claim;
    const answeredIn = Date.now() - requestedAt;
    expect(sent.status === 200, `claim answered ${sent.status}: ${short(sent.text)}`);
    const claimed = sent.json.session;
    expect(claimed !== null, `the claim waited ${Date.now() - claimStarted} ms and found nothing`);
    if (claimed.id !== state.sessionId) {
      state.strayClaims.push(claimed.id);
      throw new Error(`claimed ${claimed.id}, not the session this run requested (${state.sessionId}); it is requeued at cleanup`);
    }
    expect(claimed.state === "claimed" && claimed.claimed_by === HANGAR, `session reads ${short(claimed)}`);
    expect(/^bdt_\S+$/.test(sent.json.token ?? ""), "the claim returned no token");
    expect(answeredIn < CLAIM_LATENCY_MS, `the claim answered ${answeredIn} ms after the request, over ${CLAIM_LATENCY_MS} ms`);
    return { value: sent.json.token, detail: `${answeredIn} ms after the request; work item ${claimed.work_item?.title}` };
  });

  worker = new McpSession(state.sessionToken);
  state.noteId = await step("the session token writes a note over MCP, attributed to the session", async () => {
    expect((await worker.open()) === 200, "MCP initialize with the session token was refused");
    const written = await worker.call("brain_write", { items: { nodeType: "note", externalId: `e2e-hangar-${RUN}-note`, title: `e2e-hangar ${RUN}: note from session`, content: "Written with a hangar session token by bin/hangar-e2e.mjs." } });
    const id = written.items?.[0]?.id;
    expect(id, `brain_write returned no id: ${short(written)}`);
    const history = await person.call("brain_history", { id });
    const actor = history.revisions?.[0]?.ingestRun?.actor;
    const want = `session-${state.sessionId} via ${CLIENT_INFO.name} ${CLIENT_INFO.version}`;
    expect(actor === want, `brain_history shows actor ${JSON.stringify(actor)}, not ${JSON.stringify(want)}`);
    return { value: id, detail: `${id}; actor "${actor}"` };
  });

  state.inboxItemId = await step("the worker files an inbox request with the session token, bound to the session", async () => {
    const filed = await trpcMutation("inboxRequest", { key: `session:e2e-hangar-${RUN}`, title: `e2e-hangar ${RUN}: may the worker proceed?`, content: "Filed by bin/hangar-e2e.mjs with a session token.", metadata: { source: "session", session: "00000000-0000-4000-8000-000000000000" } }, state.sessionToken);
    expect(filed.session === state.sessionId, `the item's session is ${JSON.stringify(filed.session)}, not ${state.sessionId}`);
    const stored = await person.call("brain_get", { ids: [filed.id] });
    const metadata = stored.nodes?.[0]?.metadata ?? {};
    expect(metadata.session === state.sessionId, `the stored item carries session ${JSON.stringify(metadata.session)}`);
    return { value: filed.id, detail: `${filed.id}; session ${filed.session} (the body's session was ignored)` };
  });

  await step("the person accepts it over tokenless loopback; it is queued to the session, not herdr", async () => {
    const decided = await trpcMutation("inboxDecision", { id: state.inboxItemId, decision: "accept", message: `e2e-hangar ${RUN}: go ahead` });
    expect(decided.notified?.ok === true && decided.notified.session === state.sessionId, `notified ${short(decided.notified)}`);
    return { detail: `notified ${JSON.stringify(decided.notified)}` };
  });

  await step("the worker's message long-poll returns the decision with its message", async () => {
    const sent = await hangarApi("GET", "/messages?after=0&wait_s=10", { token: state.sessionToken });
    expect(sent.status === 200, `messages answered ${sent.status}: ${short(sent.text)}`);
    const decision = sent.json.messages.find((m) => m.kind === "inbox_decision" && m.body.item_id === state.inboxItemId);
    expect(decision, `no inbox_decision for the item in ${short(sent.json)}`);
    expect(decision.body.decision === "accept" && decision.body.message === `e2e-hangar ${RUN}: go ahead`, `the message reads ${short(decision.body)}`);
    return { detail: `message ${decision.id}, cursor ${sent.json.cursor}` };
  });

  await step("the worker completes the item with the session token", async () => {
    await trpcMutation("inboxComplete", { id: state.inboxItemId, note: `e2e-hangar ${RUN}: done` }, state.sessionToken);
    return { detail: "status done" };
  });

  await step("hangar reports the session running, then stopped", async () => {
    const running = await hangarApi("PATCH", `/sessions/${state.sessionId}`, { token: state.hangarToken, body: { state: "running", container: `e2e-${RUN}`, host: "e2e-host" } });
    expect(running.status === 200 && running.json.session.state === "running", `running answered ${running.status}: ${short(running.text)}`);
    const stopped = await hangarApi("PATCH", `/sessions/${state.sessionId}`, { token: state.hangarToken, body: { state: "stopped" } });
    expect(stopped.status === 200 && stopped.json.session.state === "stopped", `stopped answered ${stopped.status}: ${short(stopped.text)}`);
    state.sessionEnded = true;
    return { detail: `container ${running.json.session.container}` };
  });

  await step("the session token is refused once the session stopped (messages and MCP)", async () => {
    const messages = await hangarApi("GET", "/messages", { token: state.sessionToken });
    expect(messages.status === 401, `messages answered ${messages.status}`);
    const reopened = await new McpSession(state.sessionToken).open();
    expect(reopened === 401, `a new MCP session answered ${reopened}`);
    return { detail: "401, 401" };
  });

  await step("revoking the hangar token stops the hangar", async () => {
    await clientToken(["revoke", HANGAR]);
    state.hangarRevoked = true;
    const sent = await hangarApi("POST", "/check-in", { token: state.hangarToken, body: { version: `e2e-${RUN}` } });
    expect(sent.status === 401, `check-in with the revoked token answered ${sent.status}`);
    return { detail: "check-in 401" };
  });
}

async function cleanup() {
  const notes = [];
  for (const id of state.strayClaims) {
    const sent = await hangarApi("POST", `/sessions/${id}/requeue`, { token: state.hangarToken, body: { reason: "claimed by bin/hangar-e2e.mjs by mistake" } }).catch((err) => ({ status: 0, text: String(err) }));
    notes.push(`requeued stray claim ${id}: ${sent.status}`);
  }
  // Our request still queued (its claim failed): take it ourselves and end it,
  // so no real hangar ever runs a fixture. Anything else a claim returns is
  // requeued untouched.
  if (state.sessionId !== null && state.sessionToken === null && state.hangarToken !== null && !state.hangarRevoked) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const sent = await hangarApi("POST", "/claim", { token: state.hangarToken, body: { flavors: ["headless"], wait_s: 0 } }).catch(() => null);
      const claimed = sent?.json?.session;
      if (!claimed) break;
      if (claimed.id === state.sessionId) {
        const ended = await hangarApi("PATCH", `/sessions/${claimed.id}`, { token: state.hangarToken, body: { state: "failed" } }).catch((err) => ({ status: 0, text: String(err) }));
        notes.push(`claimed this run's queued session ${claimed.id} and marked it failed: ${ended.status}`);
        break;
      }
      const requeued = await hangarApi("POST", `/sessions/${claimed.id}/requeue`, { token: state.hangarToken, body: { reason: "claimed by bin/hangar-e2e.mjs by mistake" } }).catch((err) => ({ status: 0, text: String(err) }));
      notes.push(`requeued stray claim ${claimed.id}: ${requeued.status}`);
    }
  }
  if (state.sessionToken !== null && !state.sessionEnded && !state.hangarRevoked) {
    const sent = await hangarApi("PATCH", `/sessions/${state.sessionId}`, { token: state.hangarToken, body: { state: "failed" } }).catch((err) => ({ status: 0, text: String(err) }));
    notes.push(`marked session ${state.sessionId} failed: ${sent.status}`);
  }
  if (state.hangarToken !== null && !state.hangarRevoked) {
    await clientToken(["revoke", HANGAR]).then(
      () => notes.push(`revoked ${HANGAR}`),
      (err) => notes.push(`could not revoke ${HANGAR}: ${err.message}`),
    );
  }
  if (state.workItemId !== null) {
    await person
      .call("brain_update_work_item", { id: state.workItemId, status: "closed", closedReason: "e2e-hangar fixture" })
      .then(
        () => notes.push(`closed fixture work item ${state.workItemId}`),
        (err) => notes.push(`could not close fixture work item ${state.workItemId}: ${err.message}`),
      );
  }
  await worker?.close();
  await person.close();
  return notes;
}

try {
  await run();
} catch (err) {
  if (!(err instanceof StepFailed)) {
    failures += 1;
    console.log(`FAIL  unexpected error — ${err instanceof Error ? err.stack : String(err)}`);
  }
} finally {
  const notes = await cleanup();
  for (const note of notes) console.log(`      cleanup: ${note}`);
  const left = [
    ["work item", state.workItemId],
    ["session", state.sessionId],
    ["note", state.noteId],
    ["inbox item", state.inboxItemId],
  ].filter(([, id]) => id !== null);
  console.log(`      left in place (prefixed e2e-hangar): ${left.map(([what, id]) => `${what} ${id}`).join(", ") || "nothing"}; check-in row ${HANGAR}`);
  console.log(failures === 0 ? `hangar e2e: all ${steps.length} steps passed` : `hangar e2e: ${failures} failed of ${steps.length} run`);
  process.exitCode = failures === 0 ? 0 : 1;
}
