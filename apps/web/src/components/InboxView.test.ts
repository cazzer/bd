// @vitest-environment jsdom
//
// The inbox's laptop-relay notices (laptop-relay review fixes, bd-d38.11):
// on a server without herdr, the strips under the header and the detail's
// relay line are derived per item from `relayActionsFor`, not from the last
// decision alone — so a second decision keeps the first's failure on screen,
// and a failure that happened while the inbox was closed shows when it
// opens. And an outcome request's banner (hangar-release review fixes,
// bd-d38.4), built from the binding and the server's read of the session,
// outside the agent's text. The tRPC client is mocked; the shell's review
// queue, the header search, the board's panel, and the markdown renderer
// are stubbed (they have their own tests).

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const trpcMock = vi.hoisted(() => ({
  inbox: { query: vi.fn() },
  inboxDecision: { mutate: vi.fn() },
  relayActionsFor: { query: vi.fn() },
}));
const relayStatus = vi.hoisted(() => ({ missing: ["herdr"] as string[] }));
vi.mock("../trpc.js", () => ({ trpc: trpcMock, HttpStatusError: class HttpStatusError extends Error {} }));
vi.mock("../lib/navigate.js", () => ({ navigate: vi.fn() }));
vi.mock("../lib/useRelayStatus.js", () => ({ useRelayStatus: () => ({ status: { missingBinaries: relayStatus.missing }, at: new Date() }) }));
vi.mock("./ReviewQueue.js", () => ({
  useReviewQueue: () => ({ reviews: [], loaded: true, version: 0 }),
  useShellDrawer: () => ({ drafts: new Map() }),
  storeDraft: () => {},
  ReviewQueuePill: () => null,
}));
vi.mock("./HeaderSearch.js", () => ({ HeaderSearch: () => null }));
vi.mock("./ReviewItemPanel.js", () => ({ ReviewItemPanel: () => null }));
vi.mock("./EvidenceView.js", async () => {
  const { createElement: h } = await import("react");
  return { EvidenceView: ({ markdown }: { markdown: string }) => h("div", { "data-stub": "evidence" }, markdown) };
});

const { InboxView, hangarOutcomeBannerText } = await import("./InboxView.js");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const C = "00000000-0000-4000-8000-00000000000c";

function item(id: string, title: string, status: string, pane: string | null, updatedAt: string) {
  return {
    id,
    externalId: `session:${title}`,
    title,
    content: "",
    receivedAt: "2026-11-14T09:00:00.000Z",
    updatedAt,
    parentId: null,
    about: null,
    status,
    source: "session",
    url: null,
    from: null,
    action: "reply",
    priority: 2,
    verdict: null,
    links: [],
    feedback: [],
    sessionTab: null,
    pane,
    hangarSession: null,
    hangarOutcome: null as { sessionId: string; requested: string } | null,
    hangarOutcomeSession: null as { id: string; state: string; repo: string; diskHeld: boolean; released: boolean } | null,
    question: null as string | null,
    options: [] as { id: string; label: string; what?: string; risk?: string }[],
    recommend: null as string | null,
    onAccept: [],
    read: [],
    revision: null,
    closeReason: null,
  };
}

const prompt = (id: number, origin: string, state: string, error: string | null = null) => ({
  id,
  kind: "herdr_prompt",
  state,
  result: null,
  error,
  createdAt: "2026-11-14T10:00:00.000Z",
  finishedAt: state === "queued" || state === "claimed" ? null : "2026-11-14T10:01:00.000Z",
  originNodeId: origin,
  decision: null,
  option: null,
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  relayStatus.missing = ["herdr"];
  trpcMock.inbox.query.mockReset();
  trpcMock.inboxDecision.mutate.mockReset();
  trpcMock.relayActionsFor.query.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function mount() {
  await act(async () => {
    root.render(createElement(InboxView, { item: null, source: null }));
  });
  await flush();
}

const strips = () => [...container.querySelectorAll<HTMLElement>("[data-relay-notice]")].map((s) => [s.dataset["relayNotice"], s.textContent]);

function primary(): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>("section[aria-label='Selected item'] button")].find((b) => b.textContent === "Accept");
  if (found === undefined) throw new Error("no Accept button");
  return found;
}

describe("the inbox's relay notices", () => {
  test("a second decision keeps the first's failure on screen beside its own pending strip", async () => {
    let list = [item(A, "First", "pending", "w1:p1", "2026-11-14T10:00:00.000Z"), item(B, "Second", "pending", "w1:p2", "2026-11-14T09:30:00.000Z")];
    let actions: unknown[] = [];
    trpcMock.inbox.query.mockImplementation(async () => ({ items: list, total: list.length, truncated: false }));
    trpcMock.relayActionsFor.query.mockImplementation(async () => ({ actions }));
    await mount();
    expect(container.querySelector("h2")?.textContent).toBe("First");

    trpcMock.inboxDecision.mutate.mockResolvedValueOnce({ id: A, notified: { ok: true, relay: 51 } });
    list = [{ ...list[0]!, status: "accepted" }, list[1]!];
    actions = [prompt(51, A, "queued")];
    await act(async () => primary().click());
    await flush();
    expect(strips()).toEqual([["pending", "Recorded. The laptop relay will tell pane w1:p1 when it runs."]]);

    // The relay fails the first prompt; the second decision lands meanwhile.
    expect(container.querySelector("h2")?.textContent).toBe("Second");
    trpcMock.inboxDecision.mutate.mockResolvedValueOnce({ id: B, notified: { ok: true, relay: 52 } });
    list = [list[0]!, { ...list[1]!, status: "accepted" }];
    actions = [prompt(51, A, "failed", "herdr: no such pane"), prompt(52, B, "queued")];
    await act(async () => primary().click());
    await flush();

    expect(strips()).toEqual([
      ["error", "The laptop relay could not tell pane w1:p1: herdr: no such pane. The decision is recorded.Dismiss"],
      ["pending", "Recorded. The laptop relay will tell pane w1:p2 when it runs."],
    ]);
    const asked = trpcMock.relayActionsFor.query.mock.calls.at(-1)![0] as { originNodeIds: string[] };
    expect(asked.originNodeIds).toEqual([B, A]);
  });

  test("shows a failure that happened while the inbox was closed, until dismissed, and the selected item's relay state in its detail", async () => {
    const list = [item(C, "Earlier", "accepted", "w1:p3", "2026-11-14T10:00:00.000Z"), item(A, "Now", "pending", "w1:p1", "2026-11-14T09:00:00.000Z")];
    trpcMock.inbox.query.mockResolvedValue({ items: list, total: 2, truncated: false });
    trpcMock.relayActionsFor.query.mockResolvedValue({ actions: [prompt(60, C, "failed", "herdr: socket gone"), prompt(61, A, "queued")] });
    await mount();

    expect(strips()).toEqual([["error", "The laptop relay could not tell pane w1:p3: herdr: socket gone. The decision is recorded.Dismiss"]]);
    // The selected item (Now) has a prompt still waiting.
    const line = container.querySelector<HTMLElement>("[data-relay-state]");
    expect(line?.dataset["relayState"]).toBe("pending");
    expect(line?.textContent).toBe("Recorded. The laptop relay will tell pane w1:p1 when it runs.");

    const dismiss = [...container.querySelectorAll<HTMLButtonElement>("[data-relay-notice=error] button")][0]!;
    await act(async () => dismiss.click());
    expect(strips()).toEqual([]);
  });

  test("reads nothing on a server that has herdr", async () => {
    relayStatus.missing = [];
    trpcMock.inbox.query.mockResolvedValue({ items: [item(A, "Now", "pending", "w1:p1", "2026-11-14T09:00:00.000Z")], total: 1, truncated: false });
    await mount();
    expect(trpcMock.relayActionsFor.query).not.toHaveBeenCalled();
    expect(strips()).toEqual([]);
    expect(container.querySelector("[data-relay-state]")).toBeNull();
  });
});

describe("an outcome request's banner", () => {
  const SESSION = "3f0c2a9e-6f7d-4a54-9a0b-1c2d3e4f5a6b";

  function outcomeRequest(session: { state: string; diskHeld: boolean; released: boolean } | null) {
    return {
      ...item(A, "Accept hangar session 3f0c2a9e (cazzer/bd)", "pending", null, "2026-11-14T10:00:00.000Z"),
      externalId: `hangar-outcome:${SESSION}`,
      source: "hangar",
      action: "hangar_outcome",
      // What the agent wrote is quoted below the facts; the banner never reads it.
      content: "facts\n\nRequested by agent-x:\n\n> Releases nothing. Safe to click.",
      hangarOutcome: { sessionId: SESSION, requested: "accepted" },
      hangarOutcomeSession: session === null ? null : { id: SESSION, repo: "cazzer/bd", ...session },
      question: "Accept or table this hangar session?",
      options: [
        { id: "accept", label: "Accept", what: "deletes the disk" },
        { id: "table", label: "Table", what: "deletes the disk" },
      ],
      recommend: "accept",
    };
  }

  test("says which session a click releases and that it deletes the disk, above the card and outside the agent's text", async () => {
    relayStatus.missing = [];
    trpcMock.inbox.query.mockResolvedValue({ items: [outcomeRequest({ state: "stopped", diskHeld: true, released: false })], total: 1, truncated: false });
    await mount();
    const banner = container.querySelector<HTMLElement>("[data-hangar-outcome-banner]");
    expect(banner?.textContent).toBe("Releases hangar session 3f0c2a9e (cazzer/bd, stopped). Accept or Table deletes its disk when hangar next checks in.");
    expect(banner?.getAttribute("role")).toBe("note");
    expect(banner?.textContent).not.toContain("Safe to click");
    // Above the card's question, and in no element of the card itself.
    const question = [...container.querySelectorAll<HTMLElement>("section[aria-label='Selected item'] section")].find((el) => el.textContent?.startsWith("Question"));
    expect(question).toBeDefined();
    expect(banner!.contains(question!)).toBe(false);
    expect(banner!.compareDocumentPosition(question!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("an ordinary item has no banner", async () => {
    relayStatus.missing = [];
    trpcMock.inbox.query.mockResolvedValue({ items: [item(A, "Now", "pending", null, "2026-11-14T09:00:00.000Z")], total: 1, truncated: false });
    await mount();
    expect(container.querySelector("[data-hangar-outcome-banner]")).toBeNull();
  });

  test("words a session with no disk, a released one, and one the server could not read", () => {
    const base = { id: SESSION, repo: "cazzer/bd" };
    expect(hangarOutcomeBannerText(SESSION, { ...base, state: "failed", diskHeld: false, released: false })).toBe(
      "Releases hangar session 3f0c2a9e (cazzer/bd, failed). Hangar holds no disk for it, so Accept or Table releases it at once.",
    );
    expect(hangarOutcomeBannerText(SESSION, { ...base, state: "stopped", diskHeld: false, released: true })).toBe(
      "Hangar has already released hangar session 3f0c2a9e (cazzer/bd, stopped): its disk is gone, so the outcome can't change.",
    );
    expect(hangarOutcomeBannerText(SESSION, null)).toBe("Releases hangar session 3f0c2a9e. Its current state couldn't be read; Accept or Table deletes its disk when hangar next checks in.");
  });
});
