// Decision images on disk (review-decision-images, design.md decisions 2
// and 4): one check shared by the review decision router and the relay's
// media endpoint. A path, already shaped by core's isDecisionImagePath, is
// joined onto the media root one segment at a time and each level is
// lstat'ed: a missing level, a symlink at any level, a non-directory on the
// way, or anything but a regular file at the end is refused naming the
// path. The root itself may be a symlink (it is the operator's). No I/O
// beyond lstat; the caller opens the file.

import { lstat } from "node:fs/promises";
import path from "node:path";

export type DecisionImagesCheck = { ok: true; files: string[] } | { ok: false; image: string; reason: "missing" | "not-a-file" };

/** The absolute files of `images` under `root`, in order, or the first that is not a regular file reached without a symlink (module header). */
export async function resolveDecisionImages(root: string, images: readonly string[]): Promise<DecisionImagesCheck> {
  const files: string[] = [];
  for (const image of images) {
    const segments = image.split("/");
    let at = root;
    for (const [i, segment] of segments.entries()) {
      at = path.join(at, segment);
      let info;
      try {
        info = await lstat(at);
      } catch {
        return { ok: false, image, reason: "missing" };
      }
      const last = i === segments.length - 1;
      if (info.isSymbolicLink() || (last ? !info.isFile() : !info.isDirectory())) return { ok: false, image, reason: "not-a-file" };
    }
    files.push(at);
  }
  return { ok: true, files };
}
