// The built client route (tailnet-hosting task 2.1) over real HTTP, from a
// throwaway build directory beside a sibling standing in for "everywhere
// else", so a symlink out has a real file to reach if the walk followed it.

import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { CLIENT_CSP, createStaticClientHandler, loadClientManifest } from "./static-client.js";

const INDEX = "<!doctype html><title>board</title>";
const SCRIPT = "console.log('board');";

let base: string;
let dist: string;
let server: Server;
let port: number;

beforeAll(async () => {
  base = await realpath(await mkdtemp(path.join(os.tmpdir(), "static-client-")));
  dist = path.join(base, "dist");
  const outside = path.join(base, "outside");
  await mkdir(path.join(dist, "assets"), { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(dist, "index.html"), INDEX);
  await writeFile(path.join(dist, "favicon.svg"), "<svg/>");
  await writeFile(path.join(dist, "assets", "index-Abc123.js"), SCRIPT);
  await writeFile(path.join(dist, "assets", "index-Def456.css"), "body{}");
  await writeFile(path.join(outside, "secret.js"), "secret");
  await symlink(path.join(outside, "secret.js"), path.join(dist, "assets", "leak.js"));
  await symlink(outside, path.join(dist, "linked"));

  const handler = createStaticClientHandler(await loadClientManifest(dist));
  server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(base, { recursive: true, force: true });
});

interface Sent {
  status: number;
  body: string;
  headers: IncomingHttpHeaders;
}

function send(urlPath: string, method = "GET"): Promise<Sent> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: urlPath, method }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("createStaticClientHandler", () => {
  it("answers the root, a client route, and a query with index.html, no-cache", async () => {
    for (const urlPath of ["/", "/index.html", "/board/tides", "/board/tides?item=x-1", "/x/../trpc/a"]) {
      const sent = await send(urlPath);
      expect(sent, urlPath).toMatchObject({ status: 200, body: INDEX });
      expect(sent.headers).toMatchObject({ "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", "x-content-type-options": "nosniff" });
    }
  });

  it("serves a hashed asset immutable, with its type and length", async () => {
    const js = await send("/assets/index-Abc123.js?v=1");
    expect(js).toMatchObject({ status: 200, body: SCRIPT });
    expect(js.headers).toMatchObject({
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "public, max-age=31536000, immutable",
      "content-length": String(SCRIPT.length),
      "x-content-type-options": "nosniff",
    });
    expect((await send("/assets/index-Def456.css")).headers["content-type"]).toBe("text/css; charset=utf-8");
  });

  it("serves a file outside /assets/ with no-cache", async () => {
    const svg = await send("/favicon.svg");
    expect(svg).toMatchObject({ status: 200, body: "<svg/>" });
    expect(svg.headers).toMatchObject({ "content-type": "image/svg+xml", "cache-control": "no-cache" });
  });

  it("sends the anti-framing headers and the policy on every response", async () => {
    for (const [urlPath, method] of [["/", "GET"], ["/board/tides", "GET"], ["/assets/index-Abc123.js", "GET"], ["/favicon.svg", "HEAD"], ["/missing.css", "GET"], ["/", "POST"]] as const) {
      const sent = await send(urlPath, method);
      expect(sent.headers, `${method} ${urlPath}`).toMatchObject({ "x-frame-options": "DENY", "content-security-policy": CLIENT_CSP });
    }
    expect(CLIENT_CSP).toContain("frame-ancestors 'none'");
  });

  it("answers 404 for a missing file with an extension, never index.html", async () => {
    for (const urlPath of ["/assets/missing.js", "/missing.css", "/assets/%2e%2e/index.html", "/x/../index.html"]) {
      const sent = await send(urlPath);
      expect(sent, urlPath).toMatchObject({ status: 404, body: "Not found\n" });
      expect(sent.headers["x-content-type-options"]).toBe("nosniff");
    }
  });

  it("refuses anything but GET and HEAD with 405", async () => {
    for (const method of ["POST", "PUT", "DELETE"]) {
      const sent = await send("/", method);
      expect(sent.status).toBe(405);
      expect(sent.headers["allow"]).toBe("GET, HEAD");
    }
  });

  it("answers HEAD with the headers and no body", async () => {
    const index = await send("/", "HEAD");
    expect(index).toMatchObject({ status: 200, body: "" });
    expect(index.headers["content-length"]).toBe(String(INDEX.length));
    const js = await send("/assets/index-Abc123.js", "HEAD");
    expect(js).toMatchObject({ status: 200, body: "" });
    expect(js.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
  });

  it("never serves a symlink out of the directory", async () => {
    expect(await send("/assets/leak.js")).toMatchObject({ status: 404 });
    expect(await send("/linked/secret.js")).toMatchObject({ status: 404 });
  });
});

describe("loadClientManifest", () => {
  it("leaves symlinks out of the manifest", async () => {
    const manifest = await loadClientManifest(dist);
    expect([...manifest.keys()].sort()).toEqual(["/assets/index-Abc123.js", "/assets/index-Def456.css", "/favicon.svg", "/index.html"]);
  });

  it("throws naming the directory when index.html is missing", async () => {
    const empty = path.join(base, "empty");
    await mkdir(empty);
    await expect(loadClientManifest(empty)).rejects.toThrow(`client directory ${empty} has no index.html`);
  });

  it("throws naming the directory when it does not exist", async () => {
    const gone = path.join(base, "gone");
    await expect(loadClientManifest(gone)).rejects.toThrow(`client directory ${gone} could not be read`);
  });
});

describe("CLIENT_CSP", () => {
  const directives = (policy: string): Map<string, string[]> =>
    new Map(
      policy
        .split(";")
        .map((part) => part.trim().split(/\s+/))
        .filter((words) => words[0] !== "")
        .map(([name, ...sources]) => [name!, sources]),
    );

  it("is index.html's meta policy with 'unsafe-inline' dropped from script-src only", async () => {
    const html = await readFile(fileURLToPath(new URL("../index.html", import.meta.url)), "utf8");
    const meta = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1];
    expect(meta).toBeDefined();
    const expected = directives(meta!);
    expected.set("script-src", expected.get("script-src")!.filter((source) => source !== "'unsafe-inline'"));
    expect(directives(CLIENT_CSP)).toEqual(expected);
    expect(directives(CLIENT_CSP).get("style-src")).toContain("'unsafe-inline'");
  });
});
