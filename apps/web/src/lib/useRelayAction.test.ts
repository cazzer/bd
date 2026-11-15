// @vitest-environment jsdom
//
// useRelayAction (laptop-relay tasks.md 1.7): it reads the action at once,
// every 2 s while it is queued or claimed, never while the tab is hidden
// (reading again the moment it is visible), stops once the action is done
// or failed, keeps its last answer through a failed read, keeps the same
// object while polls say the same thing, and follows nothing for a null id.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { RelayActionView } from "./relayAction.js";
import { RELAY_ACTION_POLL_MS, useRelayAction } from "./useRelayAction.js";

const trpcMock = vi.hoisted(() => ({ relayAction: { query: vi.fn() } }));
vi.mock("../trpc.js", () => ({ trpc: trpcMock }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let hidden = false;

function Probe({ id }: { id: number | null }) {
  const action = useRelayAction(id);
  return createElement("output", null, action === null ? "none" : action.state);
}

const answer = (state: RelayActionView["state"]): RelayActionView => ({ id: 7, state, result: null, error: null });

beforeEach(() => {
  vi.useFakeTimers();
  hidden = false;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  trpcMock.relayAction.query.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function mount(id: number | null): Promise<void> {
  await act(async () => {
    root.render(createElement(Probe, { id }));
    await Promise.resolve();
  });
}

const shown = (): string => container.textContent ?? "";

describe("useRelayAction", () => {
  test("reads at once, every 2 s while open, and stops once done", async () => {
    trpcMock.relayAction.query.mockResolvedValueOnce(answer("queued")).mockResolvedValueOnce(answer("claimed")).mockResolvedValueOnce(answer("done"));
    await mount(7);
    expect(trpcMock.relayAction.query).toHaveBeenCalledWith({ id: 7 });
    expect(shown()).toBe("queued");

    await advance(RELAY_ACTION_POLL_MS);
    expect(shown()).toBe("claimed");
    await advance(RELAY_ACTION_POLL_MS);
    expect(shown()).toBe("done");

    await advance(RELAY_ACTION_POLL_MS * 5);
    expect(trpcMock.relayAction.query).toHaveBeenCalledTimes(3);
  });

  test("makes no request while the tab is hidden and reads at once when it is visible again", async () => {
    trpcMock.relayAction.query.mockResolvedValue(answer("queued"));
    await mount(7);
    expect(trpcMock.relayAction.query).toHaveBeenCalledTimes(1);

    hidden = true;
    await advance(RELAY_ACTION_POLL_MS * 4);
    expect(trpcMock.relayAction.query).toHaveBeenCalledTimes(1);

    hidden = false;
    trpcMock.relayAction.query.mockResolvedValue(answer("failed"));
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });
    expect(trpcMock.relayAction.query).toHaveBeenCalledTimes(2);
    expect(shown()).toBe("failed");
  });

  test("keeps the last answer through a failed read and retries on the next tick", async () => {
    trpcMock.relayAction.query.mockResolvedValueOnce(answer("queued")).mockRejectedValueOnce(new Error("HTTP 502")).mockResolvedValueOnce(answer("done"));
    await mount(7);
    await advance(RELAY_ACTION_POLL_MS);
    expect(shown()).toBe("queued");
    await advance(RELAY_ACTION_POLL_MS);
    expect(shown()).toBe("done");
  });

  test("keeps the same object while polls say the same thing", async () => {
    const seen: Array<RelayActionView | null> = [];
    function Recorder() {
      seen.push(useRelayAction(7));
      return null;
    }
    // A fresh object every poll, as the network gives.
    trpcMock.relayAction.query.mockImplementation(async () => answer("queued"));
    await act(async () => {
      root.render(createElement(Recorder));
      await Promise.resolve();
    });
    const first = seen.at(-1)!;
    expect(first.state).toBe("queued");
    await advance(RELAY_ACTION_POLL_MS * 3);
    expect(trpcMock.relayAction.query).toHaveBeenCalledTimes(4);
    expect(seen.every((v) => v === null || v === first)).toBe(true);

    trpcMock.relayAction.query.mockImplementation(async () => ({ ...answer("queued"), error: "slow" }));
    await advance(RELAY_ACTION_POLL_MS);
    expect(seen.at(-1)).not.toBe(first);
    expect(seen.at(-1)?.error).toBe("slow");
  });

  test("follows nothing for a null id, and drops an earlier id's answer when the id changes", async () => {
    await mount(null);
    await advance(RELAY_ACTION_POLL_MS * 3);
    expect(trpcMock.relayAction.query).not.toHaveBeenCalled();
    expect(shown()).toBe("none");

    trpcMock.relayAction.query.mockResolvedValue(answer("queued"));
    await mount(7);
    expect(shown()).toBe("queued");
    trpcMock.relayAction.query.mockReturnValue(new Promise(() => {}));
    await mount(8);
    expect(shown()).toBe("none");
  });
});
