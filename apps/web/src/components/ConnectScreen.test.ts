// @vitest-environment jsdom
//
// The connect screen (tailnet-hosting decision 5): the gate shows the app
// until a 401 marks this browser unauthorized, then a one-field form that
// trades the pasted token for a cookie at `POST /auth/connect`.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { markAuthorized, markUnauthorized, resetConnectionForTests } from "../lib/connection.js";
import { ConnectGate, ConnectScreen } from "./ConnectScreen.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  resetConnectionForTests();
  sessionStorage.clear();
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

function alertText(): string | null | undefined {
  return container.querySelector('[role="alert"]')?.textContent;
}

function input(): HTMLInputElement {
  return container.querySelector<HTMLInputElement>("input")!;
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
    expect(alertText()).toBe(
      "That token wasn't accepted. Check it was copied whole, and that it's a human token; if it was revoked, create a new one on the host.",
    );
    expect(container.querySelector("button")!.disabled).toBe(false);
    expect(sessionStorage.getItem("bd-connect-attempt")).toBeNull();
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
    expect(alertText()).toBe("Connecting failed (HTTP 500). Try again.");
  });

  test("says where a token comes from, and the input is described by it", () => {
    act(() => root.render(createElement(ConnectScreen, { onConnected: () => {} })));
    const help = container.querySelector("#connect-help")!;
    expect(help.textContent).toContain("pnpm -s client-token create <name> --scope human");
    expect(help.textContent).toContain("bdt_");
    expect(input().getAttribute("aria-describedby")).toBe("connect-help");
  });

  test("an error is added to the input's description alongside the help", async () => {
    stubFetch(401);
    act(() => root.render(createElement(ConnectScreen, { onConnected: () => {} })));
    typeToken("bdt_wrong");
    await submit();
    expect(input().getAttribute("aria-describedby")).toBe("connect-error connect-help");
    expect(input().getAttribute("aria-invalid")).toBe("true");
  });

  test.each(["", "   \n\t"])("an empty token (%j) asks for one without calling the server", async (value) => {
    const fetchMock = stubFetch(204);
    act(() => root.render(createElement(ConnectScreen, { onConnected: () => {} })));
    typeToken(value);
    await submit();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(alertText()).toBe("Paste a token first.");
  });

  test("the token is trimmed before it is sent", async () => {
    const fetchMock = stubFetch(204);
    act(() => root.render(createElement(ConnectScreen, { onConnected: () => {} })));
    typeToken("  bdt_example\n");
    await submit();
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ token: "bdt_example" });
  });

  test.each([400, 413, 415])("a %i says the value isn't a token, without offering a retry", async (status) => {
    stubFetch(status);
    act(() => root.render(createElement(ConnectScreen, { onConnected: () => {} })));
    typeToken("not a token");
    await submit();
    expect(alertText()).toBe("That doesn't look like a token.");
  });

  test("a network failure says to try again", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    act(() => root.render(createElement(ConnectScreen, { onConnected: () => {} })));
    typeToken("bdt_example");
    await submit();
    expect(alertText()).toBe("Couldn't reach Breakdown. Check the connection and try again.");
  });

  test("a 204 sets the attempt marker, and never the token, before reporting connected", async () => {
    stubFetch(204);
    let markerAtConnect: string | null = null;
    const onConnected = vi.fn(() => {
      markerAtConnect = sessionStorage.getItem("bd-connect-attempt");
    });
    act(() => root.render(createElement(ConnectScreen, { onConnected })));
    typeToken("bdt_secret");
    await submit();
    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(markerAtConnect).toBe("1");
    for (let i = 0; i < sessionStorage.length; i++) {
      expect(sessionStorage.getItem(sessionStorage.key(i)!)).not.toContain("bdt_secret");
    }
  });

  test("a marker left by the last attempt means the cookie wasn't kept; it is cleared", () => {
    sessionStorage.setItem("bd-connect-attempt", "1");
    act(() => root.render(createElement(ConnectScreen, { onConnected: () => {} })));
    expect(alertText()).toBe(
      "Connected, but this browser didn't keep the connection. Check that cookies aren't blocked for this site.",
    );
    expect(sessionStorage.getItem("bd-connect-attempt")).toBeNull();
  });

  test("blocked storage doesn't break connecting", async () => {
    stubFetch(204);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    const onConnected = vi.fn();
    try {
      act(() => root.render(createElement(ConnectScreen, { onConnected })));
      typeToken("bdt_example");
      await submit();
      expect(onConnected).toHaveBeenCalledTimes(1);
    } finally {
      vi.restoreAllMocks();
    }
  });

  test("the input is focused on mount", () => {
    act(() => root.render(createElement(ConnectScreen, { onConnected: () => {} })));
    expect(document.activeElement).toBe(input());
  });

  test("after an error the input is focused with its value selected, so a paste replaces it", async () => {
    stubFetch(401);
    act(() => root.render(createElement(ConnectScreen, { onConnected: () => {} })));
    typeToken("bdt_wrong");
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    expect(document.activeElement).not.toBe(input());
    await submit();
    expect(document.activeElement).toBe(input());
    expect(input().selectionStart).toBe(0);
    expect(input().selectionEnd).toBe("bdt_wrong".length);
  });
});

describe("markAuthorized", () => {
  test("an authorized request retires a pending connect marker", () => {
    sessionStorage.setItem("bd-connect-attempt", "1");
    markAuthorized();
    expect(sessionStorage.getItem("bd-connect-attempt")).toBeNull();
  });
});
