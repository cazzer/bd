// @vitest-environment jsdom
//
// The drawer's hangar sessions section (hangar-release, tasks.md 1.4): left
// off with no sessions; Accept and Table only on an ended session without an
// outcome; both ask first, each with its own warning, and send only from the
// confirm button, which takes focus (Cancel gives it back to the opener); the
// mutation's arguments; a refusal shown on the row; and "Change to …" until
// hangar has released the session, which asks the same way. A queued session
// shows why it waits, and on a disk full of undecided sessions links each to
// its work item (hangar-capacity). The tRPC client and navigate are mocked.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { formatRoute } from "../lib/route.js";
import { ACCEPT_WARNING, HangarSessions, TABLE_WARNING } from "./HangarSessions.js";

const trpcMock = vi.hoisted(() => ({ hangarSessions: { query: vi.fn() }, hangarSessionOutcome: { mutate: vi.fn() } }));
vi.mock("../trpc.js", () => ({ trpc: trpcMock }));
const navigateMock = vi.hoisted(() => vi.fn());
vi.mock("../lib/navigate.js", () => ({ navigate: navigateMock }));

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
    waiting: null,
    updatedAt: NOW,
    ...extra,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  trpcMock.hangarSessions.query.mockReset();
  trpcMock.hangarSessionOutcome.mutate.mockReset();
  navigateMock.mockReset();
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

  test("a queued session says why it waits, in the server's words, muted when it is next in line", async () => {
    await render([
      session("s-q", "queued", { waiting: { kind: "next", text: "Waiting: 1 earlier headless request goes first; hangar has room for headless now.", ahead: 1 } }),
      session("s-c", "queued", { waiting: { kind: "capacity", text: 'Waiting on capacity (h says "ram: full").', reasons: [{ hangar: "h", reason: "ram: full" }] } }),
      session("s-r", "running"),
    ]);
    const note = row("s-q").querySelector("[data-session-waiting]");
    expect(note?.getAttribute("data-session-waiting")).toBe("next");
    expect(note?.textContent).toBe("Waiting: 1 earlier headless request goes first; hangar has room for headless now.");
    expect(note?.className).toContain("text-fg-muted");
    expect(row("s-c").querySelector("[data-session-waiting]")?.className).toContain("text-amber-200");
    expect(row("s-r").querySelector("[data-session-waiting]")).toBeNull();
    expect(row("s-q").querySelector("ul")).toBeNull();
  });

  test("an offline wait reads its time in the browser's zone; never checked in reads the server's text", async () => {
    const since = new Date();
    since.setHours(9, 0, 0, 0);
    await render([
      session("s-off", "queued", { waiting: { kind: "offline", text: `Waiting: hangar is offline (last check-in ${since.toISOString()}).`, since: since.toISOString() } }),
      session("s-never", "queued", { waiting: { kind: "offline", text: "Waiting: hangar has never checked in. Start hangar to run it.", since: null } }),
    ]);
    expect(row("s-off").querySelector("[data-session-waiting]")?.textContent).toBe("Waiting: hangar is offline since 09:00.");
    expect(row("s-never").querySelector("[data-session-waiting]")?.textContent).toBe("Waiting: hangar has never checked in. Start hangar to run it.");
  });

  const GONE_ID = "3f2a91c0-6f7d-4a54-9a0b-1c2d3e4f5a6b";
  const diskWaiting = (sessions: unknown[], total: number) => ({
    kind: "disk_awaiting_review",
    text: `Waiting on disk (hangar-linux says "need 8192 MB, free 1200 MB"). ${total} ended sessions still hold disks; accept or table them to free space.`,
    reasons: [{ hangar: "hangar-linux", reason: "disk: need 8192 MB, free 1200 MB" }],
    sessions,
    total,
  });

  test("a disk full of undecided sessions lists each under a lead-in: a board link, this item, or a decision right there", async () => {
    const onBoard = { id: "a-1", claimedBy: "hangar-linux", workItem: { id: "w-1", externalId: "bd-1", title: "Fix the thing", project: "bd" }, diskAllocatedBytes: 8 * 1024 ** 3 };
    const noProject = { id: "a-2", claimedBy: "hangar-linux", workItem: { id: "w-2", externalId: "x-2", title: "Loose item", project: null } };
    const gone = { id: GONE_ID, claimedBy: "hangar-linux", workItem: null, diskAllocatedBytes: 1024 ** 3 };
    const thisItem = { id: "a-4", claimedBy: "hangar-linux", workItem: { id: WORK_ITEM, externalId: "bd-9", title: "This drawer's item", project: "bd" } };
    const waiting = diskWaiting([onBoard, noProject, gone, thisItem], 25);
    await render([session("s-q", "queued", { waiting })]);

    const lead = [...row("s-q").querySelectorAll("p")].find((p) => p.textContent === "Decide these to free disk:");
    expect(lead?.id).toBeTruthy();
    const list = row("s-q").querySelector<HTMLElement>("ul")!;
    expect(list.getAttribute("aria-labelledby")).toBe(lead!.id);
    expect(row("s-q").querySelector("[data-session-waiting]")?.textContent).toBe(waiting.text);

    const item = (id: string): HTMLElement => list.querySelector<HTMLElement>(`[data-awaiting-session="${id}"]`)!;
    const boardLink = item("a-1").querySelector("a")!;
    expect(boardLink.getAttribute("href")).toBe(formatRoute({ view: "board", viewId: null, projects: ["bd"], item: "bd-1" }));
    expect(boardLink.textContent).toBe("bd-1 Fix the thing");
    expect(boardLink.className).toContain("min-h-11");
    expect(item("a-1").textContent).toContain("· 8.0 GB held");
    expect(buttons(item("a-1"))).toEqual([]);

    expect(item("a-2").querySelector("a")).toBeNull();
    expect(item("a-2").textContent).toContain("x-2 Loose item (no board project)");
    expect(item("a-2").textContent).not.toContain("held");
    expect(buttons(item("a-2"))).toEqual(["Accept", "Table"]);

    expect(item(GONE_ID).querySelector("a")).toBeNull();
    expect(item(GONE_ID).textContent).toContain("Session 3f2a91c0 on hangar-linux (its work item is gone) · 1.0 GB held");
    expect(buttons(item(GONE_ID))).toEqual(["Accept", "Table"]);
    for (const b of item(GONE_ID).querySelectorAll("button")) expect(b.className).toContain("min-h-11");

    expect(item("a-4").querySelector("a")).toBeNull();
    expect(item("a-4").textContent).toBe("bd-9 This drawer's item (this item; decide it below)");
    expect(buttons(item("a-4"))).toEqual([]);

    expect(row("s-q").textContent).toContain("and 21 more; they're listed here as you decide these.");

    // A plain click navigates in place; a modified one is left to the browser.
    const plain = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    act(() => {
      boardLink.dispatchEvent(plain);
    });
    expect(plain.defaultPrevented).toBe(true);
    expect(navigateMock).toHaveBeenCalledWith({ view: "board", viewId: null, projects: ["bd"], item: "bd-1" }, "push");
    // Noted where it reaches the document, then stopped there, since jsdom cannot open another page.
    let leftToBrowser = false;
    const keepPage = (e: Event): void => {
      leftToBrowser = !e.defaultPrevented;
      e.preventDefault();
    };
    document.addEventListener("click", keepPage);
    act(() => {
      boardLink.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, metaKey: true }));
    });
    document.removeEventListener("click", keepPage);
    expect(leftToBrowser).toBe(true);
    expect(navigateMock).toHaveBeenCalledTimes(1);
  });

  test("an undecided session whose work item is gone is tabled right there, asking first, and the list is read again", async () => {
    const gone = { id: GONE_ID, claimedBy: null, workItem: null };
    await render([session("s-q", "queued", { waiting: diskWaiting([gone], 1) })]);
    const item = (): HTMLElement => row("s-q").querySelector<HTMLElement>(`[data-awaiting-session="${GONE_ID}"]`)!;
    expect(item().textContent).toContain("Session 3f2a91c0 (its work item is gone)");

    await click(button(item(), "Table"));
    expect(trpcMock.hangarSessionOutcome.mutate).not.toHaveBeenCalled();
    expect(item().textContent).toContain(TABLE_WARNING);
    expect(document.activeElement).toBe(button(item(), "Table session"));

    trpcMock.hangarSessionOutcome.mutate.mockResolvedValue({ id: GONE_ID, state: "stopped", outcome: "tabled", outcomeAt: NOW, outcomeBy: "human", released: false, changed: true });
    await click(button(item(), "Table session"));
    expect(trpcMock.hangarSessionOutcome.mutate).toHaveBeenCalledWith({ id: GONE_ID, outcome: "tabled" });
    expect(trpcMock.hangarSessions.query).toHaveBeenCalledTimes(2);
  });

  test("lists no 'more' when every undecided session is shown", async () => {
    await render([session("s-q", "queued", { waiting: diskWaiting([{ id: GONE_ID, claimedBy: "h", workItem: null }], 1) })]);
    expect(row("s-q").textContent).not.toContain("more");
  });
});
