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

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { openAgentSession, type OpenedSession, type RunHerdrJson } from "./herdr-session.js";

export const SESSION_WORKSPACE_LABEL = "inbox";

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

/**
 * Opens a tab for the item in the "inbox" workspace (created the first
 * time), starts Claude in it, gives it the item, and focuses it
 * (herdr-session.ts does the herdr side).
 */
export async function openInboxSession(run: RunHerdrJson, socket: string, item: SessionItem, options: { cwd: string; kind?: string; retryDelayMs?: number }): Promise<OpenedSession> {
  return openAgentSession(run, socket, {
    workspaceLabel: SESSION_WORKSPACE_LABEL,
    title: item.title,
    cwd: options.cwd,
    prompt: sessionPromptText(item),
    namePrefix: `inbox-${item.id.slice(0, 8)}`,
    ...(options.kind !== undefined ? { kind: options.kind } : {}),
    ...(options.retryDelayMs !== undefined ? { retryDelayMs: options.retryDelayMs } : {}),
  });
}
