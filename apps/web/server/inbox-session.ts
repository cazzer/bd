// "Open session" for an inbox item: the person wants to go deep on
// something (an RFP, a gnarly PR) in a real interactive Claude session
// instead of deciding it in the queue. The server asks herdr for a new tab
// in the "inbox" workspace, starts Claude there, and hands it the item.
//
// This is not a model call: the server starts the person's own terminal
// agent in their own herdr session, the same way the review and inbox
// notifications already type into a live pane. What the session does is
// between the person and that session; it reports back through `inbox
// request` (a draft for approval) or `inbox done`.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

/** Runs one herdr command against a server socket and returns its parsed JSON `result`. */
export type RunHerdrJson = (args: readonly string[], socket: string, timeoutMs?: number) => Promise<Record<string, unknown>>;

const DEFAULT_TIMEOUT_MS = 15_000;
/** `agent start` waits until Claude is ready for input; herdr's own default is 30 s. */
export const AGENT_START_TIMEOUT_MS = 45_000;
export const SESSION_WORKSPACE_LABEL = "inbox";
const SHELL_READY_ATTEMPTS = 20;
const SHELL_READY_DELAY_MS = 500;

function herdrError(stderr: string, stdout: string): string | null {
  for (const text of [stderr, stdout]) {
    for (const line of text.split("\n").reverse()) {
      try {
        const parsed = JSON.parse(line) as { error?: { message?: unknown; code?: unknown } };
        const message = parsed.error?.message;
        if (typeof message === "string" && message.trim() !== "") return message.trim();
      } catch {
        // not JSON
      }
    }
  }
  const said = stderr.trim();
  return said === "" ? null : said.slice(0, 300);
}

export function createHerdrJsonRunner(command = "herdr"): RunHerdrJson {
  return (args, socket, timeoutMs = DEFAULT_TIMEOUT_MS) =>
    new Promise((resolve, reject) => {
      execFile(command, [...args], { env: { ...process.env, HERDR_SOCKET_PATH: socket }, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" }, (err, stdout, stderr) => {
        if (err) {
          const e = err as NodeJS.ErrnoException & { killed?: boolean };
          if (e.code === "ENOENT") return reject(new Error("herdr not found on PATH"));
          if (e.killed) return reject(new Error(`herdr ${args[0]} ${args[1] ?? ""} timed out`));
          return reject(new Error(herdrError(stderr, stdout) ?? `herdr ${args[0]} ${args[1] ?? ""} failed`));
        }
        try {
          const parsed = JSON.parse(stdout) as { result?: unknown };
          resolve(typeof parsed.result === "object" && parsed.result !== null ? (parsed.result as Record<string, unknown>) : {});
        } catch {
          resolve({});
        }
      });
    });
}

/** The herdr server socket: the one the web server was started under, else herdr's default path when it exists. */
export function resolveHerdrSocket(env: NodeJS.ProcessEnv = process.env, home = homedir()): string | null {
  const fromEnv = env["HERDR_SOCKET_PATH"];
  if (typeof fromEnv === "string" && path.isAbsolute(fromEnv)) return fromEnv;
  const fallback = path.join(home, ".config", "herdr", "herdr.sock");
  return existsSync(fallback) ? fallback : null;
}

/** Where sessions start: the directory holding the breakdown checkout (where a person keeps their repos), else home. */
export function resolveSessionCwd(start = process.cwd(), home = homedir()): string {
  let dir = start;
  for (;;) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return path.dirname(dir);
    const up = path.dirname(dir);
    if (up === dir) return home;
    dir = up;
  }
}

export interface SessionItem {
  id: string;
  externalId: string;
  title: string;
  content: string;
  source: string;
  action: string;
  url: string | null;
  links: { label: string; url: string }[];
}

/** The first prompt the new session gets: the item, and how to hand it back. */
export function sessionPromptText(item: SessionItem): string {
  const sources = [...(item.url !== null && !item.links.some((l) => l.url === item.url) ? [{ label: "Primary", url: item.url }] : []), ...item.links];
  return [
    `[inbox] I opened this inbox item to go deep on it with you: "${item.title}"`,
    `(inbox id ${item.id}, key ${item.externalId}, source ${item.source}, proposed action ${item.action})`,
    "",
    item.content.trim(),
    "",
    ...(sources.length > 0 ? ["Sources:", ...sources.map((l) => `- ${l.label}: ${l.url}`), ""] : []),
    "Start by reading the sources and telling me what you see and what you'd do. Then work it through with me.",
    `When there's a draft for my approval, queue it back with the inbox-queue skill: \`inbox request --key ${item.externalId} --title "<title>" --source ${item.source} --action <reply|create_task|comment|review|update|decide>\` with the draft on stdin. My decision will come back to this session.`,
    `If we finish the work right here instead, close the item: \`inbox done ${item.id} "<what was done, with link>"\`.`,
  ].join("\n");
}

function tabLabel(title: string): string {
  const t = title.replace(/\s+/g, " ").trim();
  return t.length > 28 ? `${t.slice(0, 27)}…` : t || "inbox item";
}

function str(value: unknown, at: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`herdr returned no ${at}`);
  return value;
}

function obj(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

export interface OpenedSession {
  workspace: string;
  tab: string;
  pane: string;
  agent: string;
}

/**
 * Opens a tab for the item in the "inbox" workspace (creating the workspace
 * the first time), starts Claude in it, gives it the item, and focuses it.
 */
export async function openInboxSession(run: RunHerdrJson, socket: string, item: SessionItem, options: { cwd: string; kind?: string; retryDelayMs?: number }): Promise<OpenedSession> {
  const listed = await run(["workspace", "list"], socket);
  const workspaces = Array.isArray(listed["workspaces"]) ? (listed["workspaces"] as Record<string, unknown>[]) : [];
  const existing = workspaces.find((w) => w["label"] === SESSION_WORKSPACE_LABEL);

  let workspace: string;
  let tab: string;
  let pane: string;
  if (existing === undefined) {
    const created = await run(["workspace", "create", "--label", SESSION_WORKSPACE_LABEL, "--cwd", options.cwd, "--focus"], socket);
    workspace = str(obj(created["workspace"])["workspace_id"], "workspace id");
    tab = str(obj(created["tab"])["tab_id"], "tab id");
    pane = str(obj(created["root_pane"])["pane_id"], "pane id");
    await run(["tab", "rename", tab, tabLabel(item.title)], socket).catch(() => {});
  } else {
    workspace = str(existing["workspace_id"], "workspace id");
    const created = await run(["tab", "create", "--workspace", workspace, "--cwd", options.cwd, "--label", tabLabel(item.title), "--focus"], socket);
    tab = str(obj(created["tab"])["tab_id"], "tab id");
    pane = str(obj(created["root_pane"])["pane_id"], "pane id");
  }

  const agent = `inbox-${item.id.slice(0, 8)}-${randomBytes(2).toString("hex")}`;
  try {
    // A fresh tab's shell takes a moment to reach its prompt; herdr refuses
    // to start an agent in it until then ("not an available shell").
    for (let attempt = 1; ; attempt++) {
      try {
        await run(["agent", "start", agent, "--kind", options.kind ?? "claude", "--pane", pane], socket, AGENT_START_TIMEOUT_MS);
        break;
      } catch (err) {
        if (attempt >= SHELL_READY_ATTEMPTS || !(err instanceof Error && /not an available shell/i.test(err.message))) throw err;
        await new Promise((r) => setTimeout(r, options.retryDelayMs ?? SHELL_READY_DELAY_MS));
      }
    }
    await run(["agent", "prompt", pane, sessionPromptText(item)], socket);
  } catch (err) {
    await run(["tab", "close", tab], socket).catch(() => {});
    throw err;
  }
  await run(["tab", "focus", tab], socket).catch(() => {});
  return { workspace, tab, pane, agent };
}
