// The web /healthz handler (tailnet-hosting task 2.1) against stand-in
// pools: a database that answers, one that refuses, one that never answers.

import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createHealthHandler } from "./health.js";

let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

async function serve(query: () => Promise<unknown>, timeoutMs?: number): Promise<number> {
  const handler = createHealthHandler({ query } as never, timeoutMs);
  server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

function send(port: number, method = "GET"): Promise<{ status: number; body: string; headers: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/healthz", method }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("createHealthHandler", () => {
  it("answers 200 {ready:true}, no-store, when select 1 succeeds", async () => {
    const queries: unknown[] = [];
    const port = await serve(async (...args: unknown[]) => {
      queries.push(args[0]);
      return { rows: [] };
    });
    const sent = await send(port);
    expect(sent.status).toBe(200);
    expect(JSON.parse(sent.body)).toEqual({ ready: true });
    expect(sent.headers).toMatchObject({ "content-type": "application/json", "cache-control": "no-store" });
    expect(queries).toEqual(["select 1"]);
    expect(await send(port, "HEAD")).toMatchObject({ status: 200, body: "" });
  });

  it("answers 503 with the error when the query rejects", async () => {
    const port = await serve(async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:5432");
    });
    const sent = await send(port);
    expect(sent.status).toBe(503);
    expect(JSON.parse(sent.body)).toEqual({ ready: false, error: "connect ECONNREFUSED 127.0.0.1:5432" });
    expect(sent.headers["cache-control"]).toBe("no-store");
  });

  it("answers 503 when the database never answers, after the timeout", async () => {
    const port = await serve(() => new Promise(() => {}), 50);
    const started = Date.now();
    const sent = await send(port);
    expect(sent.status).toBe(503);
    expect(JSON.parse(sent.body)).toEqual({ ready: false, error: "database did not answer within 50ms" });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("refuses other methods with 405", async () => {
    const port = await serve(async () => ({}));
    const sent = await send(port, "POST");
    expect(sent.status).toBe(405);
    expect(sent.headers["allow"]).toBe("GET, HEAD");
  });
});
