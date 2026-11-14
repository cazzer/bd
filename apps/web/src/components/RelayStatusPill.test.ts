// @vitest-environment jsdom
//
// The board header's relay chip (laptop-relay tasks.md 1.7): it words the
// status the server answers with the pending count beside it, shows only
// while the server lacks a binary or actions are open, polls every 30 s
// only while the tab is visible, and disappears while reads fail.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { RelayStatusView } from "../lib/relayStatus.js";
import { RELAY_STATUS_POLL_MS } from "../lib/useRelayStatus.js";
import { RelayStatusPill } from "./RelayStatusPill.js";

const trpcMock = vi.hoisted(() => ({ relayStatus: { query: vi.fn() } }));
vi.mock("../trpc.js", () => ({ trpc: trpcMock }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let hidden = false;

const ONLINE: RelayStatusView = { status: "online", relay: "relay-laptop", version: "1.0.0", lastSeenAt: new Date().toISOString(), queued: 2, claimed: 1, missingBinaries: ["bd", "herdr"] };

beforeEach(() => {
  vi.useFakeTimers();
  hidden = false;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  trpcMock.relayStatus.query.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const chip = (): HTMLElement | null => container.querySelector('[role="status"]');

describe("RelayStatusPill", () => {
  test("shows the status and pending count as a status chip, with the details in its title", async () => {
    trpcMock.relayStatus.query.mockResolvedValue(ONLINE);
    act(() => root.render(createElement(RelayStatusPill)));
    expect(chip()).toBeNull();
    await settle();

    expect(chip()?.textContent).toBe("relay online · 3 pending");
    expect(chip()?.getAttribute("data-relay-pill")).toBe("online");
    expect(container.querySelector("[data-relay-pending]")?.className ?? "").not.toContain("sr-only");
    expect(chip()?.title).toContain("relay-laptop 1.0.0");
    expect(chip()?.title).toContain("This server has no bd or herdr");
    expect(container.querySelector("button")).toBeNull();
  });

  test("words offline and never as the server answers them", async () => {
    const nineToday = new Date();
    nineToday.setHours(9, 0, 0, 0);
    vi.setSystemTime(new Date(nineToday.getTime() + 2 * 60 * 60 * 1000));
    trpcMock.relayStatus.query.mockResolvedValueOnce({ ...ONLINE, status: "offline", lastSeenAt: nineToday.toISOString() });
    act(() => root.render(createElement(RelayStatusPill)));
    await settle();
    expect(chip()?.textContent).toBe("relay offline since 09:00 · 3 pending");

    trpcMock.relayStatus.query.mockResolvedValueOnce({ ...ONLINE, status: "never", relay: null, version: null, lastSeenAt: null, queued: 0, claimed: 0 });
    await advance(RELAY_STATUS_POLL_MS);
    expect(chip()?.textContent).toBe("relay never checked in");
  });

  test("stays off on a server with both binaries and nothing open, and shows once an action is open", async () => {
    trpcMock.relayStatus.query.mockResolvedValueOnce({ ...ONLINE, missingBinaries: [], queued: 0, claimed: 0 });
    act(() => root.render(createElement(RelayStatusPill)));
    await settle();
    expect(chip()).toBeNull();

    trpcMock.relayStatus.query.mockResolvedValueOnce({ ...ONLINE, missingBinaries: [], queued: 1, claimed: 0 });
    await advance(RELAY_STATUS_POLL_MS);
    expect(chip()?.textContent).toBe("relay online · 1 pending");
  });

  test("polls only while visible, at once on return, and hides while reads fail", async () => {
    trpcMock.relayStatus.query.mockResolvedValue(ONLINE);
    act(() => root.render(createElement(RelayStatusPill)));
    await settle();
    expect(trpcMock.relayStatus.query).toHaveBeenCalledTimes(1);

    hidden = true;
    await advance(RELAY_STATUS_POLL_MS * 3);
    expect(trpcMock.relayStatus.query).toHaveBeenCalledTimes(1);

    hidden = false;
    trpcMock.relayStatus.query.mockRejectedValueOnce(new Error("HTTP 500"));
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });
    expect(trpcMock.relayStatus.query).toHaveBeenCalledTimes(2);
    expect(chip()).toBeNull();

    await advance(RELAY_STATUS_POLL_MS);
    expect(chip()?.textContent).toBe("relay online · 3 pending");
  });
});
