// review-writer tests (board-visual-reviews 3.3): no database. The writer
// runs against a fake runner that records every (args, cwd) it is handed,
// so each test proves the exact argv the tracker would see. The default
// runner runs against stub executables in a temp dir, with short timeouts.

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BdUncertainError, commentText, createBdRunner, createReviewWriter, ReviewDecisionInFlightError, ReviewRecordRefusedError, type RunBd } from "./review-writer.js";

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
  it("accept: reads the record, then comment, remove review:changes, close — all in the checkout", async () => {
    const { runBd, calls } = recordingRunner();
    const result = await createReviewWriter({ runBd }).write({ ...BASE, decision: "accept", message: "looks right" });

    expect(result).toEqual({ ok: true, written: ["comment", "remove-changes-label", "close"], attempted: true });
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

    expect(result).toEqual({ ok: true, written: ["comment", "add-changes-label"], attempted: true });
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
    });
    const garbled = recordingRunner({ show: () => "not json" });
    await expect(createReviewWriter({ runBd: garbled.runBd }).write({ ...BASE, decision: "accept", message: "" })).resolves.toMatchObject({ ok: false, attempted: false });
    expect(failing.writes()).toEqual([]);
    expect(garbled.writes()).toEqual([]);
  });

  it("a failing close after comment and label is a partial write naming what ran", async () => {
    const { runBd, writes } = recordingRunner({ fail: (args) => (args[0] === "close" ? new Error("bd close failed: database is locked") : undefined) });
    const result = await createReviewWriter({ runBd }).write({ ...BASE, decision: "accept", message: "ok" });

    expect(result).toEqual({ ok: false, written: ["comment", "remove-changes-label"], attempted: true, error: "bd close failed: database is locked", partial: true });
    expect(writes()).toHaveLength(3);
  });

  it("a failing comment writes nothing and is not partial, but was attempted", async () => {
    const { runBd, writes } = recordingRunner({ fail: (args) => (args[0] === "comments" ? new Error("bd comments failed: no issue found") : undefined) });
    const result = await createReviewWriter({ runBd }).write({ ...BASE, decision: "changes", message: "fix it" });

    expect(result).toEqual({ ok: false, written: [], attempted: true, error: "bd comments failed: no issue found", partial: false });
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
});
