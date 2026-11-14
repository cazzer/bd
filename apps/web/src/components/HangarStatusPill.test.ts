// @vitest-environment jsdom
//
// The board header's hangar chip (hangar-queue tasks.md 2.7): it words the
// status the server answers, polls every 30 s only while the tab is
// visible, reads again when the tab comes back, and disappears while reads
// fail.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { HangarStatusView } from "../lib/hangarStatus.js";
import { HANGAR_POLL_MS, HangarStatusPill } from "./HangarStatusPill.js";

const trpcMock = vi.hoisted(() => ({ hangarStatus: { query: vi.fn() } }));
vi.mock("../trpc.js", () => ({ trpc: trpcMock }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let hidden = false;

const ONLINE: HangarStatusView = { status: "online", hangar: "hangar-desktop", version: "0.4.1", lastSeenAt: new Date().toISOString(), queued: 2, claimed: 1, running: 0 };

beforeEach(() => {
  vi.useFakeTimers();
  hidden = false;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  trpcMock.hangarStatus.query.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

/** Lets the pending query settle and React commit. */
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

describe("HangarStatusPill", () => {
  test("shows the status as a labelled status chip with the details in its title", async () => {
    trpcMock.hangarStatus.query.mockResolvedValue(ONLINE);
    act(() => root.render(createElement(HangarStatusPill)));
    expect(chip()).toBeNull();
    await settle();

    expect(chip()?.textContent).toBe("hangar online");
    expect(chip()?.getAttribute("data-hangar-pill")).toBe("online");
    expect(chip()?.title).toContain("hangar-desktop 0.4.1");
    expect(chip()?.title).toContain("2 queued · 1 claimed · 0 running");
    expect(container.querySelector("button")).toBeNull();
  });

  test("words offline and never as the server answers them", async () => {
    const nineToday = new Date();
    nineToday.setHours(9, 0, 0, 0);
    vi.setSystemTime(new Date(nineToday.getTime() + 2 * 60 * 60 * 1000));
    trpcMock.hangarStatus.query.mockResolvedValueOnce({ ...ONLINE, status: "offline", lastSeenAt: nineToday.toISOString() });
    act(() => root.render(createElement(HangarStatusPill)));
    await settle();
    expect(chip()?.textContent).toBe("hangar offline since 09:00");

    trpcMock.hangarStatus.query.mockResolvedValueOnce({ ...ONLINE, status: "never", hangar: null, version: null, lastSeenAt: null });
    await advance(HANGAR_POLL_MS);
    expect(chip()?.textContent).toBe("hangar never checked in");
    expect(chip()?.title).toContain("No hangar has checked in");
  });

  test("polls every 30 seconds while visible, not while hidden, and at once on return", async () => {
    trpcMock.hangarStatus.query.mockResolvedValue(ONLINE);
    act(() => root.render(createElement(HangarStatusPill)));
    await settle();
    expect(trpcMock.hangarStatus.query).toHaveBeenCalledTimes(1);

    await advance(HANGAR_POLL_MS);
    expect(trpcMock.hangarStatus.query).toHaveBeenCalledTimes(2);

    hidden = true;
    await advance(HANGAR_POLL_MS * 3);
    expect(trpcMock.hangarStatus.query).toHaveBeenCalledTimes(2);

    hidden = false;
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });
    expect(trpcMock.hangarStatus.query).toHaveBeenCalledTimes(3);
  });

  test("hides while reads fail and comes back when one succeeds", async () => {
    trpcMock.hangarStatus.query.mockResolvedValueOnce(ONLINE);
    act(() => root.render(createElement(HangarStatusPill)));
    await settle();
    expect(chip()).not.toBeNull();

    trpcMock.hangarStatus.query.mockRejectedValueOnce(new Error("HTTP 500"));
    await advance(HANGAR_POLL_MS);
    expect(chip()).toBeNull();

    trpcMock.hangarStatus.query.mockResolvedValueOnce(ONLINE);
    await advance(HANGAR_POLL_MS);
    expect(chip()?.textContent).toBe("hangar online");
  });
});
