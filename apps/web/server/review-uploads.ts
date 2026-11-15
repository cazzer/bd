// The review media upload route (remote-review-media, design.md decisions 1
// to 3): `review-request` run against a remote host PUTs each staged file to
// `/review-uploads/<project>/<item-id>/<run>/<NN-name>` and stores the
// relative path `<project>/<item-id>/<run>/<NN-name>`, which the board
// resolves against this server's media root (review-images.ts serves it).
// `DELETE /review-uploads/<project>/<item-id>/<run>` removes one run: a
// filing that failed, or the media of a review that was just refreshed.
// The prefix is separate from `/review-images/` so its admission scopes can
// differ (dispatch.ts): `human` and `agent` here, `human` only for reading.
//
// A request is checked in this order, each refusal before any later step:
//   1. PUT with exactly 4 segments, or DELETE with exactly 3 (else 405,
//      `Allow: PUT, DELETE`);
//   2. each raw segment, never decoded, matches SEGMENT and is at most 255
//      characters (else 400), so `..`, `%2e`, and empty segments never pass;
//   3. PUT: the name's extension is png/jpg/jpeg/gif/webp/mp4/webm (else
//      415), and the request's Content-Type, parameters ignored, is that
//      extension's type (else 415);
//   4. PUT: a Content-Length over the cap is 413 before any byte is read;
//   5. PUT: more than `maxConcurrent` uploads in flight is 503 with
//      `Retry-After: 1`;
//   6. PUT: free space on the root's volume less the Content-Length under
//      `minFreeBytes` is 507 (ENOSPC later is 507 too);
//   7. PUT: the run directory is created one level at a time (mode 0755;
//      a symlink at a level → 403 before anything is made through it, a
//      file → 409); either method: its realpath must equal the root's
//      realpath joined with the segments (a symlink anywhere → 403);
//   8. PUT: the body streams into `.<name>.<random>.tmp` (exclusive create,
//      mode 0644), counting bytes, and a body past the cap is 413 even when
//      chunked; then fsync, rename over the target (a re-PUT replaces it),
//      fsync the directory, 204. Any failure unlinks the tmp file.
//      DELETE: a missing run is 204; anything but a real directory is 409,
//      nothing removed; else it is removed recursively, 204.
// PUT refusals carry `Connection: close`, so an unread body is not drained.
// Node's default `requestTimeout` (300 s) bounds each request. Nothing here
// logs a header or the body.
//
// Accepted race: between the realpath check and the write, a directory on
// the way could be swapped for a symlink. As for the image route, only the
// host's own operator can make one under the root.

import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, realpath, rename, rm, statfs, unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { REVIEW_IMAGE_ROOT } from "@breakdown/core";
import { CONTENT_TYPES } from "./review-images.js";

export const REVIEW_UPLOADS_PREFIX = "/review-uploads/";

/** One cap for every file. Must equal MAX_VIDEO_BYTES in bin/review-request-lib.mjs. */
export const MAX_REVIEW_UPLOAD_BYTES = 200 * 2 ** 20;

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_SEGMENT_LENGTH = 255;

export type UploadTarget =
  | { ok: true; method: "PUT"; segments: [string, string, string, string]; contentType: string }
  | { ok: true; method: "DELETE"; segments: [string, string, string] }
  | { ok: false; status: 400 | 405 | 415; reason: string };

/** Steps 1 to 3 of the module header for a raw path (query already dropped). Pure. */
export function parseUploadTarget(method: string | undefined, rawPath: string): UploadTarget {
  const segments = rawPath.startsWith(REVIEW_UPLOADS_PREFIX) ? rawPath.slice(REVIEW_UPLOADS_PREFIX.length).split("/") : [];
  const isPut = method === "PUT" && segments.length === 4;
  if (!isPut && !(method === "DELETE" && segments.length === 3)) return { ok: false, status: 405, reason: "Method not allowed" };
  if (!segments.every((s) => s.length <= MAX_SEGMENT_LENGTH && SEGMENT.test(s))) return { ok: false, status: 400, reason: "Malformed path" };
  if (!isPut) return { ok: true, method: "DELETE", segments: segments as [string, string, string] };
  const contentType = CONTENT_TYPES[path.extname(segments[3]!).toLowerCase()];
  if (contentType === undefined) return { ok: false, status: 415, reason: "Not a review image or video" };
  return { ok: true, method: "PUT", segments: segments as [string, string, string, string], contentType };
}

const COMMON_HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } as const;

function refuse(res: ServerResponse, status: number, text: string, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", ...COMMON_HEADERS, ...extraHeaders });
  res.end(`${text}\n`);
}

class Refusal extends Error {
  constructor(
    readonly status: number,
    reason: string,
  ) {
    super(reason);
  }
}

/** A filesystem error that is the request's or the volume's fault, as a refusal; null for the server's own. */
function fsRefusal(err: unknown): Refusal | null {
  switch ((err as NodeJS.ErrnoException).code) {
    case "ENOTDIR":
    case "EEXIST":
    case "EISDIR":
    case "ENOTEMPTY":
      return new Refusal(409, "Something else is in the way");
    case "ENOSPC":
      return new Refusal(507, "Not enough free space");
    case "ENAMETOOLONG":
      return new Refusal(400, "Malformed path");
    default:
      return null;
  }
}

export interface ReviewUploadHandlerOptions {
  root?: string;
  maxBytes?: number;
  maxConcurrent?: number;
  minFreeBytes?: number;
}

/** The Node request handler for REVIEW_UPLOADS_PREFIX (module header). */
export function createReviewUploadHandler(options: ReviewUploadHandlerOptions = {}): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const root = options.root ?? REVIEW_IMAGE_ROOT;
  const maxBytes = options.maxBytes ?? MAX_REVIEW_UPLOAD_BYTES;
  const maxConcurrent = options.maxConcurrent ?? 2;
  const minFreeBytes = options.minFreeBytes ?? 2 ** 30;
  let active = 0;

  /** The run directory's path, after the realpath check of step 7; throws a Refusal. */
  async function checkedRunDir(segments: readonly string[]): Promise<string> {
    const dir = path.join(root, ...segments.slice(0, 3));
    if ((await realpath(dir)) !== path.join(await realpath(root), ...segments.slice(0, 3))) throw new Refusal(403, "Outside the review media root");
    return dir;
  }

  async function put(req: IncomingMessage, segments: [string, string, string, string], length: number | null): Promise<void> {
    await mkdir(root, { recursive: true });
    const { bavail, bsize } = await statfs(root);
    if (bavail * bsize - (length ?? 0) < minFreeBytes) throw new Refusal(507, "Not enough free space");
    // One level at a time, so a symlink on the way is refused before anything is made through it.
    let level = root;
    for (const segment of segments.slice(0, 3)) {
      level = path.join(level, segment);
      await mkdir(level, { mode: 0o755 }).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "EEXIST") throw err;
      });
      const info = await lstat(level);
      if (info.isSymbolicLink()) throw new Refusal(403, "Outside the review media root");
      if (!info.isDirectory()) throw new Refusal(409, "Something else is in the way");
    }
    const dir = await checkedRunDir(segments);
    const name = segments[3];
    const tmp = path.join(dir, `.${name}.${randomBytes(6).toString("hex")}.tmp`);
    const file = await open(tmp, "wx", 0o644);
    let closed = false;
    try {
      let bytes = 0;
      for await (const chunk of req as AsyncIterable<Buffer>) {
        bytes += chunk.length;
        if (bytes > maxBytes) throw new Refusal(413, "Too large");
        await file.write(chunk);
      }
      await file.sync();
      closed = true;
      await file.close();
      await rename(tmp, path.join(dir, name));
    } catch (err) {
      if (!closed) await file.close().catch(() => {});
      await unlink(tmp).catch(() => {});
      throw err;
    }
    const dirHandle = await open(dir, "r");
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  }

  async function remove(segments: [string, string, string]): Promise<void> {
    let dir: string;
    try {
      dir = await checkedRunDir(segments);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    if (!(await lstat(dir)).isDirectory()) throw new Refusal(409, "Not a run directory");
    await rm(dir, { recursive: true, force: true });
  }

  return async (req, res) => {
    // The raw path, query dropped, never URL-normalized (review-images.ts).
    const target = parseUploadTarget(req.method, (req.url ?? "/").split("?", 1)[0]!);
    const close: Record<string, string> = req.method === "PUT" ? { Connection: "close" } : {};
    if (!target.ok) {
      refuse(res, target.status, target.reason, { ...close, ...(target.status === 405 ? { Allow: "PUT, DELETE" } : {}) });
      return;
    }
    let length: number | null = null;
    if (target.method === "PUT") {
      const sent = (req.headers["content-type"] ?? "").split(";", 1)[0]!.trim().toLowerCase();
      if (sent !== target.contentType) {
        refuse(res, 415, `Content-Type must be ${target.contentType}`, close);
        return;
      }
      const header = req.headers["content-length"];
      if (header !== undefined) {
        length = Number(header);
        if (length > maxBytes) {
          refuse(res, 413, "Too large", close);
          return;
        }
      }
      if (active >= maxConcurrent) {
        refuse(res, 503, "Too many uploads in flight", { ...close, "Retry-After": "1" });
        return;
      }
    }
    const counted = target.method === "PUT";
    if (counted) active += 1;
    try {
      if (target.method === "PUT") await put(req, target.segments, length);
      else await remove(target.segments);
      res.writeHead(204, COMMON_HEADERS);
      res.end();
    } catch (err) {
      const refusal = err instanceof Refusal ? err : fsRefusal(err);
      if (refusal !== null) {
        refuse(res, refusal.status, refusal.message, close);
      } else if (req.destroyed || req.readableAborted) {
        // The client went away mid-body; nothing to answer.
        res.destroy();
      } else {
        console.error(`[breakdown-web] review upload ${req.method} failed:`, err);
        if (!res.headersSent) refuse(res, 500, "Internal error", close);
        else res.destroy();
      }
    } finally {
      if (counted) active -= 1;
    }
  };
}
