// @vitest-environment jsdom
//
// The connect screen (tailnet-hosting decision 5): the gate shows the app
// until a 401 marks this browser unauthorized, then a one-field form that
// trades the pasted token for a cookie at `POST /auth/connect`.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { markUnauthorized, resetConnectionForTests } from "../lib/connection.js";
import { ConnectGate, ConnectScreen } from "./ConnectScreen.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  resetConnectionForTests();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function typeToken(value: string): void {
  const input = container.querySelector<HTMLInputElement>("input")!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setValue.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit(): Promise<void> {
  const form = container.querySelector("form")!;
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

function stubFetch(status: number) {
  const fetchMock = vi.fn(async () => new Response(status === 204 ? null : "Unauthorized\n", { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("ConnectGate", () => {
  test("shows the app, then the connect form once the server refuses this browser", () => {
    act(() => root.render(createElement(ConnectGate, null, createElement("p", { id: "app" }, "board"))));
    expect(container.querySelector("#app")).not.toBeNull();
    expect(container.querySelector("form")).toBeNull();

    act(() => markUnauthorized());
    expect(container.querySelector("#app")).toBeNull();
    expect(container.querySelector("form")).not.toBeNull();
  });
});

describe("ConnectScreen", () => {
  test("asks for the token in a labelled password field", () => {
    act(() => root.render(createElement(ConnectScreen, { onConnected: () => {} })));
    const input = container.querySelector("input")!;
    expect(input.type).toBe("password");
    expect(input.autocomplete).toBe("off");
    const label = container.querySelector(`label[for="${input.id}"]`);
    expect(label?.textContent).toBe("Client token");
  });

  test("posts the token as JSON and reports a 204 as connected", async () => {
    const fetchMock = stubFetch(204);
    const onConnected = vi.fn();
    act(() => root.render(createElement(ConnectScreen, { onConnected })));
    typeToken("bdt_example");
    await submit();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/auth/connect");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({ token: "bdt_example" });
    expect(onConnected).toHaveBeenCalledTimes(1);
  });

  test("a 401 shows the refusal and stays on the form", async () => {
    stubFetch(401);
    const onConnected = vi.fn();
    act(() => root.render(createElement(ConnectScreen, { onConnected })));
    typeToken("bdt_wrong");
    await submit();

    expect(onConnected).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("That token wasn't accepted.");
    expect(container.querySelector("button")!.disabled).toBe(false);
  });

  test("the button is disabled while the request is in flight", async () => {
    let answer!: (res: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => (answer = resolve))));
    act(() => root.render(createElement(ConnectScreen, { onConnected: () => {} })));
    typeToken("bdt_example");
    await submit();
    expect(container.querySelector("button")!.disabled).toBe(true);

    await act(async () => answer(new Response("oops", { status: 500 })));
    expect(container.querySelector("button")!.disabled).toBe(false);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("HTTP 500");
  });
});
