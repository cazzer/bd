// The connect endpoint on its own: what it answers, and exactly what cookie
// it sets. Over real HTTP from a loopback peer for most cases; the
// non-loopback-peer and TLS-socket cases drive the handler directly with a
// stand-in request, since a test cannot make the kernel report another
// peer address. Admission in front of it is dispatch.test.ts's concern.

import { createServer, request, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createConnectHandler, MAX_CONNECT_BODY_BYTES } from "./auth-connect.js";

const TOKEN = "bdt_AbC-123_xyz";
const AGENT_TOKEN = "bdt_worker-token";
const verifyToken = async (token: string) =>
  token === TOKEN ? { client: "phone", scope: "human" as const } : token === AGENT_TOKEN ? { client: "worker-1", scope: "agent" as const } : null;
const handler = createConnectHandler({ verifyToken });
const COOKIE = `breakdown_token=${TOKEN}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`;

let server: Server;
let port: number;

beforeAll(async () => {
  server = createServer((req, res) => {
    handler(req, res).catch((err: unknown) => {
      res.writeHead(500).end(String(err));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface Sent {
  status: number;
  body: string;
  headers: IncomingHttpHeaders;
}

function send(options: { method?: string; headers?: Record<string, string>; body?: string }): Promise<Sent> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/auth/connect", method: options.method ?? "POST", headers: options.headers ?? {} }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on("error", reject);
    req.end(options.body);
  });
}

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  headers: { "Content-Type": "application/json", ...headers },
  body: JSON.stringify(body),
});

describe("POST /auth/connect", () => {
  it("answers a valid token with 204 and exactly the cookie, without Secure over plain HTTP", async () => {
    const sent = await send(json({ token: TOKEN }));
    expect(sent.status).toBe(204);
    expect(sent.body).toBe("");
    expect(sent.headers["set-cookie"]).toEqual([COOKIE]);
  });

  it("accepts a charset parameter on the JSON content type", async () => {
    const sent = await send(json({ token: TOKEN }, { "Content-Type": "application/json; charset=utf-8" }));
    expect(sent.status).toBe(204);
  });

  it("adds Secure when a loopback peer says the request came in over HTTPS", async () => {
    const sent = await send(json({ token: TOKEN }, { "X-Forwarded-Proto": "https" }));
    expect(sent.status).toBe(204);
    expect(sent.headers["set-cookie"]).toEqual([`${COOKIE}; Secure`]);
  });

  it("refuses an unknown token with 401 and WWW-Authenticate, setting no cookie and echoing nothing", async () => {
    const sent = await send(json({ token: "bdt_wrong" }));
    expect(sent.status).toBe(401);
    expect(sent.headers["www-authenticate"]).toBe("Bearer");
    expect(sent.headers["set-cookie"]).toBeUndefined();
    expect(sent.body).not.toContain("bdt_wrong");
  });

  it("refuses an agent token with 401, setting no cookie", async () => {
    const sent = await send(json({ token: AGENT_TOKEN }));
    expect(sent.status).toBe(401);
    expect(sent.headers["www-authenticate"]).toBe("Bearer");
    expect(sent.headers["set-cookie"]).toBeUndefined();
    expect(sent.body).not.toContain(AGENT_TOKEN);
  });

  it("refuses a value that could not sit in a cookie without consulting the store", async () => {
    let called = false;
    const guarded = createConnectHandler({
      verifyToken: async () => {
        called = true;
        return { client: "phone", scope: "human" as const };
      },
    });
    const res = fakeResponse();
    await guarded(fakeRequest({ body: JSON.stringify({ token: "x; Path=/evil" }) }), res as unknown as ServerResponse);
    expect(res.status).toBe(401);
    expect(res.headers["Set-Cookie"]).toBeUndefined();
    expect(called).toBe(false);
  });

  it("answers any other method 405 with Allow: POST", async () => {
    for (const method of ["GET", "PUT", "DELETE"]) {
      const sent = await send({ method });
      expect(sent.status).toBe(405);
      expect(sent.headers["allow"]).toBe("POST");
    }
  });

  it("answers a non-JSON body type 415", async () => {
    expect((await send({ headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `token=${TOKEN}` })).status).toBe(415);
    expect((await send({ body: JSON.stringify({ token: TOKEN }) })).status).toBe(415);
  });

  it("answers a body over the cap 413", async () => {
    const sent = await send(json({ token: TOKEN, pad: "x".repeat(MAX_CONNECT_BODY_BYTES) }));
    expect(sent.status).toBe(413);
    expect(sent.headers["set-cookie"]).toBeUndefined();
  });

  it("answers a chunked body over the cap 413 (no declared length)", async () => {
    const res = fakeResponse();
    await handler(fakeRequest({ body: JSON.stringify({ token: TOKEN, pad: "x".repeat(MAX_CONNECT_BODY_BYTES) }) }), res as unknown as ServerResponse);
    expect(res.status).toBe(413);
  });

  it("answers a malformed or wrong-shaped body 400", async () => {
    for (const body of ["{not json", "[]", "null", JSON.stringify({}), JSON.stringify({ token: 42 }), JSON.stringify({ token: "" })]) {
      const sent = await send({ headers: { "Content-Type": "application/json" }, body });
      expect(sent.status, body).toBe(400);
      expect(sent.headers["set-cookie"]).toBeUndefined();
    }
  });
});

describe("POST /auth/connect: Secure from a stand-in request", () => {
  it("ignores x-forwarded-proto from a non-loopback peer", async () => {
    const res = fakeResponse();
    await handler(fakeRequest({ remoteAddress: "100.101.102.103", headers: { "x-forwarded-proto": "https" } }), res as unknown as ServerResponse);
    expect(res.status).toBe(204);
    expect(res.headers["Set-Cookie"]).toBe(COOKIE);
  });

  it("sets Secure on a TLS socket from any peer", async () => {
    const res = fakeResponse();
    await handler(fakeRequest({ remoteAddress: "100.101.102.103", encrypted: true }), res as unknown as ServerResponse);
    expect(res.status).toBe(204);
    expect(res.headers["Set-Cookie"]).toBe(`${COOKIE}; Secure`);
  });
});

function fakeRequest(options: { remoteAddress?: string; encrypted?: boolean; headers?: Record<string, string>; body?: string }): IncomingMessage {
  const stream = Readable.from([Buffer.from(options.body ?? JSON.stringify({ token: TOKEN }))]);
  return Object.assign(stream, {
    method: "POST",
    headers: { "content-type": "application/json", ...options.headers },
    socket: { remoteAddress: options.remoteAddress ?? "127.0.0.1", ...(options.encrypted ? { encrypted: true } : {}) },
  }) as unknown as IncomingMessage;
}

function fakeResponse() {
  const res = {
    status: 0,
    headers: {} as Record<string, string>,
    body: "",
    headersSent: false,
    writeHead(status: number, headers: Record<string, string> = {}) {
      res.status = status;
      res.headers = headers;
      res.headersSent = true;
      return res;
    },
    end(body?: string) {
      res.body = body ?? "";
      return res;
    },
  };
  return res;
}
