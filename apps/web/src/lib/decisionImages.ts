// Screenshots attached to a review decision on the board
// (review-decision-images, design.md decision 1). The message box takes
// images pasted from the clipboard (`ClipboardEvent.clipboardData.files`)
// or dropped onto it; this module decides which of them a decision can
// carry, names their upload, uploads them, and says what failed.
//
// Limits mirror core's reviews.ts (MAX_DECISION_IMAGES,
// MAX_DECISION_IMAGE_BYTES, DECISION_IMAGE_TYPES, decisionMessageBudget);
// they are duplicated, not imported, because the core barrel pulls the
// Node-only `pg` driver into the client bundle (graph/expansion.ts header),
// and decisionImages.test.ts holds the two in step.
//
// Upload: every image goes into one new run under the review's project and
// item, `d-<UTC yyyymmddHHMMss>-<4 base36>`, named in attachment order
// `NN-<slug>.<ext>` (the slug from the file name, else `screenshot`), with a
// same-origin PUT to `/review-uploads/` (the board's cookie admits it). The
// first failure stops the upload, DELETEs the run (best effort), and is
// reported naming the image by its position and the server's reason; the
// decision is then not sent.

export const MAX_DECISION_IMAGES = 6;
export const MAX_DECISION_IMAGE_BYTES = 10 * 2 ** 20;
export const DECISION_IMAGE_TYPES = ["png", "jpg", "jpeg", "gif", "webp"] as const;
/** Core's MAX_REVIEW_DECISION_MESSAGE_LENGTH (MAX_REVIEW_COMMENT_LENGTH − 32). */
export const MAX_DECISION_MESSAGE_LENGTH = 4000 - 32;

const MIME_EXTENSION: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};
const EXTENSION_MIME: Readonly<Record<string, string>> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

/**
 * An image the person attached and has not removed. `url` is its thumbnail as
 * a `data:` URL: the board's CSP allows `img-src 'self' data:` and not
 * `blob:`, so object URLs would not render.
 */
export interface AttachedImage {
  key: string;
  file: File;
  url: string;
}

/** The extension a decision image will be uploaded with, or null when the file is not one it can carry. */
export function decisionImageExtension(file: Pick<File, "name" | "type">): string | null {
  const byType = MIME_EXTENSION[file.type.toLowerCase()];
  if (byType !== undefined) return byType;
  if (file.type !== "") return null;
  const ext = /\.([A-Za-z0-9]+)$/.exec(file.name)?.[1]?.toLowerCase();
  return ext !== undefined && (DECISION_IMAGE_TYPES as readonly string[]).includes(ext) ? (ext === "jpeg" ? "jpg" : ext) : null;
}

function displayName(file: Pick<File, "name">): string {
  return file.name === "" ? "the pasted image" : file.name;
}

/** Which of `files` join the `already` attached, in order, and a line for each refused one (wrong type, too large, over the count). */
export function admitDecisionImages<F extends Pick<File, "name" | "type" | "size">>(already: number, files: readonly F[]): { accepted: F[]; refused: string[] } {
  const accepted: F[] = [];
  const refused: string[] = [];
  for (const file of files) {
    if (decisionImageExtension(file) === null) refused.push(`${displayName(file)} is not an image a decision can carry (PNG, JPEG, GIF, or WebP).`);
    else if (file.size > MAX_DECISION_IMAGE_BYTES) refused.push(`${displayName(file)} is over 10 MB.`);
    else if (already + accepted.length >= MAX_DECISION_IMAGES) refused.push(`${displayName(file)} was not added: a decision carries at most ${MAX_DECISION_IMAGES} images.`);
    else accepted.push(file);
  }
  return { accepted, refused };
}

/** The run a decision's images upload into (module header). */
export function decisionRunName(now: Date = new Date(), random: () => number = Math.random): string {
  const stamp = now.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const tail = Array.from({ length: 4 }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(random() * 36)]).join("");
  return `d-${stamp}-${tail}`;
}

/** The upload name of the `index`-th image (from 0): `NN-<slug>.<ext>` (module header). */
export function decisionImageName(index: number, file: Pick<File, "name" | "type">): string {
  const ext = decisionImageExtension(file) ?? "png";
  const stem = file.name.replace(/\.[A-Za-z0-9]+$/, "");
  const slug = stem
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return `${String(index + 1).padStart(2, "0")}-${slug === "" ? "screenshot" : slug}.${ext}`;
}

/** What the comment's images block costs: `\n\nImages:\n` and one path per line (core's decisionCommentImagesBlock). */
export function imagesBlockLength(paths: readonly string[]): number {
  return paths.length === 0 ? 0 : "\n\nImages:\n".length + paths.join("\n").length;
}

/** How many characters a message must lose to fit beside `paths`, or 0 (core's decisionMessageBudget). */
export function charactersToCut(message: string, paths: readonly string[]): number {
  return Math.max(0, message.trim().length - (MAX_DECISION_MESSAGE_LENGTH - imagesBlockLength(paths)));
}

/** The relative paths `images` will have once uploaded into `run`: what the decision sends and the comment records. */
export function decisionImagePaths(project: string, item: string, run: string, images: readonly Pick<File, "name" | "type">[]): string[] {
  return images.map((file, i) => `${project}/${item}/${run}/${decisionImageName(i, file)}`);
}

const STATUS_REASONS: Readonly<Record<number, string>> = {
  403: "the server refused it",
  409: "an image of that name is already there",
  413: "it is too large for the server",
  415: "the server does not take that type",
  503: "the server is busy; try again",
  507: "the server is out of space",
};

export type UploadOutcome = { ok: true; paths: string[] } | { ok: false; text: string };

export type FetchLike = (input: string, init: RequestInit) => Promise<Pick<Response, "ok" | "status">>;

function ordinal(n: number): string {
  return ["first", "second", "third", "fourth", "fifth", "sixth"][n] ?? `#${n + 1}`;
}

/** Uploads `images` into a new run, in order; on the first failure deletes the run and says which image and why (module header). */
export async function uploadDecisionImages(
  project: string,
  item: string,
  images: readonly Pick<File, "name" | "type">[],
  { fetch = (input, init) => globalThis.fetch(input, init), run = decisionRunName() }: { fetch?: FetchLike; run?: string } = {},
): Promise<UploadOutcome> {
  const paths = decisionImagePaths(project, item, run, images);
  const runUrl = `/review-uploads/${encodeURIComponent(project)}/${encodeURIComponent(item)}/${run}`;
  for (const [i, image] of images.entries()) {
    const name = paths[i]!.slice(paths[i]!.lastIndexOf("/") + 1);
    let reason: string | null = null;
    try {
      const res = await fetch(`${runUrl}/${name}`, {
        method: "PUT",
        headers: { "Content-Type": EXTENSION_MIME[decisionImageExtension(image) ?? "png"]! },
        body: image as unknown as BodyInit,
        credentials: "same-origin",
      });
      if (!res.ok) reason = STATUS_REASONS[res.status] ?? `the server answered ${res.status}`;
    } catch {
      reason = "the server could not be reached";
    }
    if (reason !== null) {
      await fetch(runUrl, { method: "DELETE", credentials: "same-origin" }).catch(() => undefined);
      const which = images.length === 1 ? "The image" : `The ${ordinal(i)} image`;
      return { ok: false, text: `${which} could not be uploaded because ${reason}; nothing was sent.` };
    }
  }
  return { ok: true, paths };
}

/** `file` as a `data:` URL, for its thumbnail. */
export function thumbnailUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("could not read the image"));
    reader.readAsDataURL(file);
  });
}

/** The image files a paste or drop carries, in order (`DataTransfer.files`; items as a fallback). */
export function filesOf(data: Pick<DataTransfer, "files" | "items"> | null): File[] {
  if (data === null) return [];
  const files = [...(data.files ?? [])];
  if (files.length > 0) return files;
  return [...(data.items ?? [])].flatMap((it) => {
    if (it.kind !== "file") return [];
    const file = it.getAsFile();
    return file === null ? [] : [file];
  });
}
