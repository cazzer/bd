// @vitest-environment jsdom
//
// What the shell knows about projects (shared-nav-header tasks.md 1.2): the
// registry read once, a failed read retried only when asked, a view's own
// registry read taken over (board, roadmap), and the saved
// view the address names — a board view's projects, a view of another
// renderer, and an id that is no view.

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ShellProjectsValue } from "./ShellProjects.js";

const trpcMock = vi.hoisted(() => ({ beadsProjects: { query: vi.fn() }, getNodes: { query: vi.fn() } }));
vi.mock("../trpc.js", () => ({ trpc: trpcMock }));

const { ShellProjectsProvider, useShellProjects } = await import("./ShellProjects.js");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let seen: ShellProjectsValue | null;

function Probe(): ReactNode {
  seen = useShellProjects();
  return null;
}

function render(viewId: string | null) {
  act(() => root.render(createElement(ShellProjectsProvider, { viewId, children: createElement(Probe) })));
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function viewNode(id: string, metadata: Record<string, unknown>, nodeType = "view") {
  return { id, nodeType, title: "Tides board", metadata };
}

beforeEach(() => {
  trpcMock.beadsProjects.query.mockReset();
  trpcMock.getNodes.query.mockReset();
  seen = null;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("ShellProjectsProvider", () => {
  test("takes a registry a view read for itself, without reading again", async () => {
    trpcMock.beadsProjects.query.mockResolvedValue({ projects: [{ key: "tides" }] });
    render(null);
    await settle();
    expect(seen!.registry).toEqual(["tides"]);
    const first = seen!.registry;
    act(() => seen!.reportRegistry(["tides"]));
    expect(seen!.registry).toBe(first);
    act(() => seen!.reportRegistry(["tides", "navg"]));
    expect(seen!.registry).toEqual(["tides", "navg"]);
    expect(trpcMock.beadsProjects.query).toHaveBeenCalledTimes(1);
  });

  test("reads the registry once, and a failed read again only when asked", async () => {
    trpcMock.beadsProjects.query.mockRejectedValueOnce(new Error("down"));
    render(null);
    await settle();
    expect(seen).toMatchObject({ registry: null, registryFailed: true });
    render(null);
    await settle();
    expect(trpcMock.beadsProjects.query).toHaveBeenCalledTimes(1);

    trpcMock.beadsProjects.query.mockResolvedValueOnce({ projects: [{ key: "tides" }, { key: "skyos" }] });
    act(() => seen!.retryRegistry());
    await settle();
    expect(seen).toMatchObject({ registry: ["tides", "skyos"], registryFailed: false });
    act(() => seen!.retryRegistry());
    await settle();
    expect(trpcMock.beadsProjects.query).toHaveBeenCalledTimes(2);
  });

  test("reads the named saved view: a board view's projects and title", async () => {
    trpcMock.beadsProjects.query.mockResolvedValue({ projects: [] });
    trpcMock.getNodes.query.mockResolvedValue({ nodes: [viewNode("v1", { renderer: "board", filter: { where: [{ key: "project", op: "oneOf", values: ["tides", "skyos"] }] } })] });
    render("v1");
    await settle();
    expect(trpcMock.getNodes.query).toHaveBeenCalledWith({ ids: ["v1"] });
    expect(seen!.view).toEqual({ viewId: "v1", title: "Tides board", renderer: "board", projects: ["tides", "skyos"] });
  });

  test("a view of another renderer keeps its renderer; an id that is no view, or a failed read, names nothing", async () => {
    trpcMock.beadsProjects.query.mockResolvedValue({ projects: [] });
    trpcMock.getNodes.query.mockResolvedValueOnce({ nodes: [viewNode("v2", { renderer: "timeline", filter: {} })] });
    render("v2");
    await settle();
    expect(seen!.view).toEqual({ viewId: "v2", title: "Tides board", renderer: "timeline", projects: null });

    trpcMock.getNodes.query.mockResolvedValueOnce({ nodes: [viewNode("n3", {}, "work_item")] });
    render("n3");
    await settle();
    expect(seen!.view).toEqual({ viewId: "n3", title: null, renderer: null, projects: null });

    trpcMock.getNodes.query.mockRejectedValueOnce(new Error("down"));
    render("v4");
    await settle();
    expect(seen!.view).toEqual({ viewId: "v4", title: null, renderer: null, projects: null });
  });
});
