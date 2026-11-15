// The review media upload route (remote-review-media, tasks.md 2.3) over
// real HTTP on a throwaway root, beside a sibling "outside" directory so
// every escape has somewhere real to land if a check were missing.

import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer, request, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createReviewUploadHandler, MAX_REVIEW_UPLOAD_BYTES, parseUploadTarget } from "./review-uploads.js";

let base: string;
let root: string;
let outside: string;
const servers: Server[] = [];

beforeAll(async () => {
  base = await realpath(await mkdtemp(path.join(os.tmpdir(), "review-uploads-")));
  root = path.join(base, "reviews");
  outside = path.join(base, "outside");
  await mkdir(root);
  await mkdir(outside);
});

afterAll(async () => {
  for (const s of servers) await new Promise<void>((resolve) => s.close(() => resolve()));
  await rm(base, { recursive: true, force: true });
});

async function serve(options: Parameters<typeof createReviewUploadHandler>[0] = {}): Promise<number> {
  const handler = createReviewUploadHandler({ root, minFreeBytes: 0, ...options });
  const srv = createServer((req: IncomingMessage, res: ServerResponse) => void handler(req, res));
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  servers.push(srv);
  return (srv.address() as AddressInfo).port;
}

interface Sent {
  status: number;
  body: string;
  headers: IncomingMessage["headers"];
}

/** One request; `chunks` are written one by one (chunked unless a content-length header is given). Resolves on the response, ignoring a write error after it. */
function send(port: number, method: string, urlPath: string, headers: Record<string, string> = {}, chunks: Buffer[] = []): Promise<Sent> {
  return new Promise((resolve, reject) => {
    let answered = false;
    const req = request({ host: "127.0.0.1", port, method, path: urlPath, headers }, (res) => {
      answered = true;
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on("error", (err) => {
      if (!answered) reject(err);
    });
    for (const c of chunks) req.write(c);
    req.end();
  });
}

const PNG = Buffer.from("89504e470d0a1a0a", "hex");
const png = { "content-type": "image/png" };

describe("parseUploadTarget", () => {
  it.each([
    ["GET", "/review-uploads/p/i/r/01-a.png", 405],
    ["PUT", "/review-uploads/p/i/r", 405],
    ["DELETE", "/review-uploads/p/i/r/01-a.png", 405],
    ["PUT", "/review-uploads/p/i/r/a/01-a.png", 405],
    ["PUT", "/review-uploads/../i/r/01-a.png", 400],
    ["PUT", "/review-uploads/p/%2e%2e/r/01-a.png", 400],
    ["PUT", "/review-uploads/p/i/r/.a.png", 400],
    ["PUT", "/review-uploads/p//r/01-a.png", 400],
    ["PUT", "/review-uploads/p/i/r/01 a.png", 400],
    ["PUT", `/review-uploads/p/i/r/${"a".repeat(252)}.png`, 400],
    ["DELETE", "/review-uploads/p/i/..", 400],
    ["PUT", "/review-uploads/p/i/r/01-a.mov", 415],
    ["PUT", "/review-uploads/p/i/r/01-a", 415],
  ])("%s %s → %i", (method, rawPath, status) => {
    expect(parseUploadTarget(method, rawPath)).toMatchObject({ ok: false, status });
  });

  it("accepts a PUT of a file and a DELETE of a run", () => {
    expect(parseUploadTarget("PUT", "/review-uploads/bd/bd-1/0a1b/01-reel.MP4")).toEqual({ ok: true, method: "PUT", segments: ["bd", "bd-1", "0a1b", "01-reel.MP4"], contentType: "video/mp4" });
    expect(parseUploadTarget("DELETE", "/review-uploads/bd/bd-1/0a1b")).toEqual({ ok: true, method: "DELETE", segments: ["bd", "bd-1", "0a1b"] });
  });
});

describe("createReviewUploadHandler: PUT", () => {
  it("writes the file with modes 0644/0755, leaves no tmp file, and a re-PUT replaces it", async () => {
    const port = await serve();
    expect(await send(port, "PUT", "/review-uploads/p1/i1/r1/01-a.png", { ...png, "content-length": String(PNG.length) }, [PNG])).toMatchObject({ status: 204 });
    const dir = path.join(root, "p1", "i1", "r1");
    expect(await readFile(path.join(dir, "01-a.png"))).toEqual(PNG);
    expect((await stat(path.join(dir, "01-a.png"))).mode & 0o777).toBe(0o644);
    expect((await stat(dir)).mode & 0o777).toBe(0o755);
    expect(await send(port, "PUT", "/review-uploads/p1/i1/r1/01-a.png", { "content-type": "image/png; charset=binary" }, [Buffer.from("x"), Buffer.from("y")])).toMatchObject({ status: 204 });
    expect(await readFile(path.join(dir, "01-a.png"), "utf8")).toBe("xy");
    expect(await readdir(dir)).toEqual(["01-a.png"]);
  });

  it("refuses an over-cap Content-Length with 413 before creating anything", async () => {
    const port = await serve({ maxBytes: 4 });
    const sent = await send(port, "PUT", "/review-uploads/p2/i/r/01-a.png", { ...png, "content-length": "5" }, [Buffer.from("12345")]);
    expect(sent).toMatchObject({ status: 413 });
    expect(sent.headers.connection).toBe("close");
    await expect(lstat(path.join(root, "p2"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a chunked body past the cap with 413, keeping no file and no tmp", async () => {
    const port = await serve({ maxBytes: 10 });
    const chunk = Buffer.alloc(8, 1);
    expect(await send(port, "PUT", "/review-uploads/p3/i/r/01-a.png", png, [chunk, chunk, chunk])).toMatchObject({ status: 413 });
    expect(await readdir(path.join(root, "p3", "i", "r"))).toEqual([]);
  });

  it("refuses a Content-Type that is not the extension's with 415", async () => {
    const port = await serve();
    expect(await send(port, "PUT", "/review-uploads/p4/i/r/01-a.png", { "content-type": "image/jpeg" }, [PNG])).toMatchObject({ status: 415 });
    expect(await send(port, "PUT", "/review-uploads/p4/i/r/01-a.png", {}, [PNG])).toMatchObject({ status: 415 });
  });

  it("refuses a project directory symlinked outside the root with 403, making nothing through it", async () => {
    const port = await serve();
    await symlink(outside, path.join(root, "p5"));
    expect(await send(port, "PUT", "/review-uploads/p5/i/r/01-a.png", png, [PNG])).toMatchObject({ status: 403 });
    expect(await readdir(outside)).toEqual([]);
  });

  it("refuses a legacy file in the way with 409", async () => {
    const port = await serve();
    await mkdir(path.join(root, "p6"));
    await writeFile(path.join(root, "p6", "i"), "legacy");
    expect(await send(port, "PUT", "/review-uploads/p6/i/r/01-a.png", png, [PNG])).toMatchObject({ status: 409 });
    expect(await readFile(path.join(root, "p6", "i"), "utf8")).toBe("legacy");
  });

  it("answers 503 with Retry-After past maxConcurrent", async () => {
    const port = await serve({ maxConcurrent: 1 });
    let finish!: () => void;
    const held = new Promise<Sent>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, method: "PUT", path: "/review-uploads/p7/i/r/01-a.png", headers: png }, (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: "", headers: res.headers }));
      });
      req.on("error", reject);
      req.write(PNG);
      finish = () => req.end();
    });
    const dir = path.join(root, "p7", "i", "r");
    for (let i = 0; i < 200; i++) {
      const names = await readdir(dir).catch(() => [] as string[]);
      if (names.some((n) => n.endsWith(".tmp"))) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const busy = await send(port, "PUT", "/review-uploads/p7/i/r/02-b.png", png, [PNG]);
    expect(busy).toMatchObject({ status: 503 });
    expect(busy.headers["retry-after"]).toBe("1");
    finish();
    expect((await held).status).toBe(204);
  });

  it("answers GET with 405 and Allow", async () => {
    const port = await serve();
    const sent = await send(port, "GET", "/review-uploads/p/i/r/01-a.png");
    expect(sent).toMatchObject({ status: 405 });
    expect(sent.headers.allow).toBe("PUT, DELETE");
  });

  it("answers 507 when free space would fall under minFreeBytes", async () => {
    const port = await serve({ minFreeBytes: Number.MAX_SAFE_INTEGER });
    expect(await send(port, "PUT", "/review-uploads/p8/i/r/01-a.png", png, [PNG])).toMatchObject({ status: 507 });
  });
});

describe("createReviewUploadHandler: DELETE", () => {
  it("removes a run, and answers 204 for one that is missing", async () => {
    const port = await serve();
    await mkdir(path.join(root, "d1", "i", "r"), { recursive: true });
    await writeFile(path.join(root, "d1", "i", "r", "01-a.png"), PNG);
    expect(await send(port, "DELETE", "/review-uploads/d1/i/r")).toMatchObject({ status: 204 });
    expect(await readdir(path.join(root, "d1", "i"))).toEqual([]);
    expect(await send(port, "DELETE", "/review-uploads/d1/i/r")).toMatchObject({ status: 204 });
    expect(await send(port, "DELETE", "/review-uploads/nope/i/r")).toMatchObject({ status: 204 });
  });

  it("refuses a file target with 409 and keeps it", async () => {
    const port = await serve();
    await mkdir(path.join(root, "d2", "i"), { recursive: true });
    await writeFile(path.join(root, "d2", "i", "r"), "legacy");
    expect(await send(port, "DELETE", "/review-uploads/d2/i/r")).toMatchObject({ status: 409 });
    expect(await readFile(path.join(root, "d2", "i", "r"), "utf8")).toBe("legacy");
  });

  it("refuses a symlinked parent with 403 and removes nothing outside", async () => {
    const port = await serve();
    await mkdir(path.join(outside, "i", "r"), { recursive: true });
    await writeFile(path.join(outside, "i", "r", "keep.png"), PNG);
    await symlink(outside, path.join(root, "d3"));
    expect(await send(port, "DELETE", "/review-uploads/d3/i/r")).toMatchObject({ status: 403 });
    expect(await readdir(path.join(outside, "i", "r"))).toEqual(["keep.png"]);
  });
});

// The CLI is untyped .mjs outside this package; a non-literal specifier keeps tsc from resolving it.
const CLI_LIB = path.join(import.meta.dirname, "..", "..", "..", "bin", "review-request-lib.mjs");

it("caps uploads exactly where the CLI caps videos", async () => {
  const cli = (await import(CLI_LIB)) as { MAX_VIDEO_BYTES: number };
  expect(MAX_REVIEW_UPLOAD_BYTES).toBe(cli.MAX_VIDEO_BYTES);
});
