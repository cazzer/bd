// review-writer tests (board-visual-reviews 3.3): no database. The writer
// runs against a fake runner that records every (args, cwd) it is handed,
// so each test proves the exact argv the tracker would see. The default
// runner runs against stub executables in a temp dir, with short timeouts.
// The pane notification (5.2) runs against a fake herdr runner the same way,
// and the default herdr runner against stubs.

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  BdUncertainError,
  commentText,
  createBdRunner,
  createHerdrRunner,
  createReviewWriter,
  NOTIFY_INVALID_PANE,
  NOTIFY_NO_PANE,
  notifyText,
  ReviewDecisionInFlightError,
  REVIEW_HERDR_TIMEOUT_MS,
  ReviewRecordRefusedError,
  type RunBd,
  type RunHerdr,
} from "./review-writer.js";

const CWD = "/checkouts/tides";
const BASE = { project: "tides", cwd: CWD, externalId: "tides-r1" } as const;

const shown = (over: Record<string, unknown> = {}) => JSON.stringify([{ id: "tides-r1", status: "open", labels: ["review"], ...over }]);

/** Answers `bd show` with an open review of the asked id unless `show` says otherwise; `fail` may throw for any command. */
function recordingRunner(opts: { show?: (id: string) => string; fail?: (args: readonly string[]) => Error | undefined } = {}) {
  const calls: Array<{ args: string[]; cwd: string }> = [];
  const runBd: RunBd = async (args, cwd) => {
    calls.push({ args: [...args], cwd });
    const err = opts.fail?.(args);
    if (err) throw err;
    if (args[0] === "show") return opts.show ? opts.show(args[1]!) : shown({ id: args[1] });
    return "";
  };
  const writes = () => calls.filter((c) => c.args[0] !== "show");
  return { runBd, calls, writes };
}

describe("commentText", () => {
  it("prefixes every decision so the argv element never starts with '-'", () => {
    expect(commentText("accept", "looks right")).toBe("Accepted: looks right");
    expect(commentText("accept", "   ")).toBe("Accepted.");
    expect(commentText("changes", "--force")).toBe("Changes requested: --force");
  });
});

describe("review writer", () => {
  let warn: MockInstance;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it("accept: reads the record, then comment, remove review:changes, close — all in the checkout", async () => {
    const { runBd, calls } = recordingRunner();
    const result = await createReviewWriter({ runBd }).write({ ...BASE, decision: "accept", message: "looks right" });

    expect(result).toEqual({ ok: true, written: ["comment", "remove-changes-label", "close"], attempted: true, notified: { ok: false, reason: NOTIFY_NO_PANE } });
    expect(calls).toEqual([
      { args: ["show", "tides-r1", "--json"], cwd: CWD },
      { args: ["comments", "add", "tides-r1", "Accepted: looks right"], cwd: CWD },
      { args: ["update", "tides-r1", "--remove-label", "review:changes"], cwd: CWD },
      { args: ["close", "tides-r1", "--reason", "Review accepted"], cwd: CWD },
    ]);
  });

  it("accept with an empty message writes 'Accepted.'", async () => {
    const { runBd, writes } = recordingRunner();
    await createReviewWriter({ runBd }).write({ ...BASE, decision: "accept", message: "" });
    expect(writes()[0]!.args).toEqual(["comments", "add", "tides-r1", "Accepted."]);
  });

  it("changes: comment, then add review:changes; the bead is not closed", async () => {
    const { runBd, writes } = recordingRunner();
    const result = await createReviewWriter({ runBd }).write({ ...BASE, decision: "changes", message: "header overlaps on narrow widths" });

    expect(result).toEqual({ ok: true, written: ["comment", "add-changes-label"], attempted: true, notified: { ok: false, reason: NOTIFY_NO_PANE } });
    expect(writes()).toEqual([
      { args: ["comments", "add", "tides-r1", "Changes requested: header overlaps on narrow widths"], cwd: CWD },
      { args: ["update", "tides-r1", "--add-label", "review:changes"], cwd: CWD },
    ]);
  });

  it.each([`"; rm -rf ~ #`, "$(x)", "line one\nline two", "`id` && echo pwned | tee /tmp/x"])("passes %j to bd as one argv element, verbatim", async (message) => {
    const { runBd, writes } = recordingRunner();
    await createReviewWriter({ runBd }).write({ ...BASE, decision: "changes", message });
    expect(writes()[0]!.args).toEqual(["comments", "add", "tides-r1", `Changes requested: ${message}`]);
  });

  it.each([
    ["not labelled review", shown({ labels: ["frontend"] }), "not-review"],
    ["without labels", shown({ labels: undefined }), "not-review"],
    ["closed in the tracker", shown({ status: "closed" }), "closed"],
    ["resolved to another issue", shown({ id: "tides-r10" }), "other-issue"],
  ])("refuses a record %s, writing nothing", async (_name, record, reason) => {
    const { runBd, writes } = recordingRunner({ show: () => record });
    const err = await createReviewWriter({ runBd })
      .write({ ...BASE, decision: "accept", message: "" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReviewRecordRefusedError);
    expect((err as ReviewRecordRefusedError).reason).toBe(reason);
    expect(writes()).toEqual([]);
  });

  it("a failing or unreadable bd show is reported with nothing attempted", async () => {
    const failing = recordingRunner({ fail: (args) => (args[0] === "show" ? new Error("bd show failed: no issue found") : undefined) });
    await expect(createReviewWriter({ runBd: failing.runBd }).write({ ...BASE, decision: "accept", message: "" })).resolves.toEqual({
      ok: false,
      written: [],
      attempted: false,
      error: "bd show failed: no issue found",
      partial: false,
      notified: null,
    });
    const garbled = recordingRunner({ show: () => "not json" });
    await expect(createReviewWriter({ runBd: garbled.runBd }).write({ ...BASE, decision: "accept", message: "" })).resolves.toMatchObject({ ok: false, attempted: false });
    expect(failing.writes()).toEqual([]);
    expect(garbled.writes()).toEqual([]);
  });

  it("a failing close after comment and label is a partial write naming what ran", async () => {
    const { runBd, writes } = recordingRunner({ fail: (args) => (args[0] === "close" ? new Error("bd close failed: database is locked") : undefined) });
    const result = await createReviewWriter({ runBd }).write({ ...BASE, decision: "accept", message: "ok" });

    expect(result).toEqual({ ok: false, written: ["comment", "remove-changes-label"], attempted: true, error: "bd close failed: database is locked", partial: true, notified: null });
    expect(writes()).toHaveLength(3);
  });

  it("a failing comment writes nothing and is not partial, but was attempted", async () => {
    const { runBd, writes } = recordingRunner({ fail: (args) => (args[0] === "comments" ? new Error("bd comments failed: no issue found") : undefined) });
    const result = await createReviewWriter({ runBd }).write({ ...BASE, decision: "changes", message: "fix it" });

    expect(result).toEqual({ ok: false, written: [], attempted: true, error: "bd comments failed: no issue found", partial: false, notified: null });
    expect(writes()).toHaveLength(1);
  });

  it("a step that timed out is reported uncertain: it may have been written", async () => {
    const { runBd } = recordingRunner({ fail: (args) => (args[0] === "close" ? new BdUncertainError("bd close timed out after 30 s") : undefined) });
    const result = await createReviewWriter({ runBd }).write({ ...BASE, decision: "accept", message: "" });

    expect(result).toMatchObject({ ok: false, written: ["comment", "remove-changes-label"], uncertain: "close", attempted: true, partial: true });
    expect(result.error).toMatch(/^bd close timed out after 30 s; it may have been written/);
  });

  it("refuses a second decision on the same item while one is pending, and allows it after", async () => {
    let release!: () => void;
    let held = false;
    const runBd: RunBd = (args) => {
      if (args[0] === "show") return Promise.resolve(shown({ id: args[1] }));
      if (!held) {
        held = true;
        return new Promise((resolve) => (release = () => resolve("")));
      }
      return Promise.resolve("");
    };
    const writer = createReviewWriter({ runBd });

    const first = writer.write({ ...BASE, decision: "accept", message: "" });
    await expect(writer.write({ ...BASE, decision: "changes", message: "no" })).rejects.toBeInstanceOf(ReviewDecisionInFlightError);
    // Another project's item with the same id is not refused (its checkout differs, so it is not queued either).
    await expect(writer.write({ ...BASE, project: "other", cwd: "/checkouts/other", decision: "accept", message: "" })).resolves.toMatchObject({ ok: true });

    release();
    await expect(first).resolves.toMatchObject({ ok: true });
    await expect(writer.write({ ...BASE, decision: "changes", message: "again" })).resolves.toMatchObject({ ok: true });
  });

  it("serializes writes to one checkout: a second item waits for the first to finish", async () => {
    const order: string[] = [];
    let release!: () => void;
    const runBd: RunBd = (args, cwd) => {
      order.push(`${cwd} ${args.slice(0, 2).join(" ")}`);
      if (args[0] === "show") return Promise.resolve(shown({ id: args[1] }));
      if (cwd === CWD && args[0] === "comments" && args[2] === "tides-r1") return new Promise((resolve) => (release = () => resolve("")));
      return Promise.resolve("");
    };
    const writer = createReviewWriter({ runBd });

    const first = writer.write({ ...BASE, decision: "changes", message: "a" });
    const second = writer.write({ ...BASE, externalId: "tides-r2", decision: "changes", message: "b" });
    const elsewhere = writer.write({ ...BASE, project: "other", cwd: "/checkouts/other", decision: "changes", message: "c" });
    await expect(elsewhere).resolves.toMatchObject({ ok: true });
    await new Promise((r) => setTimeout(r, 10));
    expect(order.filter((o) => o.startsWith(CWD))).toEqual([`${CWD} show tides-r1`, `${CWD} comments add`]);

    release();
    await Promise.all([first, second]);
    expect(order.filter((o) => o.startsWith(CWD))).toEqual([
      `${CWD} show tides-r1`,
      `${CWD} comments add`,
      `${CWD} update tides-r1`,
      `${CWD} show tides-r2`,
      `${CWD} comments add`,
      `${CWD} update tides-r2`,
    ]);
  });

  it("releases the in-flight claim and the checkout after a failure", async () => {
    const { runBd } = recordingRunner({ fail: (args) => (args[0] === "comments" ? new Error("bd comments failed: boom") : undefined) });
    const writer = createReviewWriter({ runBd });
    await writer.write({ ...BASE, decision: "accept", message: "" });
    await expect(writer.write({ ...BASE, decision: "accept", message: "" })).resolves.toMatchObject({ ok: false, written: [] });
  });
});

describe("pane notification", () => {
  let warn: MockInstance;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  const withPane = (pane: unknown) => (id: string) => shown({ id, metadata: { review: { pane, images: [], summary: "s" } } });

  /** Records every herdr argv; `fail` may reject it. */
  function recordingHerdr(fail?: () => Error) {
    const calls: string[][] = [];
    const runHerdr: RunHerdr = async (args) => {
      calls.push([...args]);
      if (fail) throw fail();
    };
    return { runHerdr, calls };
  }

  it("notifyText names the bead and the decision", () => {
    expect(notifyText("accept", "x-1", " ship it ")).toBe("Review x-1 accepted: ship it");
    expect(notifyText("accept", "x-1", "  ")).toBe("Review x-1 accepted.");
    expect(notifyText("changes", "x-1", "--force")).toBe("Review x-1 changes requested: --force");
  });

  it("accept: prompts the tracker record's pane after every bd step, with the exact argv", async () => {
    const order: string[] = [];
    const runBd: RunBd = async (args) => {
      order.push(`bd ${args[0]}`);
      return args[0] === "show" ? withPane("w1:p2")(args[1]!) : "";
    };
    const herdr = recordingHerdr();
    const runHerdr: RunHerdr = async (args) => {
      order.push("herdr");
      await herdr.runHerdr(args);
    };
    const result = await createReviewWriter({ runBd, runHerdr }).write({ ...BASE, decision: "accept", message: "looks right" });

    expect(result).toEqual({ ok: true, written: ["comment", "remove-changes-label", "close"], attempted: true, notified: { ok: true, pane: "w1:p2" } });
    expect(herdr.calls).toEqual([["agent", "prompt", "w1:p2", "Review tides-r1 accepted: looks right"]]);
    expect(order).toEqual(["bd show", "bd comments", "bd update", "bd close", "herdr"]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("accept with no message sends 'Review <id> accepted.'", async () => {
    const { runBd } = recordingRunner({ show: withPane("w1:p2") });
    const herdr = recordingHerdr();
    await createReviewWriter({ runBd, runHerdr: herdr.runHerdr }).write({ ...BASE, decision: "accept", message: "" });
    expect(herdr.calls).toEqual([["agent", "prompt", "w1:p2", "Review tides-r1 accepted."]]);
  });

  it("changes: sends 'Review <id> changes requested: <message>' to the trimmed pane", async () => {
    const { runBd } = recordingRunner({ show: withPane("  w3:p1 ") });
    const herdr = recordingHerdr();
    const result = await createReviewWriter({ runBd, runHerdr: herdr.runHerdr }).write({ ...BASE, decision: "changes", message: "header overlaps" });
    expect(herdr.calls).toEqual([["agent", "prompt", "w3:p1", "Review tides-r1 changes requested: header overlaps"]]);
    expect(result.notified).toEqual({ ok: true, pane: "w3:p1" });
  });

  it.each([
    ["no metadata", (id: string) => shown({ id })],
    ["no review metadata", (id: string) => shown({ id, metadata: { other: 1 } })],
    ["a null pane", withPane(null)],
    ["a blank pane", withPane("   ")],
  ])("%s: no herdr call, the decision stands, and it is logged", async (_name, show) => {
    const { runBd } = recordingRunner({ show });
    const herdr = recordingHerdr();
    const result = await createReviewWriter({ runBd, runHerdr: herdr.runHerdr }).write({ ...BASE, decision: "accept", message: "" });
    expect(result).toMatchObject({ ok: true, notified: { ok: false, reason: NOTIFY_NO_PANE } });
    expect(herdr.calls).toEqual([]);
    expect(warn).toHaveBeenCalledWith(`[breakdown-web] review tides/tides-r1: agent not notified: ${NOTIFY_NO_PANE}`);
  });

  it.each([["w1 p2"], ["-rf"], ["--help"], ["w1;p2"], ["x".repeat(65)], [42], [["w1:p2"]]])("refuses pane %j without calling herdr", async (pane) => {
    const { runBd } = recordingRunner({ show: withPane(pane) });
    const herdr = recordingHerdr();
    const result = await createReviewWriter({ runBd, runHerdr: herdr.runHerdr }).write({ ...BASE, decision: "changes", message: "fix" });
    expect(result).toMatchObject({ ok: true, written: ["comment", "add-changes-label"], notified: { ok: false, reason: NOTIFY_INVALID_PANE } });
    expect(herdr.calls).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it.each([["agent target w1:p2 not found (agent_not_found)"], ["herdr timed out after 10 s"], ["herdr not found on PATH"]])(
    "a failing herdr (%s) leaves the decision written and reports why",
    async (reason) => {
      const { runBd, writes } = recordingRunner({ show: withPane("w1:p2") });
      const herdr = recordingHerdr(() => new Error(reason));
      const result = await createReviewWriter({ runBd, runHerdr: herdr.runHerdr }).write({ ...BASE, decision: "accept", message: "secret words" });
      expect(result).toEqual({ ok: true, written: ["comment", "remove-changes-label", "close"], attempted: true, notified: { ok: false, reason } });
      expect(writes()).toHaveLength(3);
      expect(herdr.calls).toHaveLength(1);
      expect(warn).toHaveBeenCalledWith(`[breakdown-web] review tides/tides-r1: agent not notified: ${reason}`);
      expect(String(warn.mock.calls[0]![0])).not.toContain("secret words");
    },
  );

  it.each([
    ["a partial write", new Error("bd close failed: database is locked")],
    ["an uncertain step", new BdUncertainError("bd close timed out after 30 s")],
  ])("%s notifies nobody", async (_name, error) => {
    const { runBd } = recordingRunner({ show: withPane("w1:p2"), fail: (args) => (args[0] === "close" ? error : undefined) });
    const herdr = recordingHerdr();
    const result = await createReviewWriter({ runBd, runHerdr: herdr.runHerdr }).write({ ...BASE, decision: "accept", message: "" });
    expect(result).toMatchObject({ ok: false, partial: true, notified: null });
    expect(herdr.calls).toEqual([]);
  });

  it("a failed bd show or a failed first step notifies nobody", async () => {
    const herdr = recordingHerdr();
    const failingShow = recordingRunner({ fail: (args) => (args[0] === "show" ? new Error("bd show failed") : undefined) });
    await expect(createReviewWriter({ runBd: failingShow.runBd, runHerdr: herdr.runHerdr }).write({ ...BASE, decision: "accept", message: "" })).resolves.toMatchObject({ notified: null });
    const failingComment = recordingRunner({ show: withPane("w1:p2"), fail: (args) => (args[0] === "comments" ? new Error("bd comments failed") : undefined) });
    await expect(createReviewWriter({ runBd: failingComment.runBd, runHerdr: herdr.runHerdr }).write({ ...BASE, decision: "changes", message: "x" })).resolves.toMatchObject({
      notified: null,
    });
    expect(herdr.calls).toEqual([]);
  });

  it("does not hold the checkout's write queue while herdr runs", async () => {
    const pending: Array<{ text: string; release: () => void }> = [];
    const runBd: RunBd = async (args) => (args[0] === "show" ? withPane("w1:p2")(args[1]!) : "");
    const runHerdr: RunHerdr = (args) => new Promise((resolve) => pending.push({ text: args[3]!, release: resolve }));
    const writer = createReviewWriter({ runBd, runHerdr });

    const first = writer.write({ ...BASE, decision: "changes", message: "a" });
    await new Promise((r) => setTimeout(r, 10));
    // Same checkout, another item: its bd writes and its own herdr call run while the first item's herdr call is pending.
    const second = writer.write({ ...BASE, externalId: "tides-r2", decision: "changes", message: "b" });
    await new Promise((r) => setTimeout(r, 10));
    expect(pending.map((p) => p.text)).toEqual(["Review tides-r1 changes requested: a", "Review tides-r2 changes requested: b"]);
    for (const p of pending) p.release();
    await expect(first).resolves.toMatchObject({ ok: true, notified: { ok: true } });
    await expect(second).resolves.toMatchObject({ ok: true, written: ["comment", "add-changes-label"], notified: { ok: true } });
  });
});

describe("default bd runner", () => {
  let dir: string;
  const stub = (name: string, body: string) => {
    const file = path.join(dir, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
    return file;
  };
  const SECRET = `"; rm -rf ~ # secret-message`;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "review-runner-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("passes argv verbatim with no shell, runs in cwd, and drops BEADS_DIR / BEADS_DB", async () => {
    const echo = stub("echo-bd", `pwd; printf '%s|' "$@"; echo; echo "dir=\${BEADS_DIR-unset} db=\${BEADS_DB-unset}"`);
    process.env["BEADS_DIR"] = "/elsewhere";
    process.env["BEADS_DB"] = "/elsewhere/db";
    try {
      const out = await createBdRunner({ command: echo })(["comments", "add", "x-1", `Changes requested: ${SECRET}\n$(x)`], dir);
      const lines = out.split("\n");
      expect(lines[0]).toBe((await import("node:fs")).realpathSync(dir));
      expect(out).toContain(`comments|add|x-1|Changes requested: ${SECRET}\n$(x)|`);
      expect(out).toContain("dir=unset db=unset");
    } finally {
      delete process.env["BEADS_DIR"];
      delete process.env["BEADS_DB"];
    }
  });

  it("names stderr on a non-zero exit, else the exit code — never the arguments", async () => {
    const loud = stub("loud-bd", `echo "Error: no issue found" >&2; exit 1`);
    const quiet = stub("quiet-bd", "exit 3");
    await expect(createBdRunner({ command: loud })(["comments", "add", "x-1", SECRET], dir)).rejects.toThrow(/^bd comments failed: Error: no issue found$/);
    const err = await createBdRunner({ command: quiet })(["comments", "add", "x-1", SECRET], dir).catch((e: unknown) => e);
    expect((err as Error).message).toBe("bd comments exited 3");
    expect(err).not.toBeInstanceOf(BdUncertainError);
  });

  it("says bd is not on PATH when the executable is missing", async () => {
    await expect(createBdRunner({ command: path.join(dir, "missing-bd") })(["close", "x-1"], dir)).rejects.toThrow(/^bd not found on PATH$/);
  });

  it("times out with SIGTERM and reports the command as uncertain", async () => {
    const sleeper = stub("sleep-bd", "exec sleep 10");
    const started = Date.now();
    const err = await createBdRunner({ command: sleeper, timeoutMs: 200, killGraceMs: 5_000 })(["close", "x-1", SECRET], dir).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BdUncertainError);
    expect((err as Error).message).toBe("bd close timed out after 0.2 s");
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("SIGKILLs a command that ignores SIGTERM after the grace period", async () => {
    const stubborn = stub("stubborn-bd", "trap '' TERM\nexec sleep 10");
    const started = Date.now();
    const err = await createBdRunner({ command: stubborn, timeoutMs: 200, killGraceMs: 300 })(["update", "x-1"], dir).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BdUncertainError);
    expect((err as Error).message).toBe("bd update timed out after 0.2 s");
    expect(Date.now() - started).toBeGreaterThanOrEqual(450);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("reports a command killed by someone else as uncertain", async () => {
    const suicidal = stub("killed-bd", "kill -9 $$");
    const err = await createBdRunner({ command: suicidal })(["close", "x-1"], dir).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BdUncertainError);
    expect((err as Error).message).toBe("bd close was killed (SIGKILL)");
  });

  it("says it could not start bd when the checkout is gone, not that bd is missing", async () => {
    const gone = path.join(dir, "gone");
    await expect(createBdRunner({ command: "/bin/echo" })(["show", "x-1"], gone)).rejects.toThrow(`could not start bd in ${gone}`);
  });

  it("settles at the hard deadline when a grandchild holds the output pipes open", async () => {
    // The background sleep inherits stdout and ignores nothing; killing the stub leaves it holding the pipe.
    const leaky = stub("leaky-bd", "sleep 4 &\nexec sleep 10");
    const started = Date.now();
    const err = await createBdRunner({ command: leaky, timeoutMs: 200, killGraceMs: 200 })(["close", "x-1"], dir).catch((e: unknown) => e);
    const elapsed = Date.now() - started;
    expect(err).toBeInstanceOf(BdUncertainError);
    expect((err as Error).message).toBe("bd close timed out after 0.2 s");
    expect(elapsed).toBeGreaterThanOrEqual(1_300);
    expect(elapsed).toBeLessThan(3_000);
  });
});

describe("default herdr runner", () => {
  let dir: string;
  const stub = (name: string, body: string) => {
    const file = path.join(dir, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
    return file;
  };
  const PROMPT = `Review x-1 changes requested: "; rm -rf ~ # secret-message\n$(x)`;
  const ARGS = ["agent", "prompt", "w1:p2", PROMPT];

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "review-herdr-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("passes argv verbatim with no shell and resolves on exit 0", async () => {
    const log = path.join(dir, "argv.log");
    const echo = stub("echo-herdr", `printf '%s|' "$@" > '${log}'; echo '{"ok":true}'`);
    await expect(createHerdrRunner({ command: echo })(ARGS)).resolves.toBeUndefined();
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(log, "utf8")).toBe(`agent|prompt|w1:p2|${PROMPT}|`);
  });

  it("reduces herdr's JSON error to its message and code", async () => {
    const gone = stub("gone-herdr", `echo '{"error":{"code":"agent_not_found","message":"agent target w1:p2 not found"},"id":"cli:agent:prompt"}' >&2; exit 1`);
    await expect(createHerdrRunner({ command: gone })(ARGS)).rejects.toThrow(/^agent target w1:p2 not found \(agent_not_found\)$/);
  });

  it("never echoes the prompt back, even when herdr does", async () => {
    const echoing = stub("echoing-herdr", `printf 'refused: %s\\n' "$4" >&2; exit 2`);
    const err = (await createHerdrRunner({ command: echoing })(["agent", "prompt", "w1:p2", "Review x-1 accepted: secret-message"]).catch((e: unknown) => e)) as Error;
    expect(err.message).toBe("refused: …");
    expect(err.message).not.toContain("secret-message");
    // A multi-line prompt: herdr's first line carries only the prompt's first line.
    const multi = (await createHerdrRunner({ command: echoing })(["agent", "prompt", "w1:p2", "Review x-1 changes requested: first secret line\nsecond line"]).catch((e: unknown) => e)) as Error;
    expect(multi.message).toBe("refused: …");
  });

  it("names the exit code when herdr says nothing", async () => {
    const quiet = stub("quiet-herdr", "exit 3");
    await expect(createHerdrRunner({ command: quiet })(ARGS)).rejects.toThrow(/^herdr exited 3$/);
  });

  it("says herdr is not on PATH when the executable is missing", async () => {
    await expect(createHerdrRunner({ command: path.join(dir, "missing-herdr") })(ARGS)).rejects.toThrow(/^herdr not found on PATH$/);
  });

  it("times out with SIGTERM", async () => {
    const sleeper = stub("sleep-herdr", "exec sleep 10");
    const started = Date.now();
    await expect(createHerdrRunner({ command: sleeper, timeoutMs: 200, killGraceMs: 5_000 })(ARGS)).rejects.toThrow(/^herdr timed out after 0\.2 s$/);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("SIGKILLs a herdr that ignores SIGTERM after the grace period", async () => {
    const stubborn = stub("stubborn-herdr", "trap '' TERM\nexec sleep 10");
    const started = Date.now();
    await expect(createHerdrRunner({ command: stubborn, timeoutMs: 200, killGraceMs: 300 })(ARGS)).rejects.toThrow(/^herdr timed out after 0\.2 s$/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(450);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("defaults to a 10 s timeout", () => {
    expect(REVIEW_HERDR_TIMEOUT_MS).toBe(10_000);
  });
});
