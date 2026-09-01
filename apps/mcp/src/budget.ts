// Bounded MCP responses (brain-mcp spec, "Bounded responses"): every tool
// that returns a list keeps the highest-priority items (the caller must
// pass them in already-best-first order — retrieve()'s score order,
// getNeighbors()'s weight order, etc.) up to a character budget, and
// reports which ids it dropped so the caller can fetch them individually
// (via brain_get, for node-shaped ids) rather than seeing a bare
// "truncated: true" with no way to act on it.
//
// Two hazards a naive "keep items until the budget is exceeded" pass
// misses (bd-vt2.5 review, both fixed here):
//
//   1. A single pathological item — e.g. metadata nobody capped before
//      this ticket — can itself be many times the whole budget. The
//      "always keep at least one item" guarantee (so a response is never
//      silently empty) must not let that one item defeat the budget by
//      200x. `shrinkOversizedItem` truncates such an item's own oversized
//      fields in place instead of embedding it whole.
//   2. `boundList`'s accounting only sums the *list* items — it knows
//      nothing about the envelope wrapped around them (counts, notes,
//      other fields) or how the caller will serialize the final result
//      (compact vs. pretty-printed). Measured drift: 23,218 accounted vs.
//      25,002 actually sent. `boundResponse` fixes this by checking the
//      *exact* compact-JSON bytes of the assembled envelope and backing
//      off further if it still doesn't fit, rather than trusting an
//      estimate of the list's share of the budget.

/**
 * Soft budget, in compact-JSON-serialized characters, for one tool
 * response. ~24k characters is comfortably inside typical MCP client
 * context/message limits. Deliberately generous — this is a safety bound
 * against pathological cases (huge documents, huge batches), not the
 * primary shaping mechanism (retrieve()'s own nodeBudget already shapes
 * typical search responses).
 */
export const DEFAULT_RESPONSE_CHAR_BUDGET = 24_000;

/**
 * An item whose own compact JSON exceeds `maxChars * OVERSIZED_ITEM_MULTIPLE`
 * is considered pathological on its own (not merely "doesn't fit next to
 * others") and gets its oversized fields truncated in place rather than
 * embedded whole — see `shrinkOversizedItem`.
 */
const OVERSIZED_ITEM_MULTIPLE = 2;

/** Each oversized string/object-valued field on a shrunk item is cut to this many characters. */
const FIELD_TRUNCATE_CHARS = 500;

/**
 * If an item's compact JSON exceeds `maxChars * OVERSIZED_ITEM_MULTIPLE`,
 * returns a shallow copy with every oversized top-level field (string or
 * object) replaced by a short placeholder noting the original size and
 * that the field was cut for the response-size budget. Otherwise returns
 * `item` unchanged (by reference — callers can tell shrinking happened by
 * comparing `!==`).
 *
 * Generic and shape-agnostic on purpose: this is a last-resort safety net
 * for whatever field turns out to be oversized (today, most plausibly a
 * node's `content`/`metadata` on `brain_get` — see MetadataTooLargeError
 * in packages/core), not a hardcoded list of "the big fields."
 */
function shrinkOversizedItem<T>(item: T, maxChars: number): T {
  if (item === null || typeof item !== "object") return item;
  const full = JSON.stringify(item);
  if (full === undefined || full.length <= maxChars * OVERSIZED_ITEM_MULTIPLE) return item;

  const shrunk = (Array.isArray(item) ? [...(item as unknown[])] : { ...(item as Record<string, unknown>) }) as Record<string, unknown>;
  for (const key of Object.keys(shrunk)) {
    const value = shrunk[key];
    if (typeof value === "string") {
      if (value.length > FIELD_TRUNCATE_CHARS) {
        shrunk[key] =
          `${value.slice(0, FIELD_TRUNCATE_CHARS)}… [truncated: field is ${value.length} chars total; ` +
          `exceeded the response-size budget — re-fetch this item alone for the full value]`;
      }
    } else if (value !== null && typeof value === "object") {
      const serialized = JSON.stringify(value);
      if (serialized !== undefined && serialized.length > FIELD_TRUNCATE_CHARS) {
        shrunk[key] = `[omitted: field serializes to ${serialized.length} chars; exceeded the response-size budget — re-fetch this item alone for the full value]`;
      }
    }
  }
  return shrunk as T;
}

export interface BoundedList<T> {
  /** Items kept, in the same order given (prefix of the input) — the first may have been shrunk, see `shrunkIds`. */
  kept: T[];
  truncated: boolean;
  /** Ids of items omitted entirely, in the order they were dropped. */
  droppedIds: string[];
  /** Ids of items kept but with oversized fields truncated in place — distinct from `droppedIds`, which were omitted entirely. */
  shrunkIds: string[];
}

/**
 * Keeps a prefix of `items` (assumed already sorted best-first by the
 * caller) whose combined compact-JSON size stays within `maxChars`,
 * dropping the remainder. Always keeps at least one item (the first),
 * even if it alone would otherwise exceed the budget — shrinking its
 * oversized fields first (see `shrinkOversizedItem`) rather than either
 * embedding it whole or leaving the response silently empty.
 *
 * This function's own accounting is a fast, purely list-local estimate —
 * it knows nothing about whatever envelope the caller wraps the list in.
 * Use `boundResponse` when the exact final response size matters (the
 * common case for a tool handler); use `boundList` directly only where
 * that's not needed (as `boundResponse` itself does, and as budget.test.ts
 * does to test this piece in isolation).
 */
export function boundList<T>(items: readonly T[], idOf: (item: T) => string, maxChars: number = DEFAULT_RESPONSE_CHAR_BUDGET): BoundedList<T> {
  const kept: T[] = [];
  const droppedIds: string[] = [];
  const shrunkIds: string[] = [];
  let used = 0;

  for (const item of items) {
    if (kept.length === 0) {
      const shrunk = shrinkOversizedItem(item, maxChars);
      if (shrunk !== item) shrunkIds.push(idOf(item));
      kept.push(shrunk);
      used += JSON.stringify(shrunk).length;
      continue;
    }
    const size = JSON.stringify(item).length;
    if (used + size > maxChars) {
      droppedIds.push(idOf(item));
      continue;
    }
    kept.push(item);
    used += size;
  }

  return { kept, truncated: droppedIds.length > 0 || shrunkIds.length > 0, droppedIds, shrunkIds };
}

/**
 * Builds a bounded tool response and verifies it against the *exact*
 * bytes that will be sent, backing off further if the assembled envelope
 * — not just the list `boundList` accounted for — still exceeds the
 * budget.
 *
 * `buildEnvelope(kept, meta)` must return the complete response object
 * (the same shape server.ts will `JSON.stringify` onto the wire, compact,
 * matching the check here). It is called at least once, and again each
 * time this function needs to drop one more kept item to make the whole
 * envelope fit — cheap in practice, since real envelope overhead (counts,
 * short notes) is small relative to list items, so this converges in one
 * or two extra calls at most in the rare case the first pass doesn't fit.
 */
export function boundResponse<T, E>(
  items: readonly T[],
  idOf: (item: T) => string,
  buildEnvelope: (kept: T[], meta: { truncated: boolean; droppedIds: string[]; shrunkIds: string[] }) => E,
  maxChars: number = DEFAULT_RESPONSE_CHAR_BUDGET,
): E {
  const initial = boundList(items, idOf, maxChars);
  let kept = initial.kept;
  const droppedIds = [...initial.droppedIds];
  const shrunkIds = initial.shrunkIds;

  for (;;) {
    const truncated = droppedIds.length > 0 || shrunkIds.length > 0;
    const envelope = buildEnvelope(kept, { truncated, droppedIds, shrunkIds });
    // `kept.length <= 1`, not `=== 0`: envelope overhead (counts, a long
    // truncationNote, other list ids) can push even a single already-
    // shrunk item over maxChars on its own. Popping that last item to
    // "fit" would return an empty list, silently breaking the same
    // never-empty guarantee this function exists to enforce — an
    // envelope that's still slightly over budget with one real item in
    // it is the correct trade, not an empty one that's technically
    // within budget.
    if (JSON.stringify(envelope).length <= maxChars || kept.length <= 1) {
      return envelope;
    }
    const dropped = kept[kept.length - 1]!;
    kept = kept.slice(0, -1);
    droppedIds.push(idOf(dropped));
  }
}
