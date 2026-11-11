import { mkdtempSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { focusPane, openAgentSession, resolveHerdrSocket, tabLabel, type RunHerdrJson } from "./herdr-session.js";

const promptDir = mkdtempSync(path.join(tmpdir(), "herdr-prompts-"));
const input = { promptDir, workspaceLabel: "reviews", title: "bd-4zn.2 Review the storage migration options", cwd: "/repo", prompt: "think with me", namePrefix: "review-bd-4zn-2", retryDelayMs: 1 };

function fakeHerdr(workspaces: Record<string, unknown>[], fail?: (args: readonly string[]) => Error | undefined) {
  const calls: string[][] = [];
  const run: RunHerdrJson = async (args) => {
    calls.push([...args]);
    const failure = fail?.(args);
    if (failure) throw failure;
    const [group, verb] = args;
    if (group === "workspace" && verb === "list") return { workspaces };
    if (group === "workspace" && verb === "create") return { workspace: { workspace_id: "w9" }, tab: { tab_id: "w9:t1" }, root_pane: { pane_id: "w9:p1" } };
    if (group === "tab" && verb === "create") return { tab: { tab_id: "w9:t2" }, root_pane: { pane_id: "w9:p2" } };
    if (group === "pane" && verb === "get") return { pane: { tab_id: "w3:t4" } };
    return {};
  };
  return { run, calls };
}

describe("openAgentSession", () => {
  it("creates the workspace the first time, starts the agent, prompts it, and focuses the tab", async () => {
    const { run, calls } = fakeHerdr([{ workspace_id: "w1", label: "dev" }]);
    expect(await openAgentSession(run, "/s", input)).toMatchObject({ workspace: "w9", tab: "w9:t1", pane: "w9:p1" });
    expect(calls[1]).toEqual(["workspace", "create", "--label", "reviews", "--cwd", "/repo", "--focus"]);
    const start = calls.find((c) => c[1] === "start")!;
    expect(start[2]).toMatch(/^review-bd-4zn-2-[0-9a-f]{4}$/);
    // Claude gets the prompt as a one-line startup argument pointing at a private file, so a trust question can't swallow it.
    expect(start.slice(3, 8)).toEqual(["--kind", "claude", "--pane", "w9:p1", "--"]);
    const file = /^Read (\S+) and do what it says\.$/.exec(start[8]!)![1]!;
    expect(file.startsWith(promptDir)).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("think with me");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(calls.some((c) => c[1] === "prompt")).toBe(false);
    expect(calls.at(-1)).toEqual(["tab", "focus", "w9:t1"]);
  });

  it("adds a labelled tab to an existing workspace", async () => {
    const { run, calls } = fakeHerdr([{ workspace_id: "w4", label: "reviews" }]);
    expect(await openAgentSession(run, "/s", input)).toMatchObject({ workspace: "w4", tab: "w9:t2", pane: "w9:p2" });
    expect(calls[1]).toEqual(["tab", "create", "--workspace", "w4", "--cwd", "/repo", "--label", "bd-4zn.2 Review the storage…", "--focus"]);
  });

  it("waits for the new tab's shell", async () => {
    let refusals = 2;
    const { run, calls } = fakeHerdr([{ workspace_id: "w4", label: "reviews" }], (a) => (a[1] === "start" && refusals-- > 0 ? new Error("agent target pane w9:p2 is not an available shell") : undefined));
    await openAgentSession(run, "/s", input);
    expect(calls.filter((c) => c[1] === "start")).toHaveLength(3);
  });

  it("closes the tab it made when the agent can't start", async () => {
    const promptsBefore = readdirSync(promptDir).length;
    const { run, calls } = fakeHerdr([{ workspace_id: "w4", label: "reviews" }], (a) => (a[1] === "start" ? new Error("unknown agent kind") : undefined));
    await expect(openAgentSession(run, "/s", input)).rejects.toThrow("unknown agent kind");
    expect(calls.at(-1)).toEqual(["tab", "close", "w9:t2"]);
    expect(readdirSync(promptDir).filter((f) => f.startsWith("prompt-"))).toHaveLength(promptsBefore);
  });
});

describe("other agent kinds", () => {
  it("types the prompt once the agent is ready", async () => {
    const { run, calls } = fakeHerdr([{ workspace_id: "w4", label: "reviews" }]);
    await openAgentSession(run, "/s", { ...input, kind: "codex" });
    expect(calls.find((c) => c[1] === "start")!.slice(3)).toEqual(["--kind", "codex", "--pane", "w9:p2"]);
    expect(calls.find((c) => c[1] === "prompt")).toEqual(["agent", "prompt", "w9:p2", "think with me"]);
  });
});

describe("focusPane and labels", () => {
  it("focuses the pane's tab", async () => {
    const { run, calls } = fakeHerdr([]);
    expect(await focusPane(run, "/s", "w3:p7")).toEqual({ tab: "w3:t4" });
    expect(calls).toEqual([["pane", "get", "w3:p7"], ["tab", "focus", "w3:t4"]]);
  });

  it("keeps a tab label to one short line", () => {
    expect(tabLabel("  a\nb  ")).toBe("a b");
    expect(tabLabel("")).toBe("session");
  });
});

describe("resolveHerdrSocket", () => {
  it("prefers HERDR_SOCKET_PATH, falls back to herdr's default socket, else null", () => {
    const home = mkdtempSync(path.join(tmpdir(), "herdr-session-"));
    expect(resolveHerdrSocket({ HERDR_SOCKET_PATH: "/run/h.sock" }, home)).toBe("/run/h.sock");
    expect(resolveHerdrSocket({}, home)).toBeNull();
    mkdirSync(path.join(home, ".config", "herdr"), { recursive: true });
    writeFileSync(path.join(home, ".config", "herdr", "herdr.sock"), "");
    expect(resolveHerdrSocket({ HERDR_SOCKET_PATH: "relative" }, home)).toBe(path.join(home, ".config", "herdr", "herdr.sock"));
  });
});
