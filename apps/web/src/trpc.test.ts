// The batch link's fetch (src/trpc.ts): a 401 flips the connect gate
// (tailnet-hosting decision 5), and a non-JSON failure keeps its status.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { isUnauthorized, resetConnectionForTests } from "./lib/connection.js";
import { fetchKeepingStatus, HttpStatusError } from "./trpc.js";

beforeEach(() => resetConnectionForTests());
afterEach(() => vi.unstubAllGlobals());

function stubFetch(status: number, contentType: string) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("body", { status, headers: { "Content-Type": contentType } })));
}

describe("fetchKeepingStatus", () => {
  test("a text/plain 401 throws HttpStatusError(401) and marks the browser unauthorized", async () => {
    stubFetch(401, "text/plain; charset=utf-8");
    const err = await fetchKeepingStatus("/trpc/search").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpStatusError);
    expect((err as HttpStatusError).status).toBe(401);
    expect(isUnauthorized()).toBe(true);
  });

  test("any other failure leaves the gate alone", async () => {
    stubFetch(500, "text/plain");
    await expect(fetchKeepingStatus("/trpc/search")).rejects.toBeInstanceOf(HttpStatusError);
    expect(isUnauthorized()).toBe(false);
  });

  test("an ok response retires the connect screen's attempt marker", async () => {
    const removeItem = vi.fn();
    vi.stubGlobal("sessionStorage", { removeItem });
    stubFetch(200, "application/json");
    await fetchKeepingStatus("/trpc/search");
    expect(removeItem).toHaveBeenCalledWith("bd-connect-attempt");
  });
});
