// The server's request dispatcher over real HTTP: admission refuses before
// any handler runs, an admitted request reaches the right one, and the
// admitted token client reaches tRPC through `admittedClients`. The
// handlers and the token store are stand-ins that record the call;
// packages/core admission.test.ts, auth-connect.test.ts, and
// review-images.test.ts prove the pieces themselves.
//
// Every request here comes from a loopback peer, so a tailnet `Host` is a
// loopback peer hiding a remote caller (a local proxy) — exactly the case
// admission refuses to trust without a token.

import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { admittedClients } from "./context.js";
import { createRequestDispatcher } from "./dispatch.js";

const TAILNET = "breakdown.tail.example";
const PHONE_TOKEN = "bdt_phone-token";
const THROWING_TOKEN = "bdt_throws";

let server: Server;
let port: number;
let calls: string[];
let verified: number;

beforeAll(async () => {
  let dispatch: ReturnType<typeof createRequestDispatcher> | null = null;
  server = createServer((req, res) => dispatch!(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  dispatch = createRequestDispatcher({
    port,
    allowedHosts: [TAILNET],
    verifyToken: async (token) => {
      verified += 1;
      if (token === THROWING_TOKEN) throw new Error("token store unavailable");
      return token === PHONE_TOKEN ? "phone" : null;
    },
    connect: async (req, res) => {
      calls.push(`connect ${req.method} ${req.url}`);
      res.end("connect");
    },
    reviewImages: async (req, res) => {
      calls.push(`images ${req.url} client=${admittedClients.get(req) ?? null}`);
      res.end("image");
    },
    trpc: (req, res) => {
      calls.push(`trpc ${req.url} client=${admittedClients.get(req) ?? null}`);
      res.end("trpc");
    },
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  calls = [];
  verified = 0;
});

interface Sent {
  status: number;
  body: string;
  headers: IncomingHttpHeaders;
}

/** A raw request, so the Host header can be anything (fetch forbids setting it). */
function send(path: string, headers: Record<string, string>, method = "GET"): Promise<Sent> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

const tailnetHost = (): string => `${TAILNET}:${port}`;
const bearer = (token = PHONE_TOKEN): Record<string, string> => ({ Authorization: `Bearer ${token}` });
const cookie = (token = PHONE_TOKEN): Record<string, string> => ({ Cookie: `theme=dark; breakdown_token=${token}` });

describe("createRequestDispatcher: Host and Origin", () => {
  it("refuses a foreign Host with 403 before the image route and before tRPC", async () => {
    for (const path of ["/review-images/rv/r1/a.png", "/trpc/board"]) {
      expect(await send(path, { Host: `evil.example:${port}` })).toMatchObject({ status: 403, body: "Forbidden\n" });
    }
    expect(calls).toEqual([]);
  });

  it("refuses a foreign Host even with a valid token", async () => {
    expect(await send("/trpc/board", { Host: `evil.example:${port}`, ...bearer() })).toMatchObject({ status: 403, body: "Forbidden\n" });
    expect(calls).toEqual([]);
    expect(verified).toBe(0);
  });

  it("refuses a write from a foreign Origin with 403", async () => {
    expect(await send("/trpc/reviewDecision", { Host: `localhost:${port}`, Origin: "http://evil.example" }, "POST")).toMatchObject({ status: 403, body: "Forbidden\n" });
    expect(calls).toEqual([]);
  });

  it("refuses an absolute-form request target naming another host, and never routes one to the image handler", async () => {
    expect(await send(`http://evil.example:${port}/review-images/a.png`, { Host: `evil.example:${port}` })).toMatchObject({ status: 403, body: "Forbidden\n" });
    expect(await send(`http://127.0.0.1:${port}/review-images/a.png`, { Host: `127.0.0.1:${port}` })).toMatchObject({ status: 200, body: "trpc" });
    expect(calls).toEqual([`trpc http://127.0.0.1:${port}/review-images/a.png client=null`]);
  });

  it("sends a loopback request under /review-images/ to the image route and anything else to tRPC", async () => {
    expect(await send("/review-images/rv/r1/a.png", { Host: `127.0.0.1:${port}` })).toMatchObject({ status: 200, body: "image" });
    expect(await send("/trpc/board", { Host: `localhost:${port}` })).toMatchObject({ status: 200, body: "trpc" });
    expect(calls).toEqual(["images /review-images/rv/r1/a.png client=null", "trpc /trpc/board client=null"]);
  });

  it("admits the Vite dev proxy's write: loopback Host (changeOrigin) and a localhost Origin on another port, with no token", async () => {
    expect(await send("/trpc/createNote", { Host: `127.0.0.1:${port}`, Origin: "http://localhost:5310" }, "POST")).toMatchObject({ status: 200, body: "trpc" });
    expect(calls).toEqual(["trpc /trpc/createNote client=null"]);
    expect(verified).toBe(0);
  });

  it("never calls the token store for a loopback request, even one carrying a token", async () => {
    await send("/trpc/board", { Host: `localhost:${port}` });
    await send("/trpc/board", { Host: `[::1]:${port}`, ...bearer() });
    await send("/trpc/createNote", { Host: `127.0.0.1:${port}`, ...cookie() }, "POST");
    expect(verified).toBe(0);
    expect(calls).toEqual(["trpc /trpc/board client=null", "trpc /trpc/board client=null", "trpc /trpc/createNote client=null"]);
  });
});

describe("createRequestDispatcher: client tokens", () => {
  it("refuses a tailnet Host with no credential with 401 and WWW-Authenticate, before any handler", async () => {
    for (const path of ["/trpc/board", "/review-images/rv/r1/a.png"]) {
      const sent = await send(path, { Host: tailnetHost() });
      expect(sent).toMatchObject({ status: 401, body: "Unauthorized\n" });
      expect(sent.headers).toMatchObject({ "www-authenticate": "Bearer", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    }
    expect(calls).toEqual([]);
  });

  it("refuses an unknown token exactly as a missing one", async () => {
    const sent = await send("/trpc/board", { Host: tailnetHost(), ...bearer("bdt_unknown") });
    expect(sent).toMatchObject({ status: 401, body: "Unauthorized\n" });
    expect(sent.headers["www-authenticate"]).toBe("Bearer");
    expect(calls).toEqual([]);
  });

  it("hands a bearer token's client to tRPC and to the image route", async () => {
    expect(await send("/trpc/board", { Host: tailnetHost(), ...bearer() })).toMatchObject({ status: 200, body: "trpc" });
    expect(await send("/review-images/rv/r1/a.png", { Host: tailnetHost(), ...bearer() })).toMatchObject({ status: 200, body: "image" });
    expect(calls).toEqual(["trpc /trpc/board client=phone", "images /review-images/rv/r1/a.png client=phone"]);
  });

  it("admits a GET carrying only the cookie", async () => {
    expect(await send("/trpc/board", { Host: tailnetHost(), ...cookie() })).toMatchObject({ status: 200, body: "trpc" });
    expect(calls).toEqual(["trpc /trpc/board client=phone"]);
  });

  it("refuses a cross-site POST carrying the cookie with 403, and calls nothing", async () => {
    expect(await send("/trpc/createNote", { Host: tailnetHost(), Origin: "http://evil.example", ...cookie() }, "POST")).toMatchObject({ status: 403, body: "Forbidden\n" });
    expect(calls).toEqual([]);
    expect(verified).toBe(0);
  });

  it("refuses a cookie POST with no Origin with 403", async () => {
    expect(await send("/trpc/createNote", { Host: tailnetHost(), ...cookie() }, "POST")).toMatchObject({ status: 403, body: "Forbidden\n" });
    expect(calls).toEqual([]);
  });

  it("admits a cookie POST from an allowed Origin", async () => {
    expect(await send("/trpc/createNote", { Host: tailnetHost(), Origin: `http://${tailnetHost()}`, ...cookie() }, "POST")).toMatchObject({ status: 200, body: "trpc" });
    expect(calls).toEqual(["trpc /trpc/createNote client=phone"]);
  });

  it("admits a bearer POST with no Origin (a script, not a browser)", async () => {
    expect(await send("/trpc/createNote", { Host: tailnetHost(), ...bearer() }, "POST")).toMatchObject({ status: 200, body: "trpc" });
    expect(calls).toEqual(["trpc /trpc/createNote client=phone"]);
  });

  it("treats a token in the query string as no token", async () => {
    expect(await send(`/trpc/board?token=${PHONE_TOKEN}`, { Host: tailnetHost() })).toMatchObject({ status: 401 });
    expect(calls).toEqual([]);
    expect(verified).toBe(0);
  });

  it("lets POST /auth/connect through with no credential, but not a GET", async () => {
    expect(await send("/auth/connect", { Host: tailnetHost(), Origin: `http://${tailnetHost()}` }, "POST")).toMatchObject({ status: 200, body: "connect" });
    expect(await send("/auth/connect", { Host: tailnetHost() })).toMatchObject({ status: 401 });
    expect(calls).toEqual(["connect POST /auth/connect"]);
  });

  it("does not treat a different spelling of the connect path as public", async () => {
    for (const path of ["/auth/connect/", "//auth/connect", "/auth/./connect", "/AUTH/connect"]) {
      expect(await send(path, { Host: tailnetHost(), Origin: `http://${tailnetHost()}` }, "POST")).toMatchObject({ status: 401 });
    }
    expect(calls).toEqual([]);
  });

  it("answers 500 and calls no handler when the token store throws", async () => {
    expect(await send("/trpc/board", { Host: tailnetHost(), ...bearer(THROWING_TOKEN) })).toMatchObject({ status: 500, body: "Internal Server Error\n" });
    expect(calls).toEqual([]);
  });
});
