// Bounded responses (bd-hmd.3 review): every procedure that returns a
// list keeps the highest-priority items (the caller must pass them in
// already-best-first order — retrieve()'s score order, getNeighbors()'s
// weight order, etc.) up to a character budget, and reports which ids it
// dropped so the caller can fetch them individually (via getNodes, for
// node-shaped ids) rather than seeing a bare "truncated: true" with no
// way to act on it.
//
// Ported from apps/mcp/src/budget.ts (same two hazards, same fix — see
// that file's header for the full rationale) rather than shared, for the
// same reason server/startup.ts duplicates apps/mcp/src/startup.ts: no
// package boundary exists between the two apps to share this through,
// and design.md's "Two adapters over one core" is explicit that the
// adapters don't share code, only packages/core does.
//
// The concrete finding this closes (bd-hmd.3 review): `getNodes` accepts
// up to 1000 ids, each node's `content` can reach 1,000,000 characters
// (packages/core's DEFAULT_MAX_CONTENT_LENGTH), and nothing bounded the
// assembled response — three real ~999,000-character notes alone
// produced a 2,998,095-byte response with no truncation, and the
// schema's own ceiling puts a response near 1GB within reach.
//
// Two hazards a naive "keep items until the budget is exceeded" pass
// misses (both fixed here, same as apps/mcp/src/budget.ts):
//
//   1. A single pathological item — e.g. one node whose content sits
//      right at the 1,000,000-character cap — can itself be many times
//      the whole budget. The "always keep at least one item" guarantee
//      (so a response is never silently empty) must not let that one
//      item defeat the budget by 100x+. `shrinkOversizedItem` truncates
//      such an item's own oversized fields in place instead of embedding
//      it whole.
//   2. `boundList`'s accounting only sums the *list* items — it knows
//      nothing about the envelope wrapped around them (counts, notes,
//      other fields) or how the final response is serialized.
//      `boundResponse` fixes this by checking the *exact* compact-JSON
//      bytes of the assembled envelope and backing off further if it
//      still doesn't fit, rather than trusting an estimate of the list's
//      share of the budget.

/**
 * Soft budget, in compact-JSON-serialized characters, for one procedure
 * response. Unlike apps/mcp's 24k (sized to an LLM's context window),
 * this server's consumer is a browser tab, which can comfortably handle
 * a few megabytes of JSON — so 2,000,000 characters (~2MB) is the bound:
 * generous enough that a normal request (a handful of real nodes, a page
 * of search results) is never truncated, while still decisively ruling
 * out the near-1GB worst case above.
 */
export const DEFAULT_RESPONSE_CHAR_BUDGET = 2_000_000;

/**
 * An item whose own compact JSON exceeds `maxChars * OVERSIZED_ITEM_MULTIPLE`
 * is considered pathological on its own (not merely "doesn't fit next to
 * others") and gets its oversized fields truncated in place rather than
 * embedded whole — see `shrinkOversizedItem`.
 */
const OVERSIZED_ITEM_MULTIPLE = 2;

/** Each oversized string/object-valued field on a shrunk item is cut to this many characters. */
const FIELD_TRUNCATE_CHARS = 2_000;

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
 * node's `content` on `getNodes` — content itself is capped at 1,000,000
 * characters by packages/core, comfortably able to defeat this budget on
 * its own well before any batch size does), not a hardcoded list of "the
 * big fields."
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
 * common case for a procedure handler); use `boundList` directly only
 * where that's not needed.
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
 * Builds a bounded procedure response and verifies it against the
 * *exact* bytes that will be sent, backing off further if the assembled
 * envelope — not just the list `boundList` accounted for — still exceeds
 * the budget.
 *
 * `buildEnvelope(kept, meta)` must return the complete response object
 * (the same shape that will be `JSON.stringify`'d onto the wire, compact,
 * matching the check here). It is called at least once, and again each
 * time this function needs to drop one more kept item to make the whole
 * envelope fit.
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
    // `kept.length <= 1`, not `=== 0`: envelope overhead (counts, other
    // fields) can push even a single already-shrunk item over maxChars
    // on its own. Popping that last item to "fit" would return an empty
    // list, silently breaking the same never-empty guarantee this
    // function exists to enforce.
    if (JSON.stringify(envelope).length <= maxChars || kept.length <= 1) {
      return envelope;
    }
    const dropped = kept[kept.length - 1]!;
    kept = kept.slice(0, -1);
    droppedIds.push(idOf(dropped));
  }
}
