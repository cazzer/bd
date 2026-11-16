// @vitest-environment jsdom
//
// The shell's memo guarantee (shared-nav-header design.md decision 1): the
// header sits outside the memoized view, so a queue read or the project
// registry landing re-renders the header and never the view; only a change
// of route does. The view and the header are render-counting probes; the
// queue is a hook the test drives.

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const counts = vi.hoisted(() => ({ graph: 0, header: 0, registry: null as string[] | null }));
const queue = vi.hoisted(() => ({ set: null as ((n: number) => void) | null }));
const registry = vi.hoisted(() => ({ resolve: null as ((answer: { projects: { key: string }[] }) => void) | null }));

vi.mock("./trpc.js", () => ({
  trpc: {
    beadsProjects: { query: () => new Promise((resolve) => (registry.resolve = resolve)) },
    getNodes: { query: () => new Promise(() => {}) },
  },
}));
vi.mock("./components/GraphView.js", () => ({
  GraphView: () => {
    counts.graph += 1;
    return null;
  },
}));
vi.mock("./components/FeedView.js", () => ({ FeedView: () => null }));
vi.mock("./components/AppHeader.js", async () => {
  const { useShellProjects } = await import("./components/ShellProjects.js");
  return {
    AppHeader: () => {
      counts.header += 1;
      counts.registry = useShellProjects().registry;
      return null;
    },
  };
});
vi.mock("./components/ReviewQueue.js", () => ({ ReviewQueueProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("./lib/liveStream.js", () => ({ useLiveState: () => "live" }));
vi.mock("./lib/useReviewQueue.js", async () => {
  const { useState } = await import("react");
  return {
    useReviewQueue: () => {
      const [total, setTotal] = useState(0);
      queue.set = setTotal;
      return { total };
    },
  };
});

const { App } = await import("./App.js");
const { navigate } = await import("./lib/navigate.js");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  counts.graph = 0;
  counts.header = 0;
  history.replaceState(null, "", "/graph");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  history.replaceState(null, "", "/");
});

describe("App", () => {
  test("a queue read or the registry landing re-renders the header, never the view; a route change does", async () => {
    act(() => root.render(createElement(App)));
    const graph = counts.graph;
    const header = counts.header;
    expect(graph).toBeGreaterThan(0);

    await act(async () => {
      registry.resolve!({ projects: [{ key: "tides" }] });
      await Promise.resolve();
    });
    expect(counts.registry).toEqual(["tides"]);
    expect(counts.header).toBeGreaterThan(header);

    const afterRegistry = counts.header;
    act(() => queue.set!(3));
    expect(counts.header).toBeGreaterThan(afterRegistry);
    expect(counts.graph).toBe(graph);

    act(() => navigate({ view: "graph", q: null, types: [], node: null, projects: ["tides"] }, "push"));
    expect(counts.graph).toBeGreaterThan(graph);
  });
});
