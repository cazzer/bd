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
//
// A string must say which zone it is in. `new Date("2026-03-04T10:00:00")`
// is the machine's local time under the ECMAScript grammar, and the legacy
// parser behind `"March 4, 2026"` or `"1"` is looser still — the same
// string would canonicalize to two instants on two machines, which is the
// one thing a canonical form must not do. So a string is accepted only
// with a trailing `Z` or `±HH:MM`, or as a date alone (`YYYY-MM-DD`, which
// the grammar reads as UTC midnight). A `Date` already is an instant and
// needs no rule.
//
// The rule is one function over one key, `normalizeInstantKey`, so every
// instant-valued key shares it: `occurred_at` here, and the work-item
// contract's planning dates `due_at` and `started_at` (work-items.ts),
// which the roadmap compares and takes `min()` of as text for the same
// fixed-width reason.

import { InvalidEventTimeError } from "./errors.js";

export const OCCURRED_AT_KEY = "occurred_at";

const CANONICAL_LENGTH = "2026-03-04T08:00:00.000Z".length;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ZONED_RE = /(?:Z|[+-]\d{2}:\d{2})$/;

export interface NormalizeInstantOptions {
  /** Batch position, named as `at batch index N` when `itemLabel` is absent. */
  index?: number;
  /** How `InvalidEventTimeError` names the item — e.g. `at batch index 2 (agent/open-work)`. Wins over `index`. */
  itemLabel?: string;
}

export type NormalizeOccurredAtOptions = NormalizeInstantOptions;

/**
 * Applies the instant rule to one metadata key. Pure; returns a copy. A
 * `Date`, or a string that parses as an instant and carries a zone (`Z` or
 * `±HH:MM`) or is a date alone (`YYYY-MM-DD`, UTC midnight), is rewritten
 * to the canonical form; an absent or `null` value leaves the copy without
 * the key; anything else — a number, an object, an empty or unparseable
 * string, a zone-less date-time, an invalid `Date`, an instant outside
 * years 0000–9999 — throws `InvalidEventTimeError` naming the item and
 * `key`. Every other key passes through untouched.
 */
export function normalizeInstantKey(
  metadata: Record<string, unknown> | undefined,
  key: string,
  options: NormalizeInstantOptions = {},
): Record<string, unknown> {
  const input = metadata ?? {};
  const out: Record<string, unknown> = { ...input };
  const value = input[key];

  if (value === undefined || value === null) {
    delete out[key];
    return out;
  }

  const item = options.itemLabel ?? (options.index === undefined ? null : `at batch index ${options.index}`);
  const refuse = (reason: string) => new InvalidEventTimeError(item, value, reason, key);
  const parsed = typeof value === "string" ? new Date(value) : value instanceof Date ? value : null;
  if (parsed === null) {
    throw refuse("must be an ISO-8601 timestamp string, a Date, or null");
  }
  if (Number.isNaN(parsed.getTime())) {
    throw refuse("must parse as an instant (an ISO-8601 timestamp such as 2026-03-04T08:00:00.000Z)");
  }
  if (typeof value === "string" && !DATE_ONLY_RE.test(value) && !ZONED_RE.test(value)) {
    throw refuse("must carry a zone (Z or ±HH:MM), or be a date alone (YYYY-MM-DD, read as UTC midnight)");
  }
  const canonical = parsed.toISOString();
  if (canonical.length !== CANONICAL_LENGTH) {
    throw refuse("must fall within years 0000 to 9999");
  }
  out[key] = canonical;
  return out;
}

/** Applies the event-time contract to any node's metadata: `normalizeInstantKey` on `occurred_at`. */
export function normalizeOccurredAt(
  metadata: Record<string, unknown> | undefined,
  options: NormalizeOccurredAtOptions = {},
): Record<string, unknown> {
  return normalizeInstantKey(metadata, OCCURRED_AT_KEY, options);
}
