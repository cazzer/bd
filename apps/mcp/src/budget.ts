// Bounded MCP responses (brain-mcp spec, "Bounded responses"): every tool
// that returns a list keeps the highest-priority items (the caller must
// pass them in already-best-first order — retrieve()'s score order,
// getNeighbors()'s weight order, etc.) up to a character budget, and
// reports which ids it dropped so the caller can fetch them individually
// (via brain_get, for node-shaped ids) rather than seeing a bare
// "truncated: true" with no way to act on it.

/**
 * Soft budget, in JSON-serialized characters, for one tool response's
 * bounded list. ~24k characters is comfortably inside typical MCP client
 * context/message limits while leaving room for the rest of the response
 * envelope (counts, defaults, notes). Deliberately generous — this is a
 * safety bound against pathological cases (huge documents, huge batches),
 * not the primary shaping mechanism (retrieve()'s own nodeBudget already
 * shapes typical search responses).
 */
export const DEFAULT_RESPONSE_CHAR_BUDGET = 24_000;

export interface BoundedList<T> {
  /** Items kept, in the same order given (prefix of the input). */
  kept: T[];
  truncated: boolean;
  /** Ids of the dropped items, in the order they were dropped. */
  droppedIds: string[];
}

/**
 * Keeps a prefix of `items` (assumed already sorted best-first by the
 * caller) whose combined JSON size stays within `maxChars`, dropping the
 * remainder. Always keeps at least the first item, even if it alone
 * exceeds the budget — a single oversized item should not make the
 * response silently empty.
 */
export function boundList<T>(items: readonly T[], idOf: (item: T) => string, maxChars: number = DEFAULT_RESPONSE_CHAR_BUDGET): BoundedList<T> {
  const kept: T[] = [];
  const droppedIds: string[] = [];
  let used = 0;

  for (const item of items) {
    const size = JSON.stringify(item).length;
    if (kept.length > 0 && used + size > maxChars) {
      droppedIds.push(idOf(item));
      continue;
    }
    kept.push(item);
    used += size;
  }

  return { kept, truncated: droppedIds.length > 0, droppedIds };
}
