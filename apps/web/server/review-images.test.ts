// The review image route (board-visual-reviews, design.md decision 4): a
// throwaway root beside a sibling directory standing in for "everywhere
// else", so every escape has a real file to reach if a check were missing.

import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createReviewImageHandler, parseByteRange, resolveReviewImage, REVIEW_IMAGES_PREFIX, reviewImageUrl } from "./review-images.js";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const WEBP = Buffer.from("RIFF0000WEBPVP8 ");
// Not a playable video: the route checks names, never content.
const MP4 = Buffer.from(Array.from({ length: 64 }, (_, i) => i));

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
  await writeFile(path.join(root, "reel.mp4"), MP4);
  await writeFile(path.join(root, "reel.webm"), MP4);
  await writeFile(path.join(root, "reel.mov"), MP4);
  await writeFile(path.join(root, "empty.mp4"), "");
  await writeFile(path.join(outside, "secret.png"), PNG);
  await writeFile(path.join(outside, "secret.mp4"), MP4);
  await symlink(path.join(outside, "secret.mp4"), path.join(root, "escape.mp4"));
  await symlink(path.join(outside, "secret.png"), path.join(root, "escape.png"));
  await symlink(outside, path.join(root, "linkdir"));
  await symlink(path.join(root, "notes.txt"), path.join(root, "trick.png"));
  await symlink(path.join(root, "loop.png"), path.join(root, "loop.png"));
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

  it("serves mp4 and webm as video, and refuses .mov and an mp4 symlink out of the root with 403", async () => {
    expect(await resolveReviewImage(url("reel.mp4"), root)).toMatchObject({ ok: true, contentType: "video/mp4", size: MP4.length });
    expect(await resolveReviewImage(url("reel.webm"), root)).toMatchObject({ ok: true, contentType: "video/webm" });
    expect(await resolveReviewImage(url("reel.mov"), root)).toMatchObject({ ok: false, status: 403, reason: "Not a review image or video" });
    expect(await resolveReviewImage(url("escape.mp4"), root)).toMatchObject({ ok: false, status: 403, reason: "Outside the review image root" });
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

  it("refuses an encoded absolute path in one segment with 403", async () => {
    expect(await resolveReviewImage(url("%2Fetc%2Fpasswd.png"), root)).toMatchObject({ ok: false, status: 403 });
  });

  it("answers a symlink loop with 404 and an over-long name with 400, not a server error", async () => {
    expect(await resolveReviewImage(url("loop.png"), root)).toMatchObject({ ok: false, status: 404 });
    expect(await resolveReviewImage(url(`${"x".repeat(300)}.png`), root)).toMatchObject({ ok: false, status: 400 });
  });

  it("refuses the root itself", async () => {
    expect(await resolveReviewImage(url(""), root)).toMatchObject({ ok: false, status: 403 });
  });
});

describe("parseByteRange", () => {
  it.each([
    ["bytes=0-1", 100, { start: 0, end: 1 }],
    ["bytes=5-", 100, { start: 5, end: 99 }],
    ["bytes=-3", 100, { start: 97, end: 99 }],
    ["bytes=-300", 100, { start: 0, end: 99 }],
    ["bytes=90-500", 100, { start: 90, end: 99 }],
    ["bytes=99-99", 100, { start: 99, end: 99 }],
    ["bytes=-0", 100, "unsatisfiable"],
    ["bytes=100-", 100, "unsatisfiable"],
    ["bytes=400-500", 100, "unsatisfiable"],
    ["bytes=0-1", 0, "unsatisfiable"],
    ["bytes=-5", 0, "unsatisfiable"],
    ["bytes=5-2", 100, null],
    ["bytes=0-1,4-5", 100, null],
    ["bytes=-", 100, null],
    ["bytes=abc", 100, null],
    ["items=0-1", 100, null],
    ["garbage", 100, null],
    ["", 100, null],
    [`bytes=${"1".repeat(16)}-`, 100, null],
    [`bytes=0-${"9".repeat(16)}`, 100, null],
  ] as const)("%s of %i bytes → %o", (header, size, expected) => {
    expect(parseByteRange(header, size)).toEqual(expected);
  });

  it("answers null with no header", () => {
    expect(parseByteRange(undefined, 100)).toBeNull();
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

  it("rebases a host-recorded path onto the root from the last reviews marker", () => {
    const media = "/data/media";
    expect(reviewImageUrl("/Users/caleb/.local/share/breakdown/reviews/tides/r1/a.png", media)).toBe("/review-images/tides/r1/a.png");
    expect(reviewImageUrl("/home/x/.local/share/breakdown/reviews/a/.local/share/breakdown/reviews/b.png", media)).toBe("/review-images/b.png");
    expect(reviewImageUrl("/home/x/.local/share/breakdown/reviews/with space.png", media)).toBe("/review-images/with%20space.png");
    // Inside the root already: taken as it is, not rebased.
    expect(reviewImageUrl(path.join(media, "sub", "c.png"), media)).toBe("/review-images/sub/c.png");
  });

  it("answers null for a host path with .. after the marker, no marker, or nothing after it", () => {
    const media = "/data/media";
    expect(reviewImageUrl("/Users/caleb/.local/share/breakdown/reviews/../../secret.png", media)).toBeNull();
    expect(reviewImageUrl("/Users/caleb/.local/share/breakdown/reviews/sub/../a.png", media)).toBeNull();
    expect(reviewImageUrl("/Users/caleb/.local/share/breakdown/other/a.png", media)).toBeNull();
    expect(reviewImageUrl("/Users/caleb/.local/share/breakdown/reviews", media)).toBeNull();
    expect(reviewImageUrl("/Users/caleb/.local/share/breakdown/reviews/", media)).toBeNull();
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
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG);
  });

  it("answers HEAD with headers and no body", async () => {
    const res = await fetch(`${origin}/review-images/a.png`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe(String(PNG.length));
    expect((await res.arrayBuffer()).byteLength).toBe(0);
  });

  it("sends Accept-Ranges on a whole-file answer", async () => {
    const res = await fetch(`${origin}/review-images/reel.mp4`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(MP4);
  });

  it("answers an empty file with 200 and no body", async () => {
    const res = await fetch(`${origin}/review-images/empty.mp4`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("0");
    expect((await res.arrayBuffer()).byteLength).toBe(0);
  });

  it("answers a single range with 206, Content-Range, and exactly those bytes", async () => {
    const res = await fetch(`${origin}/review-images/reel.mp4`, { headers: { Range: "bytes=0-1" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 0-1/${MP4.length}`);
    expect(res.headers.get("content-length")).toBe("2");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(MP4.subarray(0, 2));

    const tail = await fetch(`${origin}/review-images/reel.webm`, { headers: { Range: "bytes=-3" } });
    expect(tail.status).toBe(206);
    expect(tail.headers.get("content-type")).toBe("video/webm");
    expect(tail.headers.get("content-range")).toBe(`bytes 61-63/${MP4.length}`);
    expect(Buffer.from(await tail.arrayBuffer())).toEqual(MP4.subarray(61));
  });

  it("answers an unsatisfiable range with 416 and the size", async () => {
    const res = await fetch(`${origin}/review-images/reel.mp4`, { headers: { Range: "bytes=40000-" } });
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe(`bytes */${MP4.length}`);
    await res.arrayBuffer();
    const empty = await fetch(`${origin}/review-images/empty.mp4`, { headers: { Range: "bytes=0-1" } });
    expect(empty.status).toBe(416);
    expect(empty.headers.get("content-range")).toBe("bytes */0");
    await empty.arrayBuffer();
  });

  it("ignores a multi-range or malformed header and serves the whole file", async () => {
    for (const range of ["bytes=0-1,4-5", "bytes=5-2", "lines=1-2"]) {
      const res = await fetch(`${origin}/review-images/reel.mp4`, { headers: { Range: range } });
      expect(res.status, range).toBe(200);
      expect(res.headers.get("content-length"), range).toBe(String(MP4.length));
      expect(Buffer.from(await res.arrayBuffer()), range).toEqual(MP4);
    }
  });

  it("answers HEAD with a range with the 206 headers and no body", async () => {
    const res = await fetch(`${origin}/review-images/reel.mp4`, { method: "HEAD", headers: { Range: "bytes=2-5" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 2-5/${MP4.length}`);
    expect(res.headers.get("content-length")).toBe("4");
    expect((await res.arrayBuffer()).byteLength).toBe(0);
  });

  it("refuses .mov with 403", async () => {
    const res = await fetch(`${origin}/review-images/reel.mov`);
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("Not a review image or video\n");
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
