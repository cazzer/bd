// Pure substring match of typed search text against known node types
// (bd-73t, design.md "Search bar: minimal, and it searches types too").
// A small, in-memory match over getStoreSummary().nodeTypes — no new
// endpoint, per design.md's own "why a substring match on already-
// fetched types, not a new endpoint" rationale (at most a handful of
// node_type values exist store-wide).
//
// Two-arg signature exactly as design.md specifies (`matchNodeTypes(typed:
// string, nodeTypes: NodeTypeCount[]): NodeTypeCount[]`) — excluding
// already-chosen chips is left to the call site (App.tsx), which already
// holds the chip list and has no reason to make this function depend on
// it too.

import type { TypeCount } from "../graph/typePrevalence.js";

/**
 * Node types whose name contains `typed` (case-insensitive, matched
 * against the trimmed input), ranked by count descending then name
 * ascending on a tie — the same tie-break `typePrevalence.ts` uses, so
 * every type-ranked list in the app orders identically. Empty (or
 * all-whitespace) input returns `[]`: no typed text means no suggestion
 * to offer, not "every type matches," even though an empty string is
 * technically a substring of everything.
 */
export function matchNodeTypes(typed: string, nodeTypes: readonly TypeCount[]): TypeCount[] {
  const needle = typed.trim().toLowerCase();
  if (needle.length === 0) {
    return [];
  }
  return nodeTypes
    .filter((t) => t.nodeType.toLowerCase().includes(needle))
    .sort((a, b) => b.count - a.count || a.nodeType.localeCompare(b.nodeType));
}
