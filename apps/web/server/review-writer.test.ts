// review-writer tests (board-visual-reviews 3.3): no database. The writer
// runs against a fake runner that records every (args, cwd) it is handed,
// so each test proves the exact argv the tracker would see. The default
// runner runs against stub executables in a temp dir, with short timeouts.
// The pane notification (5.2) runs against a fake herdr runner the same way,
// and the default herdr runner against stubs.

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { MAX_REVIEW_COMMENT_LENGTH, REVIEW_OPTION_ID_PATTERN } from "@breakdown/core";
import {
  BdUncertainError,
  closeReason,
  commentText,
  createBdRunner,
  createHerdrRunner,
  createReviewWriter,
  NOTIFY_INVALID_PANE,
  NOTIFY_NO_PANE,
  NOTIFY_NOT_WRITTEN,
  NOTIFY_UNKNOWN_SESSION,
  notifyText,
  ReviewDecisionInFlightError,
  REVIEW_HERDR_TIMEOUT_MS,
  ReviewRecordRefusedError,
  type RunBd,
  type RunHerdr,
} from "./review-writer.js";
import { MAX_REVIEW_MESSAGE_LENGTH } from "./routers/review.js";

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
      notified: { ok: false, reason: NOTIFY_NOT_WRITTEN },
    });
    const garbled = recordingRunner({ show: () => "not json" });
    await expect(createReviewWriter({ runBd: garbled.runBd }).write({ ...BASE, decision: "accept", message: "" })).resolves.toMatchObject({ ok: false, attempted: false });
    expect(failing.writes()).toEqual([]);
    expect(garbled.writes()).toEqual([]);
  });

  it("a failing close after comment and label is a partial write naming what ran", async () => {
    const { runBd, writes } = recordingRunner({ fail: (args) => (args[0] === "close" ? new Error("bd close failed: database is locked") : undefined) });
    const result = await createReviewWriter({ runBd }).write({ ...BASE, decision: "accept", message: "ok" });

    expect(result).toEqual({ ok: false, written: ["comment", "remove-changes-label"], attempted: true, error: "bd close failed: database is locked", partial: true, notified: { ok: false, reason: NOTIFY_NOT_WRITTEN } });
    expect(writes()).toHaveLength(3);
  });

  it("a failing comment writes nothing and is not partial, but was attempted", async () => {
    const { runBd, writes } = recordingRunner({ fail: (args) => (args[0] === "comments" ? new Error("bd comments failed: no issue found") : undefined) });
    const result = await createReviewWriter({ runBd }).write({ ...BASE, decision: "changes", message: "fix it" });

    expect(result).toEqual({ ok: false, written: [], attempted: true, error: "bd comments failed: no issue found", partial: false, notified: { ok: false, reason: NOTIFY_NOT_WRITTEN } });
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
  let sockDir: string;
  let SOCKET: string;
  let server: Server;
  beforeAll(async () => {
    // A real unix socket: the writer requires the recorded path to be one on disk.
    sockDir = mkdtempSync(path.join(tmpdir(), "rw-sock-"));
    SOCKET = path.join(sockDir, "h.sock");
    server = createServer();
    await new Promise<void>((resolve) => server.listen(SOCKET, resolve));
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(sockDir, { recursive: true, force: true });
  });
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  const withReview = (review: Record<string, unknown>) => (id: string) => shown({ id, metadata: { review: { images: [], summary: "s", ...review } } });
  const withPane = (pane: unknown) => withReview({ pane, socket: SOCKET });

  /** Records every herdr argv and socket; `fail` may reject it. */
  function recordingHerdr(fail?: () => Error) {
    const calls: Array<{ args: string[]; socket: string }> = [];
    const runHerdr: RunHerdr = async (args, socket) => {
      calls.push({ args: [...args], socket });
      if (fail) throw fail();
    };
    return { runHerdr, calls };
  }

  it("notifyText names the bead and the decision", () => {
    expect(notifyText("accept", "x-1", " ship it ")).toBe("Review x-1 accepted: ship it");
    expect(notifyText("accept", "x-1", "  ")).toBe("Review x-1 accepted.");
    expect(notifyText("changes", "x-1", "--force")).toBe("Review x-1 changes requested: --force");
  });

  it("accept: prompts the tracker record's pane through its socket, after the bd steps and onWritten, with the exact argv", async () => {
    const order: string[] = [];
    const runBd: RunBd = async (args) => {
      order.push(`bd ${args[0]}`);
      return args[0] === "show" ? withPane("w1:p2")(args[1]!) : "";
    };
    const herdr = recordingHerdr();
    const runHerdr: RunHerdr = async (args, socket) => {
      order.push("herdr");
      await herdr.runHerdr(args, socket);
    };
    const onWritten = vi.fn((outcome: { ok: boolean; attempted: boolean }) => order.push(`onWritten ${outcome.ok} ${outcome.attempted}`));
    const result = await createReviewWriter({ runBd, runHerdr }).write({ ...BASE, decision: "accept", message: "looks right", onWritten });

    expect(result).toEqual({ ok: true, written: ["comment", "remove-changes-label", "close"], attempted: true, notified: { ok: true, pane: "w1:p2" } });
    expect(herdr.calls).toEqual([{ args: ["agent", "prompt", "w1:p2", "Review tides-r1 accepted: looks right"], socket: SOCKET }]);
    expect(order).toEqual(["bd show", "bd comments", "bd update", "bd close", "onWritten true true", "herdr"]);
    expect(onWritten).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();
  });

  it("accept with no message sends 'Review <id> accepted.'", async () => {
    const { runBd } = recordingRunner({ show: withPane("w1:p2") });
    const herdr = recordingHerdr();
    await createReviewWriter({ runBd, runHerdr: herdr.runHerdr }).write({ ...BASE, decision: "accept", message: "" });
    expect(herdr.calls.map((c) => c.args)).toEqual([["agent", "prompt", "w1:p2", "Review tides-r1 accepted."]]);
  });

  it("changes: sends 'Review <id> changes requested: <message>' to the trimmed pane", async () => {
    const { runBd } = recordingRunner({ show: withPane("  w3:p1 ") });
    const herdr = recordingHerdr();
    const result = await createReviewWriter({ runBd, runHerdr: herdr.runHerdr }).write({ ...BASE, decision: "changes", message: "header overlaps" });
    expect(herdr.calls.map((c) => c.args)).toEqual([["agent", "prompt", "w3:p1", "Review tides-r1 changes requested: header overlaps"]]);
    expect(result.notified).toEqual({ ok: true, pane: "w3:p1" });
  });

  it.each([
    ["no metadata", (id: string) => shown({ id })],
    ["no review metadata", (id: string) => shown({ id, metadata: { other: 1 } })],
    ["a null pane", (id: string) => withPane(null)(id)],
    ["a blank pane", (id: string) => withPane("   ")(id)],
  ])("%s: no herdr call, the decision stands, and it is logged", async (_name, show) => {
    const { runBd } = recordingRunner({ show });
    const herdr = recordingHerdr();
    const result = await createReviewWriter({ runBd, runHerdr: herdr.runHerdr }).write({ ...BASE, decision: "accept", message: "" });
    expect(result).toMatchObject({ ok: true, notified: { ok: false, reason: NOTIFY_NO_PANE } });
    expect(herdr.calls).toEqual([]);
    expect(warn).toHaveBeenCalledWith(`[breakdown-web] review tides/tides-r1: agent not notified: ${NOTIFY_NO_PANE}`);
  });

  it.each([["w1 p2"], ["-rf"], ["--help"], [":p2"], ["w1;p2"], ["x".repeat(65)], [42], [["w1:p2"]]])("refuses pane %j without calling herdr", async (pane) => {
    const { runBd } = recordingRunner({ show: (id) => withPane(pane)(id) });
    const herdr = recordingHerdr();
    const result = await createReviewWriter({ runBd, runHerdr: herdr.runHerdr }).write({ ...BASE, decision: "changes", message: "fix" });
    expect(result).toMatchObject({ ok: true, written: ["comment", "add-changes-label"], notified: { ok: false, reason: NOTIFY_INVALID_PANE } });
    expect(herdr.calls).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it.each([
    ["no socket", () => ({})],
    ["a null socket", () => ({ socket: null })],
    ["a relative socket", () => ({ socket: "h.sock" })],
    ["a socket with a control character", () => ({ socket: `${SOCKET}\n` })],
    ["an over-long socket", () => ({ socket: `/${"s".repeat(600)}` })],
    ["a socket path that does not exist", () => ({ socket: path.join(sockDir, "gone.sock") })],
    ["a socket path that is a directory", () => ({ socket: sockDir })],
  ])("%s: the pane's session is unknown, so no herdr call", async (_name, socket) => {
    const { runBd } = recordingRunner({ show: (id) => withReview({ pane: "w1:p2", ...socket() })(id) });
    const herdr = recordingHerdr();
    const result = await createReviewWriter({ runBd, runHerdr: herdr.runHerdr }).write({ ...BASE, decision: "accept", message: "" });
    expect(result).toMatchObject({ ok: true, notified: { ok: false, reason: NOTIFY_UNKNOWN_SESSION } });
    expect(herdr.calls).toEqual([]);
    expect(warn).toHaveBeenCalledWith(`[breakdown-web] review tides/tides-r1: agent not notified: ${NOTIFY_UNKNOWN_SESSION}`);
  });

  it.each([["agent target w1:p2 not found (agent_not_found)"], ["herdr timed out after 10 s; the agent may have been notified"], ["herdr not found on PATH"]])(
    "a failing herdr (%s) leaves the decision written and reports why",
    async (reason) => {
      const { runBd, writes } = recordingRunner({ show: (id) => withPane("w1:p2")(id) });
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
  ])("%s notifies nobody and says why", async (_name, error) => {
    const { runBd } = recordingRunner({ show: (id) => withPane("w1:p2")(id), fail: (args) => (args[0] === "close" ? error : undefined) });
    const herdr = recordingHerdr();
    const onWritten = vi.fn();
    const result = await createReviewWriter({ runBd, runHerdr: herdr.runHerdr }).write({ ...BASE, decision: "accept", message: "", onWritten });
    expect(result).toMatchObject({ ok: false, partial: true, notified: { ok: false, reason: NOTIFY_NOT_WRITTEN } });
    expect(herdr.calls).toEqual([]);
    expect(onWritten).toHaveBeenCalledWith({ ok: false, attempted: true });
    expect(warn).toHaveBeenCalledWith(`[breakdown-web] review tides/tides-r1: agent not notified: ${NOTIFY_NOT_WRITTEN}`);
  });

  it("a failed bd show or a failed first step notifies nobody", async () => {
    const herdr = recordingHerdr();
    const failingShow = recordingRunner({ fail: (args) => (args[0] === "show" ? new Error("bd show failed") : undefined) });
    const onWritten = vi.fn();
    await expect(createReviewWriter({ runBd: failingShow.runBd, runHerdr: herdr.runHerdr }).write({ ...BASE, decision: "accept", message: "", onWritten })).resolves.toMatchObject({
      notified: { ok: false, reason: NOTIFY_NOT_WRITTEN },
    });
    expect(onWritten).toHaveBeenCalledWith({ ok: false, attempted: false });
    const failingComment = recordingRunner({ show: (id) => withPane("w1:p2")(id), fail: (args) => (args[0] === "comments" ? new Error("bd comments failed") : undefined) });
    await expect(createReviewWriter({ runBd: failingComment.runBd, runHerdr: herdr.runHerdr }).write({ ...BASE, decision: "changes", message: "x" })).resolves.toMatchObject({
      notified: { ok: false, reason: NOTIFY_NOT_WRITTEN },
    });
    expect(herdr.calls).toEqual([]);
  });

  it("a refused record calls neither onWritten nor herdr", async () => {
    const { runBd } = recordingRunner({ show: () => shown({ status: "closed" }) });
    const herdr = recordingHerdr();
    const onWritten = vi.fn();
    await expect(createReviewWriter({ runBd, runHerdr: herdr.runHerdr }).write({ ...BASE, decision: "accept", message: "", onWritten })).rejects.toBeInstanceOf(ReviewRecordRefusedError);
    expect(onWritten).not.toHaveBeenCalled();
    expect(herdr.calls).toEqual([]);
  });

  it("an onWritten that throws is logged and does not stop the notification", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { runBd } = recordingRunner({ show: (id) => withPane("w1:p2")(id) });
      const herdr = recordingHerdr();
      const result = await createReviewWriter({ runBd, runHerdr: herdr.runHerdr }).write({
        ...BASE,
        decision: "accept",
        message: "",
        onWritten: () => {
          throw new Error("wake failed");
        },
      });
      expect(result).toMatchObject({ ok: true, notified: { ok: true, pane: "w1:p2" } });
      expect(error).toHaveBeenCalledWith("[breakdown-web] review tides/tides-r1: onWritten failed: wake failed");
    } finally {
      error.mockRestore();
    }
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

describe("decisions that name an option (decision-card-reviews 3.3)", () => {
  let warn: MockInstance;
  let sockDir: string;
  let SOCKET: string;
  let server: Server;
  beforeAll(async () => {
    sockDir = mkdtempSync(path.join(tmpdir(), "rw-opt-sock-"));
    SOCKET = path.join(sockDir, "h.sock");
    server = createServer();
    await new Promise<void>((resolve) => server.listen(SOCKET, resolve));
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(sockDir, { recursive: true, force: true });
  });
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  const OPTIONS = [
    { id: "A", label: "Keep the tracking migration" },
    { id: "B", label: "Skip it" },
    { id: "C", label: "Split it" },
  ];
  /** The tracker's record: a card with options A, B, C recommending A, unless `review` replaces keys. */
  const card =
    (review: Record<string, unknown> = {}) =>
    (id: string) =>
      shown({ id, metadata: { review: { images: [], summary: "Which migration?", question: "Which migration?", options: OPTIONS, recommend: "A", pane: "w1:p2", socket: SOCKET, ...review } } });
  const legacy = (id: string) => shown({ id, metadata: { review: { images: ["/tmp/a.png"], summary: "header and grid", pane: "w1:p2", socket: SOCKET } } });

  function recordingHerdr() {
    const calls: string[][] = [];
    const runHerdr: RunHerdr = async (args) => {
      calls.push([...args]);
    };
    return { runHerdr, calls };
  }

  it("texts name the option with an em dash; without one they are exactly today's", () => {
    expect(commentText("accept", "skip the tracking migration", "B")).toBe("Accepted: B — skip the tracking migration");
    expect(commentText("accept", "  ", "B")).toBe("Accepted: B.");
    expect(closeReason("B")).toBe("Review accepted: B");
    expect(notifyText("accept", "x-1", " go ", "B")).toBe("Review x-1 accepted: B — go");
    expect(notifyText("accept", "x-1", "", "B")).toBe("Review x-1 accepted: B.");

    expect(commentText("accept", "looks right")).toBe("Accepted: looks right");
    expect(commentText("accept", "")).toBe("Accepted.");
    expect(commentText("changes", "fix")).toBe("Changes requested: fix");
    expect(closeReason()).toBe("Review accepted");
    expect(notifyText("accept", "x-1", "ship it")).toBe("Review x-1 accepted: ship it");
    expect(notifyText("accept", "x-1", "")).toBe("Review x-1 accepted.");
  });

  it("the longest option prefix still fits the comment cap at the longest message", () => {
    const longest = commentText("accept", "m".repeat(MAX_REVIEW_MESSAGE_LENGTH), "Z".repeat(16));
    expect(REVIEW_OPTION_ID_PATTERN.test("Z".repeat(16))).toBe(true);
    expect(REVIEW_OPTION_ID_PATTERN.test("Z".repeat(17))).toBe(false);
    expect(longest.length).toBeLessThanOrEqual(MAX_REVIEW_COMMENT_LENGTH);
    expect(commentText("changes", "m".repeat(MAX_REVIEW_MESSAGE_LENGTH)).length).toBeLessThanOrEqual(MAX_REVIEW_COMMENT_LENGTH);
  });

  it("choosing a non-recommended option: comment, close reason, and prompt name it", async () => {
    const { runBd, calls } = recordingRunner({ show: card() });
    const herdr = recordingHerdr();
    const result = await createReviewWriter({ runBd, runHerdr: herdr.runHerdr }).write({ ...BASE, decision: "accept", message: "skip the tracking migration", option: "B" });

    expect(result).toEqual({ ok: true, written: ["comment", "remove-changes-label", "close"], attempted: true, notified: { ok: true, pane: "w1:p2" } });
    expect(calls.map((c) => c.args)).toEqual([
      ["show", "tides-r1", "--json"],
      ["comments", "add", "tides-r1", "Accepted: B — skip the tracking migration"],
      ["update", "tides-r1", "--remove-label", "review:changes"],
      ["close", "tides-r1", "--reason", "Review accepted: B"],
    ]);
    expect(herdr.calls).toEqual([["agent", "prompt", "w1:p2", "Review tides-r1 accepted: B — skip the tracking migration"]]);
  });

  it.each([
    ["with a message", "ship it", "Accepted: A — ship it", "Review tides-r1 accepted: A — ship it"],
    ["without a message", "", "Accepted: A.", "Review tides-r1 accepted: A."],
  ])("accepting the recommended option %s", async (_name, message, comment, prompt) => {
    const { runBd, writes } = recordingRunner({ show: card() });
    const herdr = recordingHerdr();
    await createReviewWriter({ runBd, runHerdr: herdr.runHerdr }).write({ ...BASE, decision: "accept", message, option: "A" });
    expect(writes().map((c) => c.args)).toEqual([
      ["comments", "add", "tides-r1", comment],
      ["update", "tides-r1", "--remove-label", "review:changes"],
      ["close", "tides-r1", "--reason", "Review accepted: A"],
    ]);
    expect(herdr.calls).toEqual([["agent", "prompt", "w1:p2", prompt]]);
  });

  it.each([
    ["an option the card does not offer", card(), "accept", "Z", "unknown-option", `Review "tides-r1" does not offer option "Z" (it offers A, B, C); nothing was written.`],
    ["an accept without an option on a card with options", card(), "accept", undefined, "option-required", `Review "tides-r1" offers options (A, B, C); accepting it must name one. Nothing was written.`],
    ["an option with changes", card(), "changes", "B", "option-with-changes", `An option is chosen only by accepting; a request for changes on "tides-r1" names none. Nothing was written.`],
    ["an option on a legacy review", legacy, "accept", "A", "no-options", `Review "tides-r1" offers no options in the tracker, so none can be accepted; nothing was written.`],
    ["an option on a review without review metadata", (id: string) => shown({ id }), "accept", "A", "no-options", undefined],
    ["an option on a review whose card is invalid", card({ options: [{ id: "A", label: "only one" }], recommend: null }), "accept", "A", "no-options", undefined],
  ] as const)("refuses %s, writing and notifying nothing", async (_name, show, decision, option, reason, message) => {
    const { runBd, calls } = recordingRunner({ show });
    const herdr = recordingHerdr();
    const onWritten = vi.fn();
    const err = await createReviewWriter({ runBd, runHerdr: herdr.runHerdr })
      .write({ ...BASE, decision, message: decision === "changes" ? "fix" : "", ...(option !== undefined ? { option } : {}), onWritten })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReviewRecordRefusedError);
    expect((err as ReviewRecordRefusedError).reason).toBe(reason);
    if (message !== undefined) expect((err as Error).message).toBe(message);
    expect(calls.map((c) => c.args[0])).toEqual(["show"]);
    expect(onWritten).not.toHaveBeenCalled();
    expect(herdr.calls).toEqual([]);
  });

  it("the store cannot add an option: only the tracker record's options count", async () => {
    // The record is legacy; whatever the request believes the card offers, there is nothing to choose.
    const { runBd, writes } = recordingRunner({ show: legacy });
    await expect(createReviewWriter({ runBd, runHerdr: recordingHerdr().runHerdr }).write({ ...BASE, decision: "accept", message: "", option: "B" })).rejects.toMatchObject({ reason: "no-options" });
    expect(writes()).toEqual([]);
  });

  it.each([
    ["a legacy review", legacy],
    ["an invalid review (decided the legacy way)", card({ options: "A,B" })],
    ["a card whose options list is empty (read as absent)", card({ options: [], recommend: "" })],
    ["a question-only card", card({ options: undefined, recommend: undefined })],
  ])("%s: accept and changes without an option write exactly today's texts", async (_name, show) => {
    const accept = recordingRunner({ show });
    const herdr = recordingHerdr();
    await createReviewWriter({ runBd: accept.runBd, runHerdr: herdr.runHerdr }).write({ ...BASE, decision: "accept", message: "" });
    expect(accept.writes().map((c) => c.args)).toEqual([
      ["comments", "add", "tides-r1", "Accepted."],
      ["update", "tides-r1", "--remove-label", "review:changes"],
      ["close", "tides-r1", "--reason", "Review accepted"],
    ]);
    const changes = recordingRunner({ show });
    await createReviewWriter({ runBd: changes.runBd, runHerdr: herdr.runHerdr }).write({ ...BASE, decision: "changes", message: "tighten" });
    expect(changes.writes().map((c) => c.args)).toEqual([
      ["comments", "add", "tides-r1", "Changes requested: tighten"],
      ["update", "tides-r1", "--add-label", "review:changes"],
    ]);
    expect(herdr.calls).toEqual([
      ["agent", "prompt", "w1:p2", "Review tides-r1 accepted."],
      ["agent", "prompt", "w1:p2", "Review tides-r1 changes requested: tighten"],
    ]);
  });

  it("a card's changes request needs no option", async () => {
    const { runBd, writes } = recordingRunner({ show: card() });
    await createReviewWriter({ runBd, runHerdr: recordingHerdr().runHerdr }).write({ ...BASE, decision: "changes", message: "none of these" });
    expect(writes()[0]!.args).toEqual(["comments", "add", "tides-r1", "Changes requested: none of these"]);
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
  const SOCK = "/tmp/herdr-test/h.sock";

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "review-herdr-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("passes argv verbatim with no shell, sets HERDR_SOCKET_PATH, inherits the rest, and resolves on exit 0", async () => {
    const log = path.join(dir, "argv.log");
    const echo = stub("echo-herdr", `printf '%s|' "$@" > '${log}'; echo "socket=$HERDR_SOCKET_PATH home=$HOME" >> '${log}'; echo '{"ok":true}'`);
    await expect(createHerdrRunner({ command: echo })(ARGS, SOCK)).resolves.toBeUndefined();
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(log, "utf8")).toBe(`agent|prompt|w1:p2|${PROMPT}|socket=${SOCK} home=${process.env["HOME"]}\n`);
  });

  it("reduces herdr's JSON error to its message and code", async () => {
    const gone = stub("gone-herdr", `echo '{"error":{"code":"agent_not_found","message":"agent target w1:p2 not found"},"id":"cli:agent:prompt"}' >&2; exit 1`);
    await expect(createHerdrRunner({ command: gone })(ARGS, SOCK)).rejects.toThrow(/^agent target w1:p2 not found \(agent_not_found\)$/);
  });

  it("never echoes the prompt back, even when herdr does", async () => {
    const echoing = stub("echoing-herdr", `printf 'refused: %s\\n' "$4" >&2; exit 2`);
    const err = (await createHerdrRunner({ command: echoing })(["agent", "prompt", "w1:p2", "Review x-1 accepted: secret-message"], SOCK).catch((e: unknown) => e)) as Error;
    expect(err.message).toBe("refused: …");
    expect(err.message).not.toContain("secret-message");
    // A multi-line prompt: herdr's first line carries only the prompt's first line.
    const multi = (await createHerdrRunner({ command: echoing })(["agent", "prompt", "w1:p2", "Review x-1 changes requested: first secret line\nsecond line"], SOCK).catch((e: unknown) => e)) as Error;
    expect(multi.message).toBe("refused: …");
    // Lines are matched trimmed: herdr printing the second line without its indentation is still cut.
    const lineTwo = stub("line-two-herdr", `echo 'refused: second secret line' >&2; exit 2`);
    const indented = (await createHerdrRunner({ command: lineTwo })(["agent", "prompt", "w1:p2", "Review x-1 changes requested: a\n   second secret line   "], SOCK).catch((e: unknown) => e)) as Error;
    expect(indented.message).toBe("refused: …");
  });

  it("scrubs only herdr's own text, never the runner's fixed reasons", async () => {
    const quiet = stub("quiet-herdr-2", "exit 3");
    await expect(createHerdrRunner({ command: quiet })(["agent", "prompt", "w1:p2", "herdr exited 3"], SOCK)).rejects.toThrow(/^herdr exited 3$/);
  });

  it("names the exit code when herdr says nothing", async () => {
    const quiet = stub("quiet-herdr", "exit 3");
    await expect(createHerdrRunner({ command: quiet })(ARGS, SOCK)).rejects.toThrow(/^herdr exited 3$/);
  });

  it("says herdr is not on PATH when the executable is missing", async () => {
    await expect(createHerdrRunner({ command: path.join(dir, "missing-herdr") })(ARGS, SOCK)).rejects.toThrow(/^herdr not found on PATH$/);
  });

  it("times out with SIGTERM", async () => {
    const sleeper = stub("sleep-herdr", "exec sleep 10");
    const started = Date.now();
    await expect(createHerdrRunner({ command: sleeper, timeoutMs: 200, killGraceMs: 5_000 })(ARGS, SOCK)).rejects.toThrow(/^herdr timed out after 0\.2 s; the agent may have been notified$/);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("SIGKILLs a herdr that ignores SIGTERM after the grace period", async () => {
    const stubborn = stub("stubborn-herdr", "trap '' TERM\nexec sleep 10");
    const started = Date.now();
    await expect(createHerdrRunner({ command: stubborn, timeoutMs: 200, killGraceMs: 300 })(ARGS, SOCK)).rejects.toThrow(/^herdr timed out after 0\.2 s; the agent may have been notified$/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(450);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("defaults to a 10 s timeout", () => {
    expect(REVIEW_HERDR_TIMEOUT_MS).toBe(10_000);
  });
});
