import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { RELAY_PROVENANCE_LINE, type RelayActionKind } from "@breakdown/core";
import { createReviewWriter } from "../review-writer.js";
import { executeAction, reportSummary, type ClaimedAction, type ExecuteDeps } from "./execute.js";
import { createRelayRunners } from "./runners.js";

const DIR = "/Users/me/dev/bd";
let tmp: string;
let socket: string;
let server: Server;

beforeAll(async () => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "relay-exec-")));
  socket = path.join(tmp, "herdr.sock");
  server = createServer();
  await new Promise<void>((resolve) => server.listen(socket, resolve));
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(tmp, { recursive: true, force: true });
});

const OPTIONS = [
  { id: "a", label: "One column" },
  { id: "b", label: "Two columns", what: "Split the board", risk: "Narrow screens" },
];

function shown(overrides: Record<string, unknown> = {}) {
  return JSON.stringify([{ id: "bd-x1", status: "open", labels: ["review"], metadata: { review: { pane: "w1:p1", socket, question: "Which layout?", options: OPTIONS } }, ...overrides }]);
}

/** A relay wired as main.ts wires it, with spies for the spawning runners. */
function relay({ show = shown(), bdFails = {} as Record<string, string>, registry = new Map([["bd", DIR]]), kinds = undefined as RelayActionKind[] | undefined, maxAgeMs = undefined as number | undefined } = {}) {
  const bd = vi.fn(async (args: readonly string[], _cwd: string) => {
    if (args[0] === "show") return show;
    const failure = bdFails[args[0] as string];
    if (failure !== undefined) throw new Error(failure);
    return "";
  });
  const herdr = vi.fn(async () => {});
  const reingest = vi.fn(async () => ({ changed: true }));
  const reg = { get: (project: string) => (registry.has(project) ? { project, dir: registry.get(project)! } : undefined), refresh: vi.fn(async () => false) };
  const runners = createRelayRunners({ registry: reg, herdrSockets: [socket], bd, herdr, checkDir: () => null });
  const deps: ExecuteDeps = {
    registry: reg,
    writerFor: (project) => createReviewWriter({ runBd: runners.bdFor(project), runHerdr: runners.runHerdr }),
    runHerdr: runners.runHerdr,
    reingest,
    ...(kinds === undefined ? {} : { kinds }),
    ...(maxAgeMs === undefined ? {} : { maxAgeMs }),
  };
  return { deps, bd, herdr, reingest, reg };
}

/** A claimed action, queued just now unless `createdAt` says otherwise. */
function act(kind: unknown, payload: unknown, createdAt: unknown = new Date().toISOString()): ClaimedAction {
  return { id: "1", kind, payload, createdAt };
}

const sent = (text: string) => `${RELAY_PROVENANCE_LINE}\n${text}`;

const accept = { project_key: "bd", cwd: DIR, issue_id: "bd-x1", decision: "accept", message: "Ship it", option: "b", seen: { question: "Which layout?", label: "Two columns", what: "Split the board", risk: "Narrow screens" } };
const changes = { project_key: "bd", cwd: DIR, issue_id: "bd-x1", decision: "changes", message: "Wider gutters" };

describe("executeAction: forged actions run nothing", () => {
  const forged: Array<[string, unknown, unknown]> = [
    ["an unknown kind", "bd_delete", { args: ["delete", "bd-x1"] }],
    ["a review decision with a command smuggled in", "review_decision", { ...accept, command: "bd delete bd-x1" }],
    ["a review decision with a relative cwd", "review_decision", { ...changes, cwd: "dev/bd" }],
    ["a review decision with a non-beads id", "review_decision", { ...changes, issue_id: "--force" }],
    ["a herdr prompt whose text is a flag", "herdr_prompt", { pane: "w1:p1", socket: "/tmp/x.sock", text: "--help" }],
    ["a herdr prompt with a bad pane", "herdr_prompt", { pane: "-p", socket: "/tmp/x.sock", text: "hi" }],
    ["a re-ingest with a bad key", "beads_reingest", { project_key: "../etc" }],
  ];
  for (const [what, kind, payload] of forged) {
    it(`refuses ${what}`, async () => {
      const { deps, bd, herdr, reingest } = relay();
      const report = await executeAction(act(kind, payload), deps);
      expect(report.state).toBe("failed");
      expect(report.state === "failed" && report.error).toMatch(/^refused: invalid relay action: .*; nothing ran$/);
      expect(bd).not.toHaveBeenCalled();
      expect(herdr).not.toHaveBeenCalled();
      expect(reingest).not.toHaveBeenCalled();
      expect(reportSummary(report)).toBe("failed (refused before running)");
    });
  }

  it("refuses a project the registry does not hold, after re-reading it once", async () => {
    const { deps, bd, reg } = relay({ registry: new Map() });
    const report = await executeAction(act("review_decision", changes), deps);
    expect(report).toEqual({ state: "failed", error: "refused: project bd is not in this relay's registry; nothing ran" });
    expect(reg.refresh).toHaveBeenCalledTimes(1);
    expect(bd).not.toHaveBeenCalled();
  });

  it("refuses a cwd other than the project's registered checkout", async () => {
    const { deps, bd } = relay();
    const report = await executeAction(act("review_decision", { ...changes, cwd: "/Users/me/dev/other" }), deps);
    expect(report.state === "failed" && report.error).toMatch(/^refused: \/Users\/me\/dev\/other is not project bd's checkout/);
    expect(bd).not.toHaveBeenCalled();
  });

  it("refuses a herdr socket outside the relay's allowlist, before spawning", async () => {
    const { deps, herdr } = relay();
    const report = await executeAction(act("herdr_prompt", { pane: "w1:p1", socket: path.join(tmp, "missing.sock"), text: "Accepted" }), deps);
    expect(report).toEqual({ state: "failed", error: `the herdr socket ${path.join(tmp, "missing.sock")} is not one this relay may prompt through (--herdr-socket)` });
    expect(herdr).not.toHaveBeenCalled();
  });

  it("refuses a kind this relay does not run (--kinds), before anything", async () => {
    const { deps, bd, herdr } = relay({ kinds: ["beads_reingest"] });
    for (const [kind, payload] of [["review_decision", accept], ["herdr_prompt", { pane: "w1:p1", socket, text: "hi" }]] as const) {
      expect(await executeAction(act(kind, payload), deps)).toEqual({ state: "failed", error: `refused: this relay does not run ${kind} actions (--kinds); nothing ran` });
    }
    expect(bd).not.toHaveBeenCalled();
    expect(herdr).not.toHaveBeenCalled();
  });

  it("refuses a decision or a prompt older than --max-age, or with no readable created_at; never a re-ingest", async () => {
    const { deps, bd, herdr, reingest } = relay({ maxAgeMs: 60 * 60_000 });
    const old = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    expect(await executeAction(act("review_decision", accept, old), deps)).toEqual({ state: "failed", error: `refused: stale: queued ${old}, older than this relay's --max-age (1 h); nothing ran` });
    expect(await executeAction(act("herdr_prompt", { pane: "w1:p1", socket, text: "hi" }, old), deps)).toMatchObject({ state: "failed", error: expect.stringMatching(/^refused: stale: /) });
    for (const createdAt of [null, "yesterday", 12]) {
      expect(await executeAction(act("review_decision", accept, createdAt), deps)).toEqual({ state: "failed", error: "refused: the action carries no readable created_at, so its age is unknown; nothing ran" });
    }
    expect(bd).not.toHaveBeenCalled();
    expect(herdr).not.toHaveBeenCalled();
    expect(await executeAction(act("beads_reingest", { project_key: "bd" }, old), deps)).toEqual({ state: "done", result: { project: "bd", changed: true } });
    expect(reingest).toHaveBeenCalledTimes(1);
  });

  it("defaults --max-age to 24 h", async () => {
    const { deps, bd } = relay();
    const day = new Date(Date.now() - 25 * 60 * 60_000).toISOString();
    expect(await executeAction(act("review_decision", accept, day), deps)).toMatchObject({ state: "failed", error: expect.stringContaining("older than this relay's --max-age (1 d)") });
    expect(bd).not.toHaveBeenCalled();
  });

  it("refuses a re-ingest of a project the registry does not hold", async () => {
    const { deps, reingest, reg } = relay({ registry: new Map() });
    expect(await executeAction(act("beads_reingest", { project_key: "bd" }), deps)).toEqual({
      state: "failed",
      error: "refused: project bd is not in this relay's registry; nothing ran",
    });
    expect(reg.refresh).toHaveBeenCalled();
    expect(reingest).not.toHaveBeenCalled();
  });
});

describe("executeAction: review decisions map every writer outcome", () => {
  it("ok → done with the writer's result; the agent's pane is prompted on the recorded socket", async () => {
    const { deps, bd, herdr } = relay();
    const report = await executeAction(act("review_decision", accept), deps);
    expect(report).toEqual({ state: "done", result: { ok: true, written: ["comment", "remove-changes-label", "close"], attempted: true, notified: { ok: true, pane: "w1:p1" } } });
    expect(bd.mock.calls.map((c) => c[0])).toEqual([
      ["show", "bd-x1", "--json"],
      ["comments", "add", "bd-x1", "Accepted: b — Ship it"],
      ["update", "bd-x1", "--remove-label", "review:changes"],
      ["close", "bd-x1", "--reason", "Review accepted: b"],
    ]);
    expect(bd.mock.calls.every((c) => c[1] === DIR)).toBe(true);
    expect(herdr).toHaveBeenCalledWith(["agent", "prompt", "w1:p1", sent("Review bd-x1 accepted: b — Ship it")], socket);
  });

  it("request changes → done, label added", async () => {
    const { deps, bd } = relay({ show: shown({ metadata: { review: { pane: "w1:p1", socket } } }) });
    const report = await executeAction(act("review_decision", changes), deps);
    expect(report.state).toBe("done");
    expect(bd.mock.calls.map((c) => c[0][0])).toEqual(["show", "comments", "update"]);
  });

  it("ok: false → failed with the writer's error and its result kept", async () => {
    const { deps } = relay({ bdFails: { close: "bd close failed: database is locked" } });
    const report = await executeAction(act("review_decision", accept), deps);
    expect(report).toEqual({
      state: "failed",
      error: "bd close failed: database is locked",
      result: { ok: false, written: ["comment", "remove-changes-label"], attempted: true, error: "bd close failed: database is locked", partial: true, notified: { ok: false, reason: "the decision was not fully written" } },
    });
  });

  it("a failing bd show → failed with nothing attempted", async () => {
    const { deps, bd } = relay();
    bd.mockImplementationOnce(async () => {
      throw new Error("bd show failed: no database");
    });
    const report = await executeAction(act("review_decision", changes), deps);
    expect(report).toMatchObject({ state: "failed", error: "bd show failed: no database", result: { ok: false, attempted: false, written: [] } });
  });

  it("an accept on an issue already closed → done, already applied", async () => {
    const { deps, bd } = relay({ show: shown({ status: "closed" }) });
    const report = await executeAction(act("review_decision", accept), deps);
    expect(report).toEqual({ state: "done", result: { note: "already applied", message: 'Review "bd-x1" is already closed in the tracker; nothing was written.' } });
    expect(bd).toHaveBeenCalledTimes(1);
  });

  it("request changes on an issue already closed → failed: a changes decision never closes one, so it was not applied", async () => {
    const { deps, bd } = relay({ show: shown({ status: "closed" }) });
    const report = await executeAction(act("review_decision", changes), deps);
    expect(report).toEqual({ state: "failed", error: "refused: the review is closed", result: { refused: "closed" } });
    expect(reportSummary(report)).toBe("failed (the tracker's record refused it: closed)");
    expect(bd).toHaveBeenCalledTimes(1);
  });

  it("any other refusal of the record → failed with the reason", async () => {
    const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
      ["not-review", { labels: [] }, accept],
      ["option-changed", {}, { ...accept, seen: { ...accept.seen, label: "Three columns" } }],
      ["unknown-option", {}, { ...accept, option: "z" }],
      ["other-issue", { id: "bd-x2" }, accept],
    ];
    for (const [reason, record, payload] of cases) {
      const { deps, bd } = relay({ show: shown(record) });
      const report = await executeAction(act("review_decision", payload), deps);
      expect(report.state).toBe("failed");
      expect(report.result).toEqual({ refused: reason });
      expect(reportSummary(report)).toBe(`failed (the tracker's record refused it: ${reason})`);
      expect(bd).toHaveBeenCalledTimes(1);
    }
  });
});

describe("executeAction: herdr prompts and re-ingests", () => {
  it("prompts the pane on its socket → done { pane }", async () => {
    const { deps, herdr } = relay();
    expect(await executeAction(act("herdr_prompt", { pane: "e2e-pane-2", socket, text: "Inbox: accepted" }), deps)).toEqual({ state: "done", result: { pane: "e2e-pane-2" } });
    expect(herdr).toHaveBeenCalledWith(["agent", "prompt", "e2e-pane-2", sent("Inbox: accepted")], socket);
  });

  it("herdr's failure → failed with its reason", async () => {
    const { deps, herdr } = relay();
    herdr.mockRejectedValueOnce(new Error("pane not found (pane_not_found)"));
    expect(await executeAction(act("herdr_prompt", { pane: "w1:p1", socket, text: "hi" }), deps)).toEqual({ state: "failed", error: "pane not found (pane_not_found)" });
  });

  it("re-ingests after re-reading the registry → done { project, changed }, or failed", async () => {
    const { deps, reingest, reg } = relay();
    expect(await executeAction(act("beads_reingest", { project_key: "bd" }), deps)).toEqual({ state: "done", result: { project: "bd", changed: true } });
    expect(reg.refresh).toHaveBeenCalledTimes(1);
    expect(reingest).toHaveBeenCalledWith("bd");
    reingest.mockRejectedValueOnce(new Error("no issues to ingest"));
    expect(await executeAction(act("beads_reingest", { project_key: "bd" }), deps)).toEqual({ state: "failed", error: "no issues to ingest" });
  });
});
