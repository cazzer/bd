// The server's request dispatcher over real HTTP: the guard refuses before
// either handler runs, and an allowed request reaches the right one. The
// handlers are stand-ins that record the call; request-guard.test.ts and
// review-images.test.ts prove the pieces themselves.

import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRequestDispatcher } from "./dispatch.js";

let server: Server;
let port: number;
let calls: string[];

beforeAll(async () => {
  let dispatch: ReturnType<typeof createRequestDispatcher> | null = null;
  server = createServer((req, res) => dispatch!(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  dispatch = createRequestDispatcher({
    port,
    reviewImages: async (req, res) => {
      calls.push(`images ${req.url}`);
      res.end("image");
    },
    trpc: (req, res) => {
      calls.push(`trpc ${req.url}`);
      res.end("trpc");
    },
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  calls = [];
});

/** A raw request, so the Host header can be anything (fetch forbids setting it). */
function send(path: string, headers: Record<string, string>, method = "GET"): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("createRequestDispatcher", () => {
  it("refuses a foreign Host with 403 before the image route and before tRPC", async () => {
    for (const path of ["/review-images/rv/r1/a.png", "/trpc/board"]) {
      expect(await send(path, { Host: `evil.example:${port}` })).toEqual({ status: 403, body: "Forbidden\n" });
    }
    expect(calls).toEqual([]);
  });

  it("refuses a write from a foreign Origin with 403", async () => {
    expect(await send("/trpc/reviewDecision", { Host: `localhost:${port}`, Origin: "http://evil.example" }, "POST")).toEqual({ status: 403, body: "Forbidden\n" });
    expect(calls).toEqual([]);
  });

  it("sends a loopback request under /review-images/ to the image route and anything else to tRPC", async () => {
    expect(await send("/review-images/rv/r1/a.png", { Host: `127.0.0.1:${port}` })).toMatchObject({ status: 200, body: "image" });
    expect(await send("/trpc/board", { Host: `localhost:${port}` })).toMatchObject({ status: 200, body: "trpc" });
    expect(calls).toEqual(["images /review-images/rv/r1/a.png", "trpc /trpc/board"]);
  });
});
