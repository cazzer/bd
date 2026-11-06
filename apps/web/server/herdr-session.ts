// Opening and focusing interactive agent sessions in herdr (review-sessions,
// design.md decisions 1–3). Some decisions are too deep for the drawer: the
// person wants to talk them through. The server asks herdr for a tab, starts
// the person's own terminal agent in it, and types the opening prompt; or it
// brings the requesting agent's pane to the front.
//
// No model call happens here. Like the review notification
// (review-writer.ts), the server only drives the person's herdr session:
// what the agent then does is between the person and that agent. Every
// command runs without a shell, with HERDR_SOCKET_PATH set to the socket
// the pane belongs to, and is bounded by a timeout.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** Runs one herdr command against a server socket and returns its JSON `result` (an empty object when there is none). */
export type RunHerdrJson = (args: readonly string[], socket: string, timeoutMs?: number) => Promise<Record<string, unknown>>;

export const HERDR_JSON_TIMEOUT_MS = 15_000;
/** `agent start` returns once the agent is ready for input; herdr's own default is 30 s. */
export const AGENT_START_TIMEOUT_MS = 45_000;
/** A fresh tab's shell takes a moment to reach its prompt; herdr refuses an agent until then. */
export const SHELL_READY_ATTEMPTS = 20;
export const SHELL_READY_DELAY_MS = 500;
const MAX_REASON_LENGTH = 300;

function herdrFailure(stderr: string, stdout: string): string | null {
  for (const text of [stderr, stdout]) {
    for (const line of text.split("\n").reverse()) {
      try {
        const parsed = JSON.parse(line) as { error?: { message?: unknown } };
        const message = parsed.error?.message;
        if (typeof message === "string" && message.trim() !== "") return message.trim();
      } catch {
        // not JSON
      }
    }
  }
  const said = stderr.trim();
  return said === "" ? null : said;
}

/** The default runner. Failure reasons never carry the prompt: herdr does not echo it, and only its error line is kept. */
export function createHerdrJsonRunner(command = "herdr"): RunHerdrJson {
  return (args, socket, timeoutMs = HERDR_JSON_TIMEOUT_MS) =>
    new Promise((resolve, reject) => {
      const verb = args.slice(0, 2).join(" ");
      execFile(command, [...args], { env: { ...process.env, HERDR_SOCKET_PATH: socket }, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" }, (err, stdout, stderr) => {
        if (err) {
          const e = err as NodeJS.ErrnoException & { killed?: boolean };
          if (e.code === "ENOENT") return reject(new Error("herdr not found on PATH"));
          if (e.killed) return reject(new Error(`herdr ${verb} timed out`));
          const reason = herdrFailure(stderr, stdout) ?? `herdr ${verb} failed`;
          return reject(new Error(reason.length > MAX_REASON_LENGTH ? `${reason.slice(0, MAX_REASON_LENGTH - 1)}…` : reason));
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

/** The herdr socket a new session uses: the server's own (started inside herdr), else herdr's default path when it exists. */
export function resolveHerdrSocket(env: NodeJS.ProcessEnv = process.env, home = homedir()): string | null {
  const fromEnv = env["HERDR_SOCKET_PATH"];
  if (typeof fromEnv === "string" && path.isAbsolute(fromEnv)) return fromEnv;
  const fallback = path.join(home, ".config", "herdr", "herdr.sock");
  return existsSync(fallback) ? fallback : null;
}

function obj(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function id(value: unknown, what: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`herdr returned no ${what}`);
  return value;
}

/** A tab label herdr shows in its sidebar: one line, at most 28 characters. */
export function tabLabel(title: string): string {
  const t = title.replace(/\s+/g, " ").trim();
  return t.length > 28 ? `${t.slice(0, 27)}…` : t || "session";
}

export interface OpenAgentSessionInput {
  /** The workspace the tab goes in, found by label and created the first time. */
  workspaceLabel: string;
  title: string;
  cwd: string;
  /** The first prompt the agent gets. */
  prompt: string;
  /** Agent name prefix; a short random suffix keeps names unique. */
  namePrefix: string;
  kind?: string;
  retryDelayMs?: number;
}

export interface OpenedSession {
  workspace: string;
  tab: string;
  pane: string;
  agent: string;
}

/**
 * Opens a focused tab in the named workspace, starts the agent in it, and
 * types the prompt. A tab whose agent cannot start or take the prompt is
 * closed again, so a failure leaves nothing behind but the workspace.
 */
export async function openAgentSession(run: RunHerdrJson, socket: string, input: OpenAgentSessionInput): Promise<OpenedSession> {
  const listed = await run(["workspace", "list"], socket);
  const workspaces = Array.isArray(listed["workspaces"]) ? (listed["workspaces"] as unknown[]).map(obj) : [];
  const existing = workspaces.find((w) => w["label"] === input.workspaceLabel);

  let workspace: string;
  let tab: string;
  let pane: string;
  if (existing === undefined) {
    const created = await run(["workspace", "create", "--label", input.workspaceLabel, "--cwd", input.cwd, "--focus"], socket);
    workspace = id(obj(created["workspace"])["workspace_id"], "workspace id");
    tab = id(obj(created["tab"])["tab_id"], "tab id");
    pane = id(obj(created["root_pane"])["pane_id"], "pane id");
    await run(["tab", "rename", tab, tabLabel(input.title)], socket).catch(() => {});
  } else {
    workspace = id(existing["workspace_id"], "workspace id");
    const created = await run(["tab", "create", "--workspace", workspace, "--cwd", input.cwd, "--label", tabLabel(input.title), "--focus"], socket);
    tab = id(obj(created["tab"])["tab_id"], "tab id");
    pane = id(obj(created["root_pane"])["pane_id"], "pane id");
  }

  const agent = `${input.namePrefix}-${randomBytes(2).toString("hex")}`;
  const kind = input.kind ?? "claude";
  // Claude takes the opening prompt as its startup argument. Typing it
  // instead races whatever Claude shows first: in a folder it has not been
  // told to trust, the trust question takes the prompt's Enter as "No,
  // exit". As an argument, the prompt waits behind that question.
  const startArgs = kind === "claude" ? ["--", input.prompt] : [];
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        await run(["agent", "start", agent, "--kind", kind, "--pane", pane, ...startArgs], socket, AGENT_START_TIMEOUT_MS);
        break;
      } catch (err) {
        if (attempt >= SHELL_READY_ATTEMPTS || !(err instanceof Error && /not an available shell/i.test(err.message))) throw err;
        await new Promise((r) => setTimeout(r, input.retryDelayMs ?? SHELL_READY_DELAY_MS));
      }
    }
    if (startArgs.length === 0) await run(["agent", "prompt", pane, input.prompt], socket);
  } catch (err) {
    await run(["tab", "close", tab], socket).catch(() => {});
    throw err;
  }
  await run(["tab", "focus", tab], socket).catch(() => {});
  return { workspace, tab, pane, agent };
}

/** Brings a pane's tab to the front. Throws herdr's reason when the pane is gone. */
export async function focusPane(run: RunHerdrJson, socket: string, pane: string): Promise<{ tab: string }> {
  const got = await run(["pane", "get", pane], socket);
  const tab = id(obj(got["pane"])["tab_id"], "tab id");
  await run(["tab", "focus", tab], socket);
  return { tab };
}
