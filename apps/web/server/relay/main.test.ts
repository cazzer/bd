import { describe, expect, it, vi } from "vitest";
import { sleep as realSleep } from "./client.js";
import { runRelay, RELAY_VERSION, type RelayDeps, type RelayOptions } from "./main.js";

const DIR = "/Users/me/dev/bd";
const UID = 501;
const TOKEN = "bdt_secret_token_value";

interface Action {
  id: number;
  kind: string;
  payload: unknown;
  attempts?: number;
}

/** An in-memory `/relay/v1` server behind a fake fetch. */
function fakeServer({ push = false, projects = [{ key: "bd", path: DIR }] } = {}) {
  const queue: Action[] = [];
  const reports: Array<{ id: string; body: Record<string, unknown> }> = [];
  const pushes: unknown[] = [];
  const requests: Array<{ method: string; path: string; auth: string | undefined; body: Record<string, unknown>; redirect: RequestInit["redirect"] }> = [];
  let checkIns = 0;
  /** Status codes the next result posts answer with, in order. */
  const resultFailures: number[] = [];
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  const fetch = vi.fn(async (url: string, init: RequestInit): Promise<Response> => {
    const path = new URL(url).pathname;
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    requests.push({ method: init.method ?? "GET", path, auth: (init.headers as Record<string, string>)["Authorization"], body, redirect: init.redirect });
    if (path === "/relay/v1/check-in") {
      checkIns += 1;
      return reply(200, { interval_s: 30, now: new Date().toISOString() });
    }
    if (path === "/relay/v1/projects") return reply(200, { projects, push });
    if (path === "/relay/v1/claim") {
      const next = queue.shift();
      if (next !== undefined) return reply(200, { action: { attempts: 1, created_at: new Date().toISOString(), ...next } });
      await realSleep(30, init.signal ?? undefined);
      if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
      return reply(200, { action: null });
    }
    const result = /^\/relay\/v1\/actions\/(\d+)\/result$/.exec(path);
    if (result) {
      const failure = resultFailures.shift();
      if (failure !== undefined) return reply(failure, { error: { code: failure === 409 ? "not_claimer" : "internal", message: "nope" } });
      reports.push({ id: result[1]!, body });
      return reply(200, { action: { id: Number(result[1]), state: body["state"] }, already_finished: false });
    }
    if (path === "/relay/v1/beads-ingest") {
      pushes.push(body);
      return reply(200, { project: "bd", nodes: { created: 0, updated: 0, unchanged: 2 }, edges: { created: 0, updated: 0 }, edges_deleted: 0, changed: false, changed_node_ids: [] });
    }
    return reply(404, { error: { code: "not_found", message: path } });
  });
  return { fetch, queue, reports, pushes, requests, resultFailures, checkIns: () => checkIns };
}

const SHOWN = JSON.stringify([{ id: "bd-x1", status: "open", labels: ["review"], metadata: { review: {} } }]);

function harness(server: ReturnType<typeof fakeServer>, overrides: Partial<RelayDeps> = {}, options: Partial<RelayOptions> = {}) {
  const out: string[] = [];
  const warn: string[] = [];
  let signalHandler: ((signal: string) => void) | null = null;
  const exit = vi.fn();
  const bd = vi.fn(async (args: readonly string[]) => (args[0] === "show" ? SHOWN : ""));
  const herdr = vi.fn(async () => {});
  const ingestBd = vi.fn(async (args: readonly string[]) => (args[0] === "list" ? JSON.stringify([{ id: "bd-x1", title: "Review", status: "open" }]) : "[]"));
  const deps: RelayDeps = {
    fetch: server.fetch,
    findOnPath: (b) => `/opt/homebrew/bin/${b}`,
    out: (l) => out.push(l),
    warn: (l) => warn.push(l),
    onSignal: (handler) => {
      signalHandler = handler;
      return () => {
        signalHandler = null;
      };
    },
    exit,
    sleep: (ms, signal) => realSleep(Math.min(ms, 10), signal),
    runners: { bd, herdr, ingestBd, inspectSocket: () => ({ isSocket: true, uid: UID }), uid: UID },
    checkDir: () => null,
    random: () => 0,
    ...overrides,
  };
  const run = runRelay({ origin: "https://jetson.ts.net", name: "relay-laptop", projects: [{ key: "bd", path: DIR }], herdrSockets: ["/tmp/herdr.sock"], readToken: () => TOKEN, ...options }, deps);
  return {
    run,
    out,
    warn,
    exit,
    bd,
    herdr,
    ingestBd,
    signal: (name = "SIGTERM") => signalHandler?.(name),
    log: () => [...out, ...warn].join("\n"),
  };
}

async function until(condition: () => boolean, what: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await realSleep(5);
  }
}

const decision = { project_key: "bd", cwd: DIR, issue_id: "bd-x1", decision: "changes", message: "Private words in the message" };

describe("runRelay", () => {
  it("refuses to start without bd on PATH, and only warns without herdr", async () => {
    const server = fakeServer();
    const noBd = harness(server, { findOnPath: () => null });
    expect(await noBd.run).toBe(1);
    expect(noBd.warn.join("\n")).toMatch(/cannot start: bd is not on PATH/);
    expect(server.fetch).not.toHaveBeenCalled();

    const noHerdr = harness(fakeServer(), { findOnPath: (b) => (b === "bd" ? "/opt/homebrew/bin/bd" : null) });
    await until(() => noHerdr.out.some((l) => l.startsWith("[relay] checked in")), "the check-in");
    expect(noHerdr.warn.join("\n")).toMatch(/herdr is not on PATH/);
    noHerdr.signal();
    expect(await noHerdr.run).toBe(0);
  });

  it("checks in, claims, runs, and reports each action, then stops cleanly on SIGTERM", async () => {
    const server = fakeServer();
    server.queue.push({ id: 41, kind: "review_decision", payload: decision });
    server.queue.push({ id: 42, kind: "review_decision", payload: { ...decision, cwd: "/Users/me/dev/elsewhere" } });
    server.queue.push({ id: 43, kind: "bd_delete", payload: { issue: "bd-x1" } });
    const relay = harness(server);
    await until(() => server.reports.length === 3, "three reports");

    expect(server.checkIns()).toBeGreaterThanOrEqual(1);
    expect(server.requests.find((r) => r.path === "/relay/v1/check-in")).toMatchObject({ method: "POST", auth: `Bearer ${TOKEN}` });
    expect(server.reports[0]).toEqual({ id: "41", body: { state: "done", result: { ok: true, written: ["comment", "add-changes-label"], attempted: true, notified: { ok: false, reason: "no pane recorded on the review" } } } });
    expect(server.reports[1]!.body).toMatchObject({ state: "failed", error: expect.stringMatching(/^refused: \/Users\/me\/dev\/elsewhere is not project bd's checkout/) });
    expect(server.reports[2]!.body).toMatchObject({ state: "failed", error: expect.stringMatching(/^refused: invalid relay action: kind/) });
    // Only the first action reached bd: show, comment, label.
    expect(relay.bd.mock.calls.map((c) => c[0][0])).toEqual(["show", "comments", "update"]);

    relay.signal("SIGTERM");
    expect(await relay.run).toBe(0);
    const log = relay.log();
    expect(log).toContain(`[relay] ${RELAY_VERSION} starting as relay-laptop for https://jetson.ts.net`);
    expect(log).toContain("[relay] action 41 review_decision claimed");
    expect(log).toContain("[relay] action 41 review_decision reported done");
    expect(log).toContain("[relay] action 43 bd_delete failed (refused before running)");
    expect(log).toContain("[relay] stopped");
    expect(log).not.toContain(TOKEN);
    expect(log).not.toContain("Private words");
    expect(log.split("\n").every((l) => l.startsWith("[relay]") || l.startsWith("  "))).toBe(true);
  });

  it("retries a report until Breakdown takes it, and gives up one it refuses", async () => {
    const server = fakeServer();
    server.resultFailures.push(500, 503, 500);
    server.queue.push({ id: 7, kind: "herdr_prompt", payload: { pane: "w1:p1", socket: "/tmp/herdr.sock", text: "Inbox: accepted" } });
    const relay = harness(server);
    await until(() => server.reports.length === 1, "the report");
    expect(server.reports[0]).toEqual({ id: "7", body: { state: "done", result: { pane: "w1:p1" } } });
    expect(relay.warn.filter((l) => l.includes("the report failed"))).toHaveLength(3);

    server.resultFailures.push(409);
    server.queue.push({ id: 8, kind: "herdr_prompt", payload: { pane: "w1:p1", socket: "/tmp/herdr.sock", text: "again" } });
    server.queue.push({ id: 9, kind: "herdr_prompt", payload: { pane: "w1:p1", socket: "/tmp/herdr.sock", text: "third" } });
    await until(() => server.reports.length === 2, "the next report");
    expect(server.reports[1]!.id).toBe("9");
    expect(relay.warn.join("\n")).toMatch(/action 8 herdr_prompt: the report was refused \(POST \/relay\/v1\/actions\/8\/result answered 409 not_claimer: nope\); giving it up/);
    relay.signal();
    expect(await relay.run).toBe(0);
  });

  it("on the first signal lets the action in hand finish and report; a second exits 130", async () => {
    const server = fakeServer();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const relay = harness(server, {
      runners: {
        bd: async (args) => {
          if (args[0] === "show") return SHOWN;
          await gate;
          return "";
        },
        herdr: async () => {},
        ingestBd: async () => "[]",
        inspectSocket: () => ({ isSocket: true, uid: UID }),
        uid: UID,
      },
    });
    server.queue.push({ id: 5, kind: "review_decision", payload: decision });
    await until(() => relay.out.some((l) => l.includes("action 5 review_decision claimed")), "the claim");
    relay.signal("SIGTERM");
    await realSleep(30);
    expect(server.reports).toHaveLength(0);
    release();
    expect(await relay.run).toBe(0);
    expect(server.reports.map((r) => [r.id, r.body["state"]])).toEqual([["5", "done"]]);
    relay.signal("SIGINT");
    // The handler is unsubscribed once the run resolved; a signal during the run would have exited.
    expect(relay.exit).not.toHaveBeenCalled();
  });

  it("exits 130 on a second signal while still stopping", async () => {
    const server = fakeServer();
    const gate = new Promise<void>(() => {});
    const relay = harness(server, {
      runners: { bd: async (args) => (args[0] === "show" ? SHOWN : gate.then(() => "")), herdr: async () => {}, ingestBd: async () => "[]", inspectSocket: () => ({ isSocket: true, uid: UID }), uid: UID },
    });
    server.queue.push({ id: 6, kind: "review_decision", payload: decision });
    await until(() => relay.out.some((l) => l.includes("action 6 review_decision claimed")), "the claim");
    relay.signal("SIGTERM");
    relay.signal("SIGTERM");
    expect(relay.exit).toHaveBeenCalledWith(130);
  });

  it("runs the push watcher only when the server says push: true", async () => {
    const quiet = fakeServer({ push: false });
    const noPush = harness(quiet);
    await until(() => noPush.out.some((l) => l.startsWith("[relay] checked in")), "the check-in");
    await realSleep(30);
    expect(quiet.pushes).toHaveLength(0);
    noPush.signal();
    expect(await noPush.run).toBe(0);

    const server = fakeServer({ push: true });
    const relay = harness(server, { watcher: { watchDir: () => ({ close() {} }), fingerprint: () => "fp", stopGraceMs: 10 } });
    await until(() => server.pushes.length === 1, "the first push");
    expect(server.pushes[0]).toEqual({ project_key: "bd", path: DIR, issues: [{ id: "bd-x1", title: "Review", status: "open" }], comments: {} });
    expect(relay.out.join("\n")).toContain("has no bd: watching 1 checkout(s) and pushing their beads");

    // A queued re-ingest goes through the watcher and reports what the push applied.
    server.queue.push({ id: 11, kind: "beads_reingest", payload: { project_key: "bd" } });
    await until(() => server.reports.length === 1, "the re-ingest report");
    expect(server.reports[0]).toEqual({ id: "11", body: { state: "done", result: { project: "bd", changed: false } } });
    expect(server.pushes).toHaveLength(2);
    relay.signal();
    expect(await relay.run).toBe(0);
  });

  it("claims only its kinds and its own projects, and never redirects", async () => {
    const server = fakeServer();
    const relay = harness(server, {}, { kinds: ["review_decision", "beads_reingest"] });
    await until(() => server.requests.some((r) => r.path === "/relay/v1/claim"), "a claim");
    const claim = server.requests.find((r) => r.path === "/relay/v1/claim")!;
    expect(claim.body).toEqual({ wait_s: 30, kinds: ["review_decision", "beads_reingest"], projects: ["bd"] });
    expect(server.requests.every((r) => r.redirect === "error")).toBe(true);
    relay.signal();
    expect(await relay.run).toBe(0);
  });

  it("a relay narrowed to its own project runs nothing for another, even when the server hands it out", async () => {
    const server = fakeServer({ projects: [{ key: "bd", path: DIR }, { key: "other", path: "/Users/me/dev/other" }] });
    server.queue.push({ id: 51, kind: "review_decision", payload: { ...decision, project_key: "other", cwd: "/Users/me/dev/other" } });
    server.queue.push({ id: 52, kind: "beads_reingest", payload: { project_key: "other" } });
    const relay = harness(server);
    await until(() => server.reports.length === 2, "two reports");
    expect(server.reports.map((r) => r.body)).toEqual([
      { state: "failed", error: "refused: project other is not in this relay's registry; nothing ran" },
      { state: "failed", error: "refused: project other is not in this relay's registry; nothing ran" },
    ]);
    expect(relay.bd).not.toHaveBeenCalled();
    expect(relay.ingestBd).not.toHaveBeenCalled();
    relay.signal();
    expect(await relay.run).toBe(0);
  });

  it("never takes the server's path for a project: a mismatch serves nothing and warns", async () => {
    const server = fakeServer({ projects: [{ key: "bd", path: "/Users/attacker/bd" }] });
    server.queue.push({ id: 61, kind: "review_decision", payload: { ...decision, cwd: "/Users/attacker/bd" } });
    server.queue.push({ id: 62, kind: "review_decision", payload: decision });
    const relay = harness(server);
    await until(() => server.reports.length === 2, "two reports");
    expect(server.reports.every((r) => r.body["state"] === "failed")).toBe(true);
    expect(relay.bd).not.toHaveBeenCalled();
    expect(relay.log()).toContain('[relay] warning: the server lists project bd at "/Users/attacker/bd", not this relay\'s /Users/me/dev/bd');
    relay.signal();
    expect(await relay.run).toBe(0);
  });

  it("refuses to start with no --project", async () => {
    const server = fakeServer();
    const relay = harness(server, {}, { projects: [] });
    expect(await relay.run).toBe(1);
    expect(relay.warn.join("\n")).toMatch(/no --project key=path given/);
    expect(server.fetch).not.toHaveBeenCalled();
  });
});
