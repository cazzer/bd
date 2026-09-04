// Event time (timeline-view change; knowledge-store spec, "Nodes may carry a
// validated event time"): the one metadata key, `occurred_at`, that places
// a node of any type on a timeline, and the normalizer every writer runs
// before anything is persisted.
//
// The contract is enforced here and at every writer — the MCP write tool
// per item, `patchWorkItem` on the merged document, the beads and GitHub
// loaders per mapped row — never by the database and never inside
// `upsertNodes`, exactly as work-items.ts and views.ts do for theirs:
// `node_type` stays open text and the write path knows no metadata key.
//
// The canonical form is `Date.prototype.toISOString()`:
// `YYYY-MM-DDTHH:mm:ss.sssZ`, UTC, millisecond precision, 24 characters
// for every instant in years 0000–9999. Fixed width is the point — two
// canonical values compare chronologically as text, so the timeline read
// orders and pages on `metadata->>'occurred_at'` with no cast and no
// parse. That is also why an instant outside those years is refused
// rather than written in ECMAScript's expanded `±YYYYYY` form: it would
// sort as text before every four-digit year. `closed_at` in
// work-items.ts already stores this form, so the two keys order together.

import { InvalidEventTimeError } from "./errors.js";

export const OCCURRED_AT_KEY = "occurred_at";

const CANONICAL_LENGTH = "2026-03-04T08:00:00.000Z".length;

export interface NormalizeOccurredAtOptions {
  /** Batch position, named as `at batch index N` when `itemLabel` is absent. */
  index?: number;
  /** How `InvalidEventTimeError` names the item — e.g. `at batch index 2 (agent/open-work)`. Wins over `index`. */
  itemLabel?: string;
}

/**
 * Applies the event-time contract to any node's metadata. Pure; returns a
 * copy. A string or `Date` that parses as an instant is rewritten to the
 * canonical form; an absent or `null` value leaves the copy without the
 * key; anything else — a number, an object, an empty or unparseable
 * string, an invalid `Date`, an instant outside years 0000–9999 — throws
 * `InvalidEventTimeError` naming the item and `occurred_at`. Every other
 * key passes through untouched.
 */
export function normalizeOccurredAt(
  metadata: Record<string, unknown> | undefined,
  options: NormalizeOccurredAtOptions = {},
): Record<string, unknown> {
  const input = metadata ?? {};
  const out: Record<string, unknown> = { ...input };
  const value = input[OCCURRED_AT_KEY];

  if (value === undefined || value === null) {
    delete out[OCCURRED_AT_KEY];
    return out;
  }

  const item = options.itemLabel ?? (options.index === undefined ? null : `at batch index ${options.index}`);
  const parsed = typeof value === "string" ? new Date(value) : value instanceof Date ? value : null;
  if (parsed === null) {
    throw new InvalidEventTimeError(item, value, "must be an ISO-8601 timestamp string, a Date, or null");
  }
  if (Number.isNaN(parsed.getTime())) {
    throw new InvalidEventTimeError(item, value, "must parse as an instant (an ISO-8601 timestamp such as 2026-03-04T08:00:00.000Z)");
  }
  const canonical = parsed.toISOString();
  if (canonical.length !== CANONICAL_LENGTH) {
    throw new InvalidEventTimeError(item, value, "must fall within years 0000 to 9999");
  }
  out[OCCURRED_AT_KEY] = canonical;
  return out;
}
