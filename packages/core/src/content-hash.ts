import { createHash } from "node:crypto";

/**
 * Deterministic content hash used to detect whether a node's title/content
 * actually changed between writes (see `upsertNodes` in nodes.ts, and the
 * knowledge-store spec's "Load re-run over unchanged input" / "Load re-run
 * over changed content" scenarios). Callers supply title and content, never
 * a hash directly — this is the only place a node's `content_hash` is
 * computed, so two callers writing the same text always agree, and there
 * is no way to pass a stale or fabricated hash.
 *
 * A NUL separator between title and content means ("ab", "c") and
 * ("a", "bc") hash differently, even though naive concatenation would
 * collide them.
 */
export function computeContentHash(title: string, content: string): string {
  const NUL_SEPARATOR = String.fromCharCode(0);
  return createHash("sha256")
    .update(title, "utf8")
    .update(NUL_SEPARATOR, "utf8")
    .update(content, "utf8")
    .digest("hex");
}
