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

import { createServer, request, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { admittedClients } from "./context.js";
import { createRequestDispatcher } from "./dispatch.js";

const TAILNET = "breakdown.tail.example";
const PHONE_TOKEN = "bdt_phone-token";
const WORKER_TOKEN = "bdt_worker-token";
const THROWING_TOKEN = "bdt_throws";

let server: Server;
let port: number;
let calls: string[];
let verified: number;

/** A server whose dispatcher's handlers record the call; with `withStatic`, the built client is configured too. */
async function startDispatcher(withStatic: boolean): Promise<{ server: Server; port: number }> {
  let dispatch: ReturnType<typeof createRequestDispatcher> | null = null;
  const srv = createServer((req, res) => dispatch!(req, res));
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const listening = (srv.address() as AddressInfo).port;
  dispatch = createRequestDispatcher({
    port: listening,
    allowedHosts: [TAILNET],
    verifyToken: async (token) => {
      verified += 1;
      if (token === THROWING_TOKEN) throw new Error("token store unavailable");
      if (token === WORKER_TOKEN) return { client: "worker-1", scope: "agent" };
      return token === PHONE_TOKEN ? { client: "phone", scope: "human" } : null;
    },
    connect: async (req, res) => {
      calls.push(`connect ${req.method} ${req.url}`);
      res.end("connect");
    },
    health: async (req, res) => {
      calls.push(`health ${req.method} ${req.url} client=${admittedClients.get(req) ?? null}`);
      res.end("health");
    },
    reviewImages: async (req, res) => {
      calls.push(`images ${req.url} client=${admittedClients.get(req) ?? null}`);
      res.end("image");
    },
    trpc: (req, res) => {
      calls.push(`trpc ${req.url} client=${admittedClients.get(req) ?? null}`);
      res.end("trpc");
    },
    ...(withStatic
      ? {
          staticClient: async (req: IncomingMessage, res: ServerResponse) => {
            calls.push(`static ${req.method} ${req.url}`);
            res.end("static");
          },
        }
      : {}),
  });
  return { server: srv, port: listening };
}

let staticServer: Server;
let staticPort: number;

beforeAll(async () => {
  ({ server, port } = await startDispatcher(false));
  ({ server: staticServer, port: staticPort } = await startDispatcher(true));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => staticServer.close(() => resolve()));
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
function send(path: string, headers: Record<string, string>, method = "GET", to = port): Promise<Sent> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: to, path, method, headers }, (res) => {
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

  it("admits a bare allowed Host (a fronting proxy on its default port) with a token", async () => {
    expect(await send("/trpc/board", { Host: TAILNET, ...bearer() })).toMatchObject({ status: 200, body: "trpc" });
    expect(await send("/trpc/board", { Host: TAILNET })).toMatchObject({ status: 401 });
    expect(await send("/trpc/board", { Host: "localhost" })).toMatchObject({ status: 403 });
    expect(calls).toEqual(["trpc /trpc/board client=phone"]);
  });

  it("refuses a cookie write whose Origin is another port on the allowed host", async () => {
    expect(await send("/trpc/createNote", { Host: tailnetHost(), Origin: `http://${TAILNET}:8080`, ...cookie() }, "POST")).toMatchObject({ status: 403 });
    expect(calls).toEqual([]);
  });

  it("keeps loopback trust for the Vite proxy's forwarded request (X-Forwarded-For: 127.0.0.1)", async () => {
    expect(await send("/trpc/createNote", { Host: `127.0.0.1:${port}`, Origin: "http://localhost:5310", "X-Forwarded-For": "127.0.0.1" }, "POST")).toMatchObject({
      status: 200,
      body: "trpc",
    });
    expect(calls).toEqual(["trpc /trpc/createNote client=null"]);
  });

  it("requires a token for a loopback-Host request forwarded for a remote address", async () => {
    const headers: Record<string, string>[] = [{ "X-Forwarded-For": "100.64.0.9" }, { "X-Real-IP": "100.64.0.9" }, { Forwarded: "for=unknown" }];
    for (const header of headers) {
      expect(await send("/trpc/board", { Host: `127.0.0.1:${port}`, ...header }), JSON.stringify(header)).toMatchObject({ status: 401 });
      expect(await send("/trpc/board", { Host: `127.0.0.1:${port}`, ...header, ...bearer() })).toMatchObject({ status: 200, body: "trpc" });
    }
    expect(calls).toEqual(Array(3).fill("trpc /trpc/board client=phone"));
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

  it("refuses an agent token with 403, by bearer or cookie, and calls nothing", async () => {
    expect(await send("/trpc/board", { Host: tailnetHost(), ...bearer(WORKER_TOKEN) })).toMatchObject({ status: 403, body: "Forbidden\n" });
    expect(await send("/trpc/createNote", { Host: tailnetHost(), Origin: `http://${tailnetHost()}`, ...cookie(WORKER_TOKEN) }, "POST")).toMatchObject({ status: 403 });
    expect(calls).toEqual([]);
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

describe("createRequestDispatcher: health", () => {
  it("routes /healthz to the health handler, which needs a token off loopback", async () => {
    expect(await send("/healthz", { Host: `127.0.0.1:${port}` })).toMatchObject({ status: 200, body: "health" });
    expect(await send("/healthz", { Host: tailnetHost() })).toMatchObject({ status: 401 });
    expect(await send("/healthz", { Host: tailnetHost(), ...bearer() })).toMatchObject({ status: 200, body: "health" });
    expect(await send("/healthz", { Host: tailnetHost(), ...bearer(WORKER_TOKEN) })).toMatchObject({ status: 403 });
    expect(calls).toEqual(["health GET /healthz client=null", "health GET /healthz client=phone"]);
  });

  it("without a built client, GET / off loopback still needs a token and goes to tRPC", async () => {
    expect(await send("/", { Host: tailnetHost() })).toMatchObject({ status: 401 });
    expect(await send("/", { Host: tailnetHost(), ...bearer() })).toMatchObject({ status: 200, body: "trpc" });
    expect(calls).toEqual(["trpc / client=phone"]);
  });
});

describe("createRequestDispatcher: the built client", () => {
  const host = (): string => `${TAILNET}:${staticPort}`;
  const toStatic = (path: string, headers: Record<string, string>, method = "GET") => send(path, headers, method, staticPort);

  it("serves the client off loopback with no token, GET and HEAD", async () => {
    expect(await toStatic("/", { Host: host() })).toMatchObject({ status: 200, body: "static" });
    expect(await toStatic("/assets/index-Abc123.js", { Host: host() })).toMatchObject({ status: 200, body: "static" });
    expect(await toStatic("/board/tides?item=x", { Host: host() }, "HEAD")).toMatchObject({ status: 200 });
    expect(calls).toEqual(["static GET /", "static GET /assets/index-Abc123.js", "static HEAD /board/tides?item=x"]);
    expect(verified).toBe(0);
  });

  it("still refuses every data path with no token", async () => {
    for (const path of ["/trpc", "/trpc/board", "/review-images/a.png", "/healthz"]) {
      expect(await toStatic(path, { Host: host() }), path).toMatchObject({ status: 401 });
    }
    expect(calls).toEqual([]);
  });

  it("routes /healthz with a human token to the health handler", async () => {
    expect(await toStatic("/healthz", { Host: host(), ...bearer() })).toMatchObject({ status: 200, body: "health" });
    expect(calls).toEqual(["health GET /healthz client=phone"]);
  });

  it("does not make a write to a client path public", async () => {
    expect(await toStatic("/", { Host: host(), Origin: `http://${host()}` }, "POST")).toMatchObject({ status: 401 });
    expect(calls).toEqual([]);
  });

  it("refuses a foreign Host on the client with 403", async () => {
    expect(await toStatic("/", { Host: `evil.example:${staticPort}` })).toMatchObject({ status: 403 });
    expect(calls).toEqual([]);
  });

  it("classifies a path that only normalizes to tRPC as client, never calling tRPC", async () => {
    for (const path of ["/x/../trpc/a", "/%74rpc/a", "//trpc/a", "/trpcx"]) {
      expect(await toStatic(path, { Host: host() }), path).toMatchObject({ status: 200, body: "static" });
    }
    expect(calls.every((c) => c.startsWith("static "))).toBe(true);
    expect(calls).toHaveLength(4);
  });

  it("keeps the connect endpoint as before: POST public, GET not", async () => {
    expect(await toStatic("/auth/connect", { Host: host(), Origin: `http://${host()}` }, "POST")).toMatchObject({ status: 200, body: "connect" });
    expect(await toStatic("/auth/connect", { Host: host() })).toMatchObject({ status: 401 });
    expect(calls).toEqual(["connect POST /auth/connect"]);
  });

  it("serves the client to a loopback request too", async () => {
    expect(await toStatic("/", { Host: `localhost:${staticPort}` })).toMatchObject({ status: 200, body: "static" });
    expect(await toStatic("/trpc/board", { Host: `localhost:${staticPort}` })).toMatchObject({ status: 200, body: "trpc" });
    expect(calls).toEqual(["static GET /", "trpc /trpc/board client=null"]);
  });
});
