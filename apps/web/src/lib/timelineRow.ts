// Pure helpers for the timeline view (timeline-view, design.md decision
// 5): which types the address chooses out of the ones the view names, the
// address that a chip toggle writes, how a row's event time and its
// relation to the anchor read. Nothing here is React or touches the DOM;
// TimelineView.tsx renders what these return, and node-environment tests
// in timelineRow.test.ts exercise them without a browser — the pattern
// lib/feedRow.ts and lib/codeTree.ts follow.
//
// The chips come from the view's `filter.nodeTypes`, never from the rows
// (design.md decision 5: derived from the rows they would be unstable
// across pages and empty when nothing is timed), and the selection lives
// in the address (decision 4: repeated `type` parameters, the graph's
// own grammar). The address's types are read against the view's: an
// empty address means every chip; a type the view does not name is
// dropped, so a stale link narrowed to a type the view has since lost
// still shows the rest; and an address whose every type is foreign
// chooses nothing, which is the "no type is chosen" state.
//
// That last rule is also how deselecting the final chip is spelled. The
// address cannot hold an empty list for "nothing chosen" — an empty
// `types` is "every chip", the form the graph's offer pushes — so the
// toggle writes `NO_TYPE_CHOSEN` alone, a marker that names no type any
// view has (node types are words like `work_item` and `gh-issue`; a lone
// dash is a conventional "nothing") and is therefore dropped by the
// intersection like any foreign type. No special case reads it; a hand-
// typed `?type=-` and a last-chip deselect land on the same state. The
// one cost: a view whose own `nodeTypes` includes `-` gets a chip that
// cannot be deselected alone, since the address it would write is the
// marker — a node type nobody has, accepted here rather than special-
// cased.

/** The one address type written when every chip is deselected: foreign to every view, so the intersection is empty and the view says no type is chosen. */
export const NO_TYPE_CHOSEN = "-";

/** What the address chooses out of what the view offers — see `chosenTypes`. */
export interface TypeSelection {
  /** The chips to draw, in the view's order — the view's `nodeTypes`; `null` when the view names none (no chip bar). */
  chips: string[] | null;
  /** The types to read, in the view's order; `null` when the view names none (read every type, `nodeTypes` omitted). Empty when `none`. */
  chosen: string[] | null;
  /** True when the view names types and the address chooses none of them: no read, the "no type is chosen" state. */
  none: boolean;
}

/**
 * The address's `types` read against the view's `nodeTypes` (design.md
 * decision 5). A view with no types offers no chips and reads every type;
 * an empty address chooses every chip; otherwise the chosen set is the
 * intersection in the view's order, a foreign address type dropped; an
 * intersection that comes out empty is `none`.
 */
export function chosenTypes(addressTypes: readonly string[], viewTypes: readonly string[] | null | undefined): TypeSelection {
  if (viewTypes === null || viewTypes === undefined) {
    return { chips: null, chosen: null, none: false };
  }
  const chips = [...new Set(viewTypes)];
  if (addressTypes.length === 0) {
    return { chips, chosen: [...chips], none: false };
  }
  const chosen = chips.filter((type) => addressTypes.includes(type));
  return { chips, chosen, none: chosen.length === 0 };
}

/**
 * The chosen set after a chip is toggled: `type` removed when present,
 * appended when absent (duplicates never introduced). The caller hands
 * this the chosen set — every chip when the address is empty — not the
 * raw address, so deselecting one of two chips leaves the other named.
 */
export function toggleType(types: readonly string[], type: string): string[] {
  return types.includes(type) ? types.filter((t) => t !== type) : [...types, type];
}

/**
 * The `types` the address carries for a chosen set: the set itself, or
 * `NO_TYPE_CHOSEN` alone when it is empty, since an empty address would
 * read as every chip (see the module header).
 */
export function addressTypesFor(chosen: readonly string[]): string[] {
  return chosen.length === 0 ? [NO_TYPE_CHOSEN] : [...chosen];
}

/** A row's event time as shown: `text` for the row, `title` for hover, `iso` for the `<time>` element's `dateTime` — `null` when the value did not parse, so no machine-readable time is claimed for it. See `formatEventTime`. */
export interface EventTimeLabel {
  text: string;
  title: string;
  iso: string | null;
}

export interface FormatEventTimeOptions {
  /** BCP 47 tag; the viewer's own when omitted. */
  locale?: string;
  /** IANA zone; the viewer's own when omitted. Tests pass `UTC` for a fixed answer. */
  timeZone?: string;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** One `Intl.DateTimeFormat` per locale and zone: building one is costly and a page of fifty rows would otherwise build fifty. */
function formatterFor(options: FormatEventTimeOptions): Intl.DateTimeFormat {
  const key = `${options.locale ?? ""}|${options.timeZone ?? ""}`;
  let formatter = formatters.get(key);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat(options.locale, { dateStyle: "medium", timeStyle: "short", timeZone: options.timeZone });
    formatters.set(key, formatter);
  }
  return formatter;
}

/**
 * A row's `occurredAt` as the viewer reads it: date and time in the
 * viewer's locale and zone (`Intl.DateTimeFormat`, medium date, short
 * time) for the row, and the instant's canonical ISO form (`Z`,
 * milliseconds — the form event-time.ts stores) as a stable `title` for
 * hover, so two viewers in two zones see one title. A value that does not
 * parse (reachable only past the contract) is shown as the text it is.
 */
export function formatEventTime(iso: string, options: FormatEventTimeOptions = {}): EventTimeLabel {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return { text: iso, title: iso, iso: null };
  }
  const canonical = date.toISOString();
  return { text: formatterFor(options).format(date), title: canonical, iso: canonical };
}

/** How a row relates to the anchor, as shown: `text` beside the row (the edge type with an arrow), `title` spelling the direction out for hover. */
export interface RelationLabel {
  text: string;
  title: string;
}

/**
 * The relation a row shows (design.md decision 5: the edge type with an
 * arrow for direction). `direction` is as core reports it — as seen from
 * the anchor — so `incoming` is an edge from this row to the anchor
 * (`belongs-to →`: the issue belongs to the repository) and `outgoing` one
 * from the anchor to this row (`← blocks`: the anchor blocks this item).
 * The arrow always points along the edge, with the anchor's side kept
 * away from the row's text.
 */
export function relationLabel(edgeType: string, direction: "incoming" | "outgoing"): RelationLabel {
  return direction === "incoming"
    ? { text: `${edgeType} →`, title: `this item —${edgeType}→ the anchor` }
    : { text: `← ${edgeType}`, title: `the anchor —${edgeType}→ this item` };
}

/**
 * A metadata link's text (design.md decision 5 draws links as the feed
 * does; the review asked for the host rather than the key): `github.com`
 * for `https://github.com/x/y/issues/1`, the key-less fallback being the
 * href itself when it does not parse. The key stays as the link's
 * `title`, so a writer's name for it (`url`, `pr_url`) is still on hover.
 */
export function linkHost(href: string): string {
  try {
    return new URL(href).host || href;
  } catch {
    return href;
  }
}
