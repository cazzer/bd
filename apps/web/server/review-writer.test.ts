// review-writer tests (board-visual-reviews 3.3): no database, no real `bd`.
// A fake runner records every (args, cwd) it is handed, so each test proves
// the exact argv the tracker would see.

import { describe, expect, it } from "vitest";
import { commentText, createReviewWriter, ReviewDecisionInFlightError, type RunBd } from "./review-writer.js";

const CWD = "/checkouts/tides";
const BASE = { project: "tides", cwd: CWD, externalId: "tides-r1" } as const;

function recordingRunner(fail?: (args: readonly string[]) => Error | undefined) {
  const calls: Array<{ args: string[]; cwd: string }> = [];
  const runBd: RunBd = async (args, cwd) => {
    calls.push({ args: [...args], cwd });
    const err = fail?.(args);
    if (err) throw err;
    return "";
  };
  return { runBd, calls };
}

describe("commentText", () => {
  it("prefixes every decision so the argv element never starts with '-'", () => {
    expect(commentText("accept", "looks right")).toBe("Accepted: looks right");
    expect(commentText("accept", "   ")).toBe("Accepted.");
    expect(commentText("changes", "--force")).toBe("Changes requested: --force");
  });
});

describe("review writer", () => {
  it("accept: comment, close, then remove review:changes, all in the checkout", async () => {
    const { runBd, calls } = recordingRunner();
    const result = await createReviewWriter({ runBd }).write({ ...BASE, decision: "accept", message: "looks right" });

    expect(result).toEqual({ ok: true, written: ["comment", "close", "remove-changes-label"] });
    expect(calls).toEqual([
      { args: ["comments", "add", "tides-r1", "Accepted: looks right"], cwd: CWD },
      { args: ["close", "tides-r1", "--reason", "Review accepted"], cwd: CWD },
      { args: ["update", "tides-r1", "--remove-label", "review:changes"], cwd: CWD },
    ]);
  });

  it("accept with an empty message writes 'Accepted.'", async () => {
    const { runBd, calls } = recordingRunner();
    await createReviewWriter({ runBd }).write({ ...BASE, decision: "accept", message: "" });
    expect(calls[0]!.args).toEqual(["comments", "add", "tides-r1", "Accepted."]);
  });

  it("changes: comment, then add review:changes; the bead is not closed", async () => {
    const { runBd, calls } = recordingRunner();
    const result = await createReviewWriter({ runBd }).write({ ...BASE, decision: "changes", message: "header overlaps on narrow widths" });

    expect(result).toEqual({ ok: true, written: ["comment", "add-changes-label"] });
    expect(calls).toEqual([
      { args: ["comments", "add", "tides-r1", "Changes requested: header overlaps on narrow widths"], cwd: CWD },
      { args: ["update", "tides-r1", "--add-label", "review:changes"], cwd: CWD },
    ]);
  });

  it.each([`"; rm -rf ~ #`, "$(x)", "line one\nline two", "`id` && echo pwned | tee /tmp/x"])("passes %j to bd as one argv element, verbatim", async (message) => {
    const { runBd, calls } = recordingRunner();
    await createReviewWriter({ runBd }).write({ ...BASE, decision: "changes", message });
    expect(calls[0]!.args).toEqual(["comments", "add", "tides-r1", `Changes requested: ${message}`]);
  });

  it("a failing close after the comment is a partial write naming what ran", async () => {
    const { runBd, calls } = recordingRunner((args) => (args[0] === "close" ? new Error("bd close failed: database is locked") : undefined));
    const result = await createReviewWriter({ runBd }).write({ ...BASE, decision: "accept", message: "ok" });

    expect(result).toEqual({ ok: false, written: ["comment"], error: "bd close failed: database is locked", partial: true });
    expect(calls).toHaveLength(2);
  });

  it("a failing comment writes nothing and is not partial", async () => {
    const { runBd, calls } = recordingRunner((args) => (args[0] === "comments" ? new Error("bd comments failed: no issue found") : undefined));
    const result = await createReviewWriter({ runBd }).write({ ...BASE, decision: "changes", message: "fix it" });

    expect(result).toEqual({ ok: false, written: [], error: "bd comments failed: no issue found", partial: false });
    expect(calls).toHaveLength(1);
  });

  it("refuses a second decision on the same item while one is running, and allows it after", async () => {
    let release!: () => void;
    const calls: string[][] = [];
    const runBd: RunBd = (args) => {
      calls.push([...args]);
      if (calls.length === 1) return new Promise((resolve) => (release = () => resolve("")));
      return Promise.resolve("");
    };
    const writer = createReviewWriter({ runBd });

    const first = writer.write({ ...BASE, decision: "accept", message: "" });
    await expect(writer.write({ ...BASE, decision: "changes", message: "no" })).rejects.toBeInstanceOf(ReviewDecisionInFlightError);
    // Another item, or the same id in another project, is not blocked.
    await expect(writer.write({ ...BASE, externalId: "tides-r2", decision: "accept", message: "" })).resolves.toMatchObject({ ok: true });
    await expect(writer.write({ ...BASE, project: "other", decision: "accept", message: "" })).resolves.toMatchObject({ ok: true });

    release();
    await expect(first).resolves.toMatchObject({ ok: true });
    await expect(writer.write({ ...BASE, decision: "changes", message: "again" })).resolves.toMatchObject({ ok: true });
  });

  it("releases the in-flight claim after a failure", async () => {
    const { runBd } = recordingRunner(() => new Error("bd comments failed: boom"));
    const writer = createReviewWriter({ runBd });
    await writer.write({ ...BASE, decision: "accept", message: "" });
    await expect(writer.write({ ...BASE, decision: "accept", message: "" })).resolves.toMatchObject({ ok: false, written: [] });
  });
});
