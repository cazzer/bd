// The review image route (board-visual-reviews, design.md decision 4): a
// throwaway root beside a sibling directory standing in for "everywhere
// else", so every escape has a real file to reach if a check were missing.

import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createReviewImageHandler, resolveReviewImage, REVIEW_IMAGES_PREFIX, reviewImageUrl } from "./review-images.js";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const WEBP = Buffer.from("RIFF0000WEBPVP8 ");

let base: string;
let root: string;
let outside: string;

beforeAll(async () => {
  // realpath: macOS tmpdir is a symlink (/var -> /private/var), and the resolver answers real paths.
  base = await realpath(await mkdtemp(path.join(os.tmpdir(), "review-images-")));
  root = path.join(base, "reviews");
  outside = path.join(base, "outside");
  await mkdir(path.join(root, "sub"), { recursive: true });
  await mkdir(path.join(root, "d.png"));
  await mkdir(outside);
  await writeFile(path.join(root, "a.png"), PNG);
  await writeFile(path.join(root, "sub", "b.webp"), WEBP);
  await writeFile(path.join(root, "C.PNG"), PNG);
  await writeFile(path.join(root, "notes.txt"), "secret notes");
  await writeFile(path.join(root, "with space #1?.png"), PNG);
  await writeFile(path.join(outside, "secret.png"), PNG);
  await symlink(path.join(outside, "secret.png"), path.join(root, "escape.png"));
  await symlink(outside, path.join(root, "linkdir"));
  await symlink(path.join(root, "notes.txt"), path.join(root, "trick.png"));
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

const url = (rest: string) => `${REVIEW_IMAGES_PREFIX}${rest}`;

describe("resolveReviewImage", () => {
  it("serves images inside the root, any case of extension, in subdirectories", async () => {
    expect(await resolveReviewImage(url("a.png"), root)).toMatchObject({ ok: true, contentType: "image/png", size: PNG.length });
    expect(await resolveReviewImage(url("sub/b.webp"), root)).toMatchObject({ ok: true, contentType: "image/webp" });
    expect(await resolveReviewImage(url("C.PNG"), root)).toMatchObject({ ok: true, contentType: "image/png" });
    expect(await resolveReviewImage(url("with%20space%20%231%3F.png"), root)).toMatchObject({ ok: true });
  });

  it("refuses .. in any spelling with 403", async () => {
    for (const rest of ["../outside/secret.png", "sub/../../outside/secret.png", "%2e%2e%2foutside%2fsecret.png", "..%2f..%2fetc%2fpasswd", "%2E%2E/outside/secret.png"]) {
      expect(await resolveReviewImage(url(rest), root), rest).toMatchObject({ ok: false, status: 403 });
    }
  });

  it("refuses a symlink that leads out, file or directory, with 403", async () => {
    expect(await resolveReviewImage(url("escape.png"), root)).toMatchObject({ ok: false, status: 403 });
    expect(await resolveReviewImage(url("linkdir/secret.png"), root)).toMatchObject({ ok: false, status: 403 });
  });

  it("refuses a non-image, and an image-named symlink to a non-image, with 403", async () => {
    expect(await resolveReviewImage(url("notes.txt"), root)).toMatchObject({ ok: false, status: 403 });
    expect(await resolveReviewImage(url("trick.png"), root)).toMatchObject({ ok: false, status: 403 });
  });

  it("refuses a NUL or a malformed escape with 400", async () => {
    expect(await resolveReviewImage(url("a.png%00.png"), root)).toMatchObject({ ok: false, status: 400 });
    expect(await resolveReviewImage(url("%E0%A4%A.png"), root)).toMatchObject({ ok: false, status: 400 });
  });

  it("answers 404 for a missing file, a directory, and a missing root", async () => {
    expect(await resolveReviewImage(url("nope.png"), root)).toMatchObject({ ok: false, status: 404 });
    expect(await resolveReviewImage(url("d.png"), root)).toMatchObject({ ok: false, status: 404 });
    expect(await resolveReviewImage(url("a.png"), path.join(base, "no-root"))).toMatchObject({ ok: false, status: 404 });
  });

  it("refuses the root itself", async () => {
    expect(await resolveReviewImage(url(""), root)).toMatchObject({ ok: false, status: 403 });
  });
});

describe("reviewImageUrl", () => {
  it("maps a path inside the root to its route URL, each segment encoded", () => {
    expect(reviewImageUrl(path.join(root, "a.png"), root)).toBe("/review-images/a.png");
    expect(reviewImageUrl(path.join(root, "sub", "b.webp"), root)).toBe("/review-images/sub/b.webp");
    expect(reviewImageUrl(path.join(root, "with space #1?.png"), root)).toBe("/review-images/with%20space%20%231%3F.png");
  });

  it("answers null outside the root, for the root itself, and through ..", () => {
    expect(reviewImageUrl("/etc/passwd", root)).toBeNull();
    expect(reviewImageUrl(root, root)).toBeNull();
    expect(reviewImageUrl(path.join(root, "..", "outside", "secret.png"), root)).toBeNull();
  });

  it("round-trips through the resolver", async () => {
    for (const file of [path.join(root, "a.png"), path.join(root, "sub", "b.webp"), path.join(root, "with space #1?.png")]) {
      const resolved = await resolveReviewImage(reviewImageUrl(file, root)!, root);
      expect(resolved).toMatchObject({ ok: true, file });
    }
  });
});

describe("createReviewImageHandler over HTTP", () => {
  let server: Server;
  let origin: string;

  beforeAll(async () => {
    const handler = createReviewImageHandler({ root });
    server = createServer((req, res) => void handler(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("serves the bytes with type, length, no-store, and nosniff", async () => {
    const res = await fetch(`${origin}/review-images/a.png?cache=bust`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-length")).toBe(String(PNG.length));
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG);
  });

  it("answers HEAD with headers and no body", async () => {
    const res = await fetch(`${origin}/review-images/a.png`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe(String(PNG.length));
    expect((await res.arrayBuffer()).byteLength).toBe(0);
  });

  it("refuses other methods with 405", async () => {
    const res = await fetch(`${origin}/review-images/a.png`, { method: "POST" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
  });

  it("refuses an escape with a short text body and never sends the file", async () => {
    const res = await fetch(`${origin}/review-images/..%2foutside%2fsecret.png`);
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(await res.text()).toBe("Outside the review image root\n");
  });
});
