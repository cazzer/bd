import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveHerdrSocket, type RunHerdrJson } from "./herdr-session.js";
import { openInboxSession, resolveSessionCwd, sessionPromptText, type SessionItem } from "./inbox-session.js";

const item: SessionItem = {
  id: "9d4b4417-590f-4624-9481-61de549bf20f",
  externalId: "gmail:thread/abc",
  title: "Review the Globex RFP security questionnaire before Friday",
  content: "**What happened:** the RFP landed.",
  source: "gmail",
  action: "decide",
  url: "https://mail.google.com/x",
  links: [{ label: "Email", url: "https://mail.google.com/y" }],
};

function fakeHerdr(workspaces: Record<string, unknown>[]) {
  const calls: string[][] = [];
  const run: RunHerdrJson = async (args) => {
    calls.push([...args]);
    const [group, verb] = args;
    if (group === "workspace" && verb === "list") return { workspaces };
    if (group === "workspace" && verb === "create") return { workspace: { workspace_id: "w9" }, tab: { tab_id: "w9:t1" }, root_pane: { pane_id: "w9:p1" } };
    if (group === "tab" && verb === "create") return { tab: { tab_id: "w9:t2" }, root_pane: { pane_id: "w9:p2" } };
    return {};
  };
  return { run, calls };
}

describe("openInboxSession", () => {
  it("creates the inbox workspace the first time, starts claude, prompts it, and focuses the tab", async () => {
    const { run, calls } = fakeHerdr([{ workspace_id: "w1", label: "dev" }]);
    const opened = await openInboxSession(run, "/tmp/herdr.sock", item, { cwd: "/Users/x/dev" });
    expect(opened).toMatchObject({ workspace: "w9", tab: "w9:t1", pane: "w9:p1" });
    expect(calls[1]).toEqual(["workspace", "create", "--label", "inbox", "--cwd", "/Users/x/dev", "--focus"]);
    const start = calls.find((c) => c[0] === "agent" && c[1] === "start")!;
    expect(start.slice(3, 7)).toEqual(["--kind", "claude", "--pane", "w9:p1"]);
    expect(start[2]).toMatch(/^inbox-9d4b4417-[0-9a-f]{4}$/);
    expect(start.at(-1)).toMatch(/^Read \S+ and do what it says\.$/);
    expect(calls.at(-1)).toEqual(["tab", "focus", "w9:t1"]);
  });

  it("adds a tab to an existing inbox workspace", async () => {
    const { run, calls } = fakeHerdr([{ workspace_id: "w4", label: "inbox" }]);
    const opened = await openInboxSession(run, "/tmp/herdr.sock", item, { cwd: "/Users/x/dev" });
    expect(opened).toMatchObject({ workspace: "w4", tab: "w9:t2", pane: "w9:p2" });
    expect(calls[1]).toEqual(["tab", "create", "--workspace", "w4", "--cwd", "/Users/x/dev", "--label", "Review the Globex RFP secur…", "--focus"]);
  });
});

describe("sessionPromptText", () => {
  it("carries the item, its sources, and both ways back", () => {
    const text = sessionPromptText(item);
    expect(text).toContain("the RFP landed");
    expect(text).toContain("- Primary: https://mail.google.com/x");
    expect(text).toContain("- Email: https://mail.google.com/y");
    expect(text).toContain("inbox request --key gmail:thread/abc");
    expect(text).toContain(`inbox done ${item.id}`);
  });
});

describe("resolving herdr and the session cwd", () => {
  it("prefers HERDR_SOCKET_PATH, falls back to herdr's default socket, else null", () => {
    const home = mkdtempSync(path.join(tmpdir(), "inbox-session-"));
    expect(resolveHerdrSocket({ HERDR_SOCKET_PATH: "/run/h.sock" }, home)).toBe("/run/h.sock");
    expect(resolveHerdrSocket({}, home)).toBeNull();
    mkdirSync(path.join(home, ".config", "herdr"), { recursive: true });
    writeFileSync(path.join(home, ".config", "herdr", "herdr.sock"), "");
    expect(resolveHerdrSocket({ HERDR_SOCKET_PATH: "relative" }, home)).toBe(path.join(home, ".config", "herdr", "herdr.sock"));
  });

  it("starts sessions in the directory holding the checkout", () => {
    const root = mkdtempSync(path.join(tmpdir(), "inbox-cwd-"));
    const repo = path.join(root, "breakdown");
    mkdirSync(path.join(repo, "apps", "web"), { recursive: true });
    writeFileSync(path.join(repo, "pnpm-workspace.yaml"), "");
    expect(resolveSessionCwd(path.join(repo, "apps", "web"), "/home/x")).toBe(root);
    expect(resolveSessionCwd(tmpdir(), "/home/x")).toBe("/home/x");
  });
});

describe("openInboxSession when the shell isn't ready or claude fails", () => {
  it("retries until the new tab's shell is available", async () => {
    const { run: base, calls } = fakeHerdr([{ workspace_id: "w4", label: "inbox" }]);
    let refusals = 2;
    const run: RunHerdrJson = async (args, socket) => {
      if (args[0] === "agent" && args[1] === "start" && refusals-- > 0) {
        calls.push([...args]);
        throw new Error("agent target pane w9:p2 is not an available shell");
      }
      return base(args, socket);
    };
    await openInboxSession(run, "/tmp/herdr.sock", item, { cwd: "/x", retryDelayMs: 1 });
    expect(calls.filter((c) => c[1] === "start")).toHaveLength(3);
  });

  it("closes the tab it made when claude can't start", async () => {
    const { run: base, calls } = fakeHerdr([{ workspace_id: "w4", label: "inbox" }]);
    const run: RunHerdrJson = async (args, socket) => {
      if (args[0] === "agent" && args[1] === "start") throw new Error("unknown agent kind");
      return base(args, socket);
    };
    await expect(openInboxSession(run, "/tmp/herdr.sock", item, { cwd: "/x", retryDelayMs: 1 })).rejects.toThrow(/unknown agent kind/);
    expect(calls.at(-1)).toEqual(["tab", "close", "w9:t2"]);
  });
});
