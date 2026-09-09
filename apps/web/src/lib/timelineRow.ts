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

/**
 * One `Intl.DateTimeFormat` per (kind, locale, zone): building one is
 * costly and a page of fifty rows would otherwise build fifty of each.
 * `kind` names the shape asked for — the full instant, the time of day, a
 * day header, a day key — so the four never collide in the cache.
 * `locale` overrides the viewer's, which only the day KEY does (it needs
 * a Gregorian, numeric answer regardless of who is reading).
 */
function formatterFor(kind: string, options: FormatEventTimeOptions, init: Intl.DateTimeFormatOptions, locale?: string): Intl.DateTimeFormat {
  const tag = locale ?? options.locale;
  const key = `${kind}|${tag ?? ""}|${options.timeZone ?? ""}`;
  let formatter = formatters.get(key);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat(tag, { ...init, timeZone: options.timeZone });
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
  return { text: formatterFor("instant", options, { dateStyle: "medium", timeStyle: "short" }).format(date), title: canonical, iso: canonical };
}

/**
 * The same instant with the DATE dropped (readable-graph-and-timeline,
 * design.md decision 7): a row inside a day group carries only its time
 * of day, because the group's header already states the date and the
 * spec forbids repeating it on every row. The `title` stays the canonical
 * instant, so the full date is one hover away and no information is lost
 * by the demotion.
 */
export function formatTimeOfDay(iso: string, options: FormatEventTimeOptions = {}): EventTimeLabel {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return { text: iso, title: iso, iso: null };
  }
  const canonical = date.toISOString();
  return { text: formatterFor("time", options, { timeStyle: "short" }).format(date), title: canonical, iso: canonical };
}

/** How a row relates to the anchor, as shown: `text` beside the row (the edge type with an arrow), `title` spelling the direction out for hover. */
export interface RelationLabel {
  text: string;
  title: string;
}

/**
 * Edge types whose spelled-out reading is a phrase rather than the generic
 * "this item —X→ the anchor" sentence (github-prs-and-commits, design.md
 * decision 5): `closes` — a pull request row on an issue's timeline closes
 * the anchor, and an issue row on a pull request's timeline is closed by
 * it — and `touches` — a commit row on a file's timeline touches the
 * anchor, and a file row on a commit's timeline is touched by it. The
 * phrase is the hover title and the screen-reader text; the visible pill
 * keeps the arrow form for every type so rows of mixed types read alike.
 * A `Map`, not an object, so an edge type named like an inherited key
 * (`constructor`) falls through to the generic sentence.
 */
const RELATION_WORDING: ReadonlyMap<string, Readonly<Record<"incoming" | "outgoing", string>>> = new Map([
  ["closes", { incoming: "closes", outgoing: "is closed by" }],
  ["touches", { incoming: "touches", outgoing: "is touched by" }],
]);

/**
 * The relation a row shows (design.md decision 5: the edge type with an
 * arrow for direction). `direction` is as core reports it — as seen from
 * the anchor — so `incoming` is an edge from this row to the anchor
 * (`belongs-to →`: the issue belongs to the repository) and `outgoing` one
 * from the anchor to this row (`← blocks`: the anchor blocks this item).
 * The arrow always points along the edge, with the anchor's side kept
 * away from the row's text. The title spells the direction out — as a
 * phrase for the types `RELATION_WORDING` names, the edge type between
 * the two ends otherwise.
 */
export function relationLabel(edgeType: string, direction: "incoming" | "outgoing"): RelationLabel {
  const text = direction === "incoming" ? `${edgeType} →` : `← ${edgeType}`;
  const wording = RELATION_WORDING.get(edgeType);
  if (wording !== undefined) {
    return { text, title: `this item ${wording[direction]} the anchor` };
  }
  return { text, title: direction === "incoming" ? `this item —${edgeType}→ the anchor` : `the anchor —${edgeType}→ this item` };
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

// --- Day groups and elapsed time (readable-graph-and-timeline, design.md
// decision 7) --------------------------------------------------------------
//
// The flat list this replaces drew fifty identically spaced cards, each
// repeating the same date: the page conveyed ORDER and nothing else,
// which is the one thing a table already does better. Two channels are
// added, both here rather than in the view, so both are testable without
// a DOM.
//
// SPACING is a clamped log of the elapsed interval, not a proportion of
// it. Proportional spacing is what makes a timeline unusable: one item a
// year old pushes everything else off the page, and the fifty items that
// matter — minutes apart — collapse onto one pixel. The observed page
// (the `breakdown` repository's commits) runs 0.8 minutes to 30 hours
// between consecutive rows, a factor of 2000; log compresses that into
// 8-112px, and anything at or under an hour draws the FLOOR so a burst
// packs tight. Past `GAP_CEILING_MS` the spacing stops growing entirely —
// that bound is what the spec means by "one very old item cannot push
// the rest of the list off the page" — and past `GAP_LABEL_MS` the gap
// also names itself ("18 hours earlier"), which is the only way an
// interval larger than the ceiling is still reported honestly.
//
// "earlier", not design.md's "3 weeks later": rows are newest-first, so
// reading DOWN the page moves BACK in time. The interval is the same
// either way; the wording follows the direction the reader is actually
// travelling.
//
// GROUPING is by calendar day in the viewer's own zone, with the day
// named once on the group's header (spec: "A date is stated once per
// group, not once per row"). The day key is computed in a fixed
// `en-US` locale so it is Gregorian and numeric whoever is reading,
// while the label is formatted in the viewer's locale — the key decides
// where a group breaks, the label only says what to call it.

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Spacing for consecutive rows at or under `GAP_FLOOR_MS` — Tailwind's `gap-2`, the spacing the flat list used for everything. */
export const GAP_FLOOR_PX = 8;
/** Spacing at or past `GAP_CEILING_MS`, and the most any gap can ever take: roughly a row and a half, so a long gap reads without costing a screenful. */
export const GAP_CEILING_PX = 112;
/** At or under this, rows are drawn as one burst — the floor. */
export const GAP_FLOOR_MS = HOUR_MS;
/** At or past this, spacing stops growing; the interval is carried by the label instead. */
export const GAP_CEILING_MS = 7 * DAY_MS;
/** Past this, the gap also names itself. Six hours is a stretch nobody worked through, and on the observed page it marks 3 of 49 gaps rather than every overnight pause. */
export const GAP_LABEL_MS = 6 * HOUR_MS;

/** The space between two consecutive rows: the interval itself, the pixels it is drawn as (bounded), and the words for it past `GAP_LABEL_MS`. */
export interface TimelineGap {
  /** Elapsed milliseconds, absolute — 0 when either end did not parse. */
  ms: number;
  spacingPx: number;
  /** `null` under `GAP_LABEL_MS`: an ordinary gap is drawn, not narrated. */
  label: string | null;
}

/** Largest unit first; `ms` is the threshold at which that unit is chosen. */
const INTERVAL_UNITS: readonly { ms: number; name: string }[] = [
  { ms: 365 * DAY_MS, name: "year" },
  { ms: 30 * DAY_MS, name: "month" },
  { ms: 7 * DAY_MS, name: "week" },
  { ms: DAY_MS, name: "day" },
  { ms: HOUR_MS, name: "hour" },
  { ms: MINUTE_MS, name: "minute" },
];

/**
 * The interval in the largest unit that fits, FLOORED — 21 days is "3
 * weeks", never the "1 month" that rounding to the next unit up would
 * produce. Under a minute there is nothing worth naming.
 */
function describeInterval(ms: number): string | null {
  for (const unit of INTERVAL_UNITS) {
    if (ms >= unit.ms) {
      const n = Math.floor(ms / unit.ms);
      return `${n} ${unit.name}${n === 1 ? "" : "s"} earlier`;
    }
  }
  return null;
}

/** The clamped log described in this section's header. */
function spacingForInterval(ms: number): number {
  if (ms <= GAP_FLOOR_MS) {
    return GAP_FLOOR_PX;
  }
  if (ms >= GAP_CEILING_MS) {
    return GAP_CEILING_PX;
  }
  const t = Math.log(ms / GAP_FLOOR_MS) / Math.log(GAP_CEILING_MS / GAP_FLOOR_MS);
  return Math.round(GAP_FLOOR_PX + (GAP_CEILING_PX - GAP_FLOOR_PX) * t);
}

/**
 * The gap between two rows' event times, in either order — the magnitude
 * is what is drawn, so the caller need not know which of the two is
 * newer. A value that does not parse (reachable only past the
 * `occurred_at` contract) yields the floor and no label rather than a
 * `NaN` margin.
 */
export function gapBetween(a: string, b: string): TimelineGap {
  const from = new Date(a).getTime();
  const to = new Date(b).getTime();
  if (Number.isNaN(from) || Number.isNaN(to)) {
    return { ms: 0, spacingPx: GAP_FLOOR_PX, label: null };
  }
  const ms = Math.abs(from - to);
  return { ms, spacingPx: spacingForInterval(ms), label: ms >= GAP_LABEL_MS ? describeInterval(ms) : null };
}

/** Anything with an event time — the timeline's rows, and nothing more, so these helpers stay testable without a server type. */
export interface TimedRow {
  occurredAt: string;
}

/** One row inside a group, with the gap between it and the row ABOVE it; `null` for a group's first row, whose gap belongs to the group (see `TimelineDayGroup.gap`). */
export interface TimelineEntry<T> {
  row: T;
  gap: TimelineGap | null;
}

/** A calendar day's rows. `gap` is the interval between the previous group's last row and this group's first — `null` for the first group on the page. */
export interface TimelineDayGroup<T> {
  /** `YYYY-MM-DD` in the viewer's zone; `?<value>` for a row whose time did not parse, which therefore groups alone. */
  key: string;
  /** The day as the viewer reads it — what the group's header says. */
  label: string;
  gap: TimelineGap | null;
  entries: TimelineEntry<T>[];
}

/** A fixed locale for the day KEY: numeric and Gregorian whoever is reading, so a viewer whose own locale uses another calendar still breaks groups on the same days everyone else does. */
const DAY_KEY_LOCALE = "en-US";

/** `YYYY-MM-DD` in the viewer's zone, plus the label for it. */
function dayOf(iso: string, options: FormatEventTimeOptions): { key: string; label: string } {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return { key: `?${iso}`, label: iso };
  }
  const parts = formatterFor("day-key", options, { year: "numeric", month: "2-digit", day: "2-digit" }, DAY_KEY_LOCALE).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    key: `${part("year")}-${part("month")}-${part("day")}`,
    label: formatterFor("day-label", options, { weekday: "short", month: "short", day: "numeric", year: "numeric" }).format(date),
  };
}

/**
 * The rows split into calendar-day groups, in the order they were given
 * (the read hands them over newest first, and this never re-sorts — a
 * page that arrived in another order stays in it). Each row past the
 * first carries the gap to the row above it, and each group past the
 * first carries the gap across its boundary, so the view has one number
 * to render as space and one optional phrase to render as a marker
 * without doing any date arithmetic of its own.
 *
 * Two runs of the same day that are not adjacent produce two groups
 * rather than being merged — merging would reorder the page, which the
 * cursor's total order (packages/core/src/timeline.ts) is what it is to
 * avoid. Callers therefore key groups by position, not by `key` alone.
 */
export function groupRowsByDay<T extends TimedRow>(rows: readonly T[], options: FormatEventTimeOptions = {}): TimelineDayGroup<T>[] {
  const groups: TimelineDayGroup<T>[] = [];
  let previous: string | null = null;
  for (const row of rows) {
    const { key, label } = dayOf(row.occurredAt, options);
    const gap = previous === null ? null : gapBetween(previous, row.occurredAt);
    const last = groups[groups.length - 1];
    if (last !== undefined && last.key === key) {
      last.entries.push({ row, gap });
    } else {
      groups.push({ key, label, gap, entries: [{ row, gap: null }] });
    }
    previous = row.occurredAt;
  }
  return groups;
}

// --- Chip counts (readable-graph-and-timeline, tasks.md 5.5) --------------
//
// What a chip can honestly say. `timeline` answers ONE narrowing per
// call: the rows it returns are the chosen types' rows, capped at the
// page size, and it reports no per-type breakdown. Counting the loaded
// rows is therefore the only figure available without a second read per
// chip or a new procedure — and design.md's Non-Goals rule out the new
// procedure explicitly.
//
// So the figure is stated for what it is. A CHOSEN chip reports its
// share of the rows on screen, under a caption naming that scope
// ("counts are of the 50 rows loaded — more exist"); a chip reporting
// zero is drawn distinguishably, and its title says the count is of the
// loaded rows rather than of the store. A DESELECTED chip reports no
// number at all: its rows were never asked for, so the page says nothing
// about it, and printing "0" there would be the one reading that is
// actually false.

/** How many of `rows` carry each node type — the loaded page's composition. */
export function countRowsByType(rows: readonly { nodeType: string }[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.nodeType, (counts.get(row.nodeType) ?? 0) + 1);
  }
  return counts;
}

/** What one chip reports: `text` beside its name (`null` prints no number), `empty` for the distinguishable zero, `title` naming the scope of the figure. */
export interface ChipCountLabel {
  text: string | null;
  empty: boolean;
  title: string;
}

/**
 * The count for one chip, against the loaded page's composition. `chosen`
 * is the current narrowing (`chosenTypes(...).chosen`); a type outside it
 * gets no number, because no row of that type was read. See this
 * section's header for why the loaded page is the only honest source.
 */
export function chipCountLabel(type: string, chosen: readonly string[] | null, counts: ReadonlyMap<string, number>): ChipCountLabel {
  if (chosen !== null && !chosen.includes(type)) {
    return { text: null, empty: false, title: `${type} is deselected — the loaded rows say nothing about how many it would show` };
  }
  const count = counts.get(type) ?? 0;
  return {
    text: String(count),
    empty: count === 0,
    title: count === 0 ? `no ${type} among the rows loaded` : `${count} of the rows loaded ${count === 1 ? "is a" : "are"} ${type}`,
  };
}

/** The one caption under the chips that gives every count its scope — the loaded page, never the store. */
export function chipCountsCaption(loaded: number, hasMore: boolean): string {
  return hasMore ? `counts are of the ${loaded} rows loaded — more exist` : `counts are of all ${loaded} rows`;
}
