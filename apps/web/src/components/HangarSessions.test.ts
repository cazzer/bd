// @vitest-environment jsdom
//
// The drawer's hangar sessions section (hangar-release, tasks.md 1.4): left
// off with no sessions; Accept and Table only on an ended session without an
// outcome; both ask first, each with its own warning, and send only from the
// confirm button, which takes focus (Cancel gives it back to the opener); the
// mutation's arguments; a refusal shown on the row; and "Change to …" until
// hangar has released the session, which asks the same way. The tRPC client
// is mocked.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ACCEPT_WARNING, HangarSessions, TABLE_WARNING } from "./HangarSessions.js";

const trpcMock = vi.hoisted(() => ({ hangarSessions: { query: vi.fn() }, hangarSessionOutcome: { mutate: vi.fn() } }));
vi.mock("../trpc.js", () => ({ trpc: trpcMock }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const WORK_ITEM = "8b1e4c1d-2f3a-4b5c-8d9e-0a1b2c3d4e5f";
const NOW = "2026-11-14T09:00:00.000Z";

type State = "queued" | "claimed" | "running" | "stopped" | "failed";

function session(id: string, state: State, extra: Record<string, unknown> = {}) {
  return {
    id,
    state,
    flavor: "headless",
    repo: "cazzer/bd",
    outcome: null,
    outcomeAt: null,
    outcomeBy: null,
    released: false,
    diskHeld: state !== "queued",
    container: state === "queued" ? null : "c-12",
    host: state === "queued" ? null : "hangar-linux",
    failureReason: null,
    requeueReason: null,
    requestedAt: NOW,
    updatedAt: NOW,
    ...extra,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  trpcMock.hangarSessions.query.mockReset();
  trpcMock.hangarSessionOutcome.mutate.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

async function render(sessions: ReturnType<typeof session>[]): Promise<void> {
  trpcMock.hangarSessions.query.mockResolvedValue({ sessions, truncated: false });
  act(() => root.render(createElement(HangarSessions, { workItemId: WORK_ITEM, version: 0 })));
  await settle();
}

const row = (id: string): HTMLElement => {
  const el = container.querySelector<HTMLElement>(`[data-hangar-session="${id}"]`);
  if (el === null) throw new Error(`no row for ${id}`);
  return el;
};
const buttons = (el: ParentNode): string[] => [...el.querySelectorAll("button")].map((b) => b.textContent ?? "");
const button = (el: ParentNode, label: string): HTMLButtonElement => {
  const found = [...el.querySelectorAll("button")].find((b) => b.textContent === label);
  if (!found) throw new Error(`no button ${label}; have ${buttons(el).join(", ")}`);
  return found;
};
async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click();
  });
  await settle();
}

describe("HangarSessions", () => {
  test("is left off when the item has no sessions", async () => {
    await render([]);
    expect(trpcMock.hangarSessions.query).toHaveBeenCalledWith({ workItemId: WORK_ITEM });
    expect(container.innerHTML).toBe("");
  });

  test("offers Accept and Table only on ended sessions without an outcome", async () => {
    await render([
      session("s-queued", "queued"),
      session("s-running", "running"),
      session("s-stopped", "stopped"),
      session("s-failed", "failed", { failureReason: "git clone exited 128" }),
      session("s-decided", "stopped", { outcome: "accepted", outcomeAt: NOW, outcomeBy: "human" }),
      session("s-released", "stopped", { outcome: "tabled", outcomeAt: NOW, outcomeBy: "human", released: true, diskHeld: false, container: null }),
    ]);
    expect(container.querySelector("h3")?.textContent).toBe("Hangar sessions");
    expect(buttons(row("s-queued"))).toEqual([]);
    expect(buttons(row("s-running"))).toEqual([]);
    expect(buttons(row("s-stopped"))).toEqual(["Accept", "Table"]);
    expect(buttons(row("s-failed"))).toEqual(["Accept", "Table"]);
    expect(row("s-failed").querySelector("[data-failure-reason]")?.textContent).toBe("Failed: git clone exited 128");
    expect(row("s-stopped").querySelector("[data-session-state]")?.textContent).toBe("stopped");

    // Decided but still holding its disk: changeable, and says so.
    expect(buttons(row("s-decided"))).toEqual(["Change to tabled"]);
    expect(row("s-decided").querySelector("[data-session-release]")?.textContent).toBe("disk held");
    // Released: nothing left to change.
    expect(buttons(row("s-released"))).toEqual([]);
    expect(row("s-released").querySelector("[data-session-release]")?.textContent).toBe("released");
    expect(row("s-released").querySelector("[data-session-outcome]")?.textContent).toContain("Tabled");

    // Phone-sized hit targets.
    for (const b of row("s-stopped").querySelectorAll("button")) expect(b.className).toContain("min-h-11");
  });

  test("Accept asks first too, says the disk is deleted, and sends with the session's id from its confirm button", async () => {
    await render([session("s-1", "stopped")]);
    await click(button(row("s-1"), "Accept"));
    expect(trpcMock.hangarSessionOutcome.mutate).not.toHaveBeenCalled();
    expect(row("s-1").textContent).toContain(ACCEPT_WARNING);
    expect(ACCEPT_WARNING).toContain("deletes its disk");
    expect(row("s-1").querySelector('[role="group"]')?.getAttribute("aria-label")).toBe("Confirm accepting");
    expect(buttons(row("s-1"))).toEqual(["Accept session", "Cancel"]);
    expect(document.activeElement).toBe(button(row("s-1"), "Accept session"));

    trpcMock.hangarSessionOutcome.mutate.mockResolvedValue({ id: "s-1", state: "stopped", outcome: "accepted", outcomeAt: NOW, outcomeBy: "human", released: false, changed: true });
    trpcMock.hangarSessions.query.mockResolvedValue({ sessions: [session("s-1", "stopped", { outcome: "accepted", outcomeAt: NOW, outcomeBy: "human" })], truncated: false });
    await click(button(row("s-1"), "Accept session"));
    expect(trpcMock.hangarSessionOutcome.mutate).toHaveBeenCalledTimes(1);
    expect(trpcMock.hangarSessionOutcome.mutate).toHaveBeenCalledWith({ id: "s-1", outcome: "accepted" });
    expect(row("s-1").querySelector("[data-session-outcome]")?.getAttribute("data-session-outcome")).toBe("accepted");
    expect(buttons(row("s-1"))).toEqual(["Change to tabled"]);
    // The list is read again after the write.
    expect(trpcMock.hangarSessions.query).toHaveBeenCalledTimes(2);
  });

  test("Table asks first, and sends only from its confirm button", async () => {
    await render([session("s-1", "stopped")]);
    await click(button(row("s-1"), "Table"));
    expect(trpcMock.hangarSessionOutcome.mutate).not.toHaveBeenCalled();
    expect(row("s-1").textContent).toContain(TABLE_WARNING);
    expect(buttons(row("s-1"))).toEqual(["Table session", "Cancel"]);
    expect(document.activeElement).toBe(button(row("s-1"), "Table session"));

    await click(button(row("s-1"), "Cancel"));
    expect(trpcMock.hangarSessionOutcome.mutate).not.toHaveBeenCalled();
    expect(row("s-1").textContent).not.toContain(TABLE_WARNING);
    // Focus goes back to the button that opened the confirmation.
    expect(document.activeElement).toBe(button(row("s-1"), "Table"));

    trpcMock.hangarSessionOutcome.mutate.mockResolvedValue({ id: "s-1", state: "stopped", outcome: "tabled", outcomeAt: NOW, outcomeBy: "human", released: false, changed: true });
    trpcMock.hangarSessions.query.mockResolvedValue({ sessions: [session("s-1", "stopped", { outcome: "tabled", outcomeAt: NOW, outcomeBy: "human" })], truncated: false });
    await click(button(row("s-1"), "Table"));
    await click(button(row("s-1"), "Table session"));
    expect(trpcMock.hangarSessionOutcome.mutate).toHaveBeenCalledTimes(1);
    expect(trpcMock.hangarSessionOutcome.mutate).toHaveBeenCalledWith({ id: "s-1", outcome: "tabled" });
    expect(row("s-1").querySelector("[data-session-outcome]")?.textContent).toContain("Tabled");
    expect(buttons(row("s-1"))).toEqual(["Change to accepted"]);
  });

  test("changing an accepted session to tabled asks the same way", async () => {
    await render([session("s-1", "stopped", { outcome: "accepted", outcomeAt: NOW, outcomeBy: "human" })]);
    await click(button(row("s-1"), "Change to tabled"));
    expect(trpcMock.hangarSessionOutcome.mutate).not.toHaveBeenCalled();
    expect(row("s-1").textContent).toContain(TABLE_WARNING);
    trpcMock.hangarSessionOutcome.mutate.mockResolvedValue({ id: "s-1", state: "stopped", outcome: "tabled", outcomeAt: NOW, outcomeBy: "human", released: false, changed: true });
    await click(button(row("s-1"), "Table session"));
    expect(trpcMock.hangarSessionOutcome.mutate).toHaveBeenCalledWith({ id: "s-1", outcome: "tabled" });
  });

  test("changing a tabled session to accepted asks with the accept warning, and Cancel restores focus", async () => {
    await render([session("s-1", "stopped", { outcome: "tabled", outcomeAt: NOW, outcomeBy: "human" })]);
    await click(button(row("s-1"), "Change to accepted"));
    expect(trpcMock.hangarSessionOutcome.mutate).not.toHaveBeenCalled();
    expect(row("s-1").textContent).toContain(ACCEPT_WARNING);
    expect(document.activeElement).toBe(button(row("s-1"), "Accept session"));
    await click(button(row("s-1"), "Cancel"));
    expect(document.activeElement).toBe(button(row("s-1"), "Change to accepted"));

    trpcMock.hangarSessionOutcome.mutate.mockResolvedValue({ id: "s-1", state: "stopped", outcome: "accepted", outcomeAt: NOW, outcomeBy: "human", released: false, changed: true });
    await click(button(row("s-1"), "Change to accepted"));
    await click(button(row("s-1"), "Accept session"));
    expect(trpcMock.hangarSessionOutcome.mutate).toHaveBeenCalledWith({ id: "s-1", outcome: "accepted" });
  });

  test("shows a refusal on the row in the server's words", async () => {
    await render([session("s-1", "stopped")]);
    const refused = Object.assign(new Error("This session is already released: hangar has removed its disk, so the outcome can't change."), { data: { code: "CONFLICT", httpStatus: 409 } });
    trpcMock.hangarSessionOutcome.mutate.mockRejectedValue(refused);
    await click(button(row("s-1"), "Accept"));
    await click(button(row("s-1"), "Accept session"));
    expect(row("s-1").querySelector('[role="alert"]')?.textContent).toBe(refused.message);
    expect(row("s-1").querySelector("[data-session-outcome]")).toBeNull();
  });
});
