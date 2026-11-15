import { describe, expect, it, vi } from "vitest";
import { createBackoff, createRelayClient, RelayRequestError, sleep } from "./client.js";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("the relay client", () => {
  it("sends a Bearer token and a JSON body, and answers the parsed body", async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => json(200, { interval_s: 30 }));
    const client = createRelayClient({ origin: "https://jetson.ts.net", readToken: () => "bdt_one", fetch });
    expect(await client.send("POST", "/relay/v1/check-in", { version: "relay/1" })).toEqual({ interval_s: 30 });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://jetson.ts.net/relay/v1/check-in");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer bdt_one");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(init.body).toBe('{"version":"relay/1"}');
  });

  it("reads the token once, and again after a 401", async () => {
    const tokens = ["bdt_old", "bdt_new"];
    const readToken = vi.fn(() => tokens.shift()!);
    const fetch = vi.fn(async (_url: string, init: RequestInit) => ((init.headers as Record<string, string>)["Authorization"] === "Bearer bdt_old" ? json(401, { error: { code: "unauthorized", message: "unknown token" } }) : json(200, { ok: true })));
    const client = createRelayClient({ origin: "https://j", readToken, fetch });
    const failed = await client.send("GET", "/relay/v1/projects").catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(RelayRequestError);
    expect(failed).toMatchObject({ status: 401, code: "unauthorized", retryable: true, message: "GET /relay/v1/projects answered 401 unauthorized: unknown token" });
    expect(String((failed as Error).message)).not.toContain("bdt_");
    expect(await client.send("GET", "/relay/v1/projects")).toEqual({ ok: true });
    expect(readToken).toHaveBeenCalledTimes(2);
  });

  it("classifies failures: 409/400/404 are final; 5xx, 429, a network failure, a timeout, and a bad token file are retryable", async () => {
    const statuses = [409, 400, 404, 500, 503, 429];
    for (const status of statuses) {
      const client = createRelayClient({ origin: "https://j", readToken: () => "t", fetch: async () => json(status, { error: { code: `c${status}`, message: "m" } }) });
      const err = (await client.send("POST", "/relay/v1/actions/1/result", {}).catch((e: unknown) => e)) as RelayRequestError;
      expect(err.status).toBe(status);
      expect(err.code).toBe(`c${status}`);
      expect(err.retryable).toBe(status >= 500 || status === 429);
    }
    const down = createRelayClient({ origin: "https://j", readToken: () => "t", fetch: async () => Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } })) });
    await expect(down.send("GET", "/relay/v1/projects")).rejects.toMatchObject({ code: "network", retryable: true, message: "GET /relay/v1/projects: could not reach https://j (ECONNREFUSED)" });
    const slow = createRelayClient({ origin: "https://j", readToken: () => "t", fetch: (_u, init) => new Promise((_r, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted")))) });
    await expect(slow.send("GET", "/relay/v1/projects", undefined, { timeoutMs: 20 })).rejects.toMatchObject({ code: "timeout", retryable: true });
    const badFile = createRelayClient({ origin: "https://j", readToken: () => {
      throw new Error("token file /t has mode 0644");
    }, fetch: async () => json(200, {}) });
    await expect(badFile.send("GET", "/relay/v1/projects")).rejects.toMatchObject({ code: "token_file", retryable: true, message: "token file /t has mode 0644" });
  });

  it("stops at once when its signal aborts, as not retryable", async () => {
    const stop = new AbortController();
    const client = createRelayClient({ origin: "https://j", readToken: () => "t", fetch: (_u, init) => new Promise((_r, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted")))) });
    const pending = client.send("POST", "/relay/v1/claim", { wait_s: 30 }, { signal: stop.signal });
    stop.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted", retryable: false });
  });
});

describe("backoff and sleep", () => {
  it("doubles from 1 s up to 60 s, with jitter, and resets", () => {
    const b = createBackoff({ random: () => 1 });
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(() => b.next())).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
    b.reset();
    expect(b.next()).toBe(1000);
    expect(createBackoff({ random: () => 0 }).next()).toBe(500);
  });

  it("sleep resolves early on abort", async () => {
    const stop = new AbortController();
    const started = Date.now();
    const pending = sleep(10_000, stop.signal);
    stop.abort();
    await pending;
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
