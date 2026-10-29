// Pure helpers behind the board view (live-beads-board, design.md decisions
// 6-7): column order and labels, epic lanes, card order, project chips and
// their round-trip through the address, and highlight expiry. The only
// import from @breakdown/core is a TYPE — a runtime import would drag the
// server package (postgres, drizzle) into the browser bundle — so the
// column list and the project-key pattern are duplicated here, and
// boardRow.test.ts pins them to core's own.

import type { BoardColumn } from "@breakdown/core";

export type { BoardColumn };

/** Columns left to right, with their labels. Mirrors core's `BOARD_COLUMNS`. */
export const BOARD_COLUMN_ORDER: ReadonlyArray<{ id: BoardColumn; label: string }> = [
  { id: "ready", label: "Ready" },
  { id: "blocked", label: "Blocked" },
  { id: "in_progress", label: "In progress" },
  { id: "deferred", label: "Deferred" },
  { id: "closed", label: "Closed" },
];

/** Mirrors core's `PROJECT_KEY_PATTERN`; a key the server would refuse must never be sent. */
export const PROJECT_KEY_PATTERN = /^[a-z0-9._-]{1,64}$/;
/** Mirrors core's `MAX_BOARD_PROJECTS`. */
export const MAX_BOARD_PROJECTS = 20;
/** How long a card changed by a live event stays highlighted. */
export const HIGHLIGHT_MS = 4000;

/** The wire shape of one card (`board` over tRPC; `updatedAt` is an ISO string). */
export interface BoardCardRow {
  id: string;
  externalId: string;
  title: string;
  project: string;
  priority: number;
  issueType: string | null;
  column: BoardColumn;
  epicId: string | null;
  blockedFlag: boolean;
  updatedAt: string;
  /** Labelled `review`: the card is marked, and its drawer shows the review. */
  review: boolean;
}

export interface BoardEpicRow {
  id: string;
  title: string;
  status: string;
  project: string | null;
}

export interface BoardLane {
  /** The epic's node id; null for the "No epic" lane. */
  epicId: string | null;
  title: string;
  status: string | null;
  project: string | null;
  collapsedByDefault: boolean;
  cardCount: number;
  columns: Record<BoardColumn, BoardCardRow[]>;
}

export const NO_EPIC_TITLE = "No epic";

/** Priority most urgent first, then most recently updated, then id — a total order, so a re-read never reshuffles equal cards. */
export function compareCards(a: BoardCardRow, b: BoardCardRow): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function emptyColumns(): Record<BoardColumn, BoardCardRow[]> {
  return { ready: [], blocked: [], in_progress: [], deferred: [], closed: [] };
}

/**
 * Cards grouped into epic lanes, each lane split into columns. Epic lanes
 * come first — lanes with live work before collapsed (epic closed, every
 * card closed) ones, each by title — and "No epic" is always last. A card
 * naming an epic the answer does not carry falls into "No epic" rather than
 * vanishing. An epic with no cards still heads a lane.
 */
export function buildLanes(cards: readonly BoardCardRow[], epics: readonly BoardEpicRow[]): BoardLane[] {
  const known = new Map(epics.map((e) => [e.id, e]));
  const lanes = new Map<string | null, BoardLane>();
  for (const epic of epics) {
    lanes.set(epic.id, { epicId: epic.id, title: epic.title, status: epic.status, project: epic.project, collapsedByDefault: false, cardCount: 0, columns: emptyColumns() });
  }
  const noEpic: BoardLane = { epicId: null, title: NO_EPIC_TITLE, status: null, project: null, collapsedByDefault: false, cardCount: 0, columns: emptyColumns() };
  lanes.set(null, noEpic);

  for (const card of cards) {
    const lane = (card.epicId !== null && lanes.get(card.epicId)) || noEpic;
    lane.columns[card.column].push(card);
    lane.cardCount += 1;
  }

  for (const lane of lanes.values()) {
    for (const col of BOARD_COLUMN_ORDER) lane.columns[col.id].sort(compareCards);
    const allClosed = BOARD_COLUMN_ORDER.every((col) => col.id === "closed" || lane.columns[col.id].length === 0);
    lane.collapsedByDefault = lane.epicId !== null && known.get(lane.epicId)?.status === "closed" && allClosed;
  }

  const epicLanes = [...lanes.values()].filter((l) => l.epicId !== null);
  epicLanes.sort((a, b) => Number(a.collapsedByDefault) - Number(b.collapsedByDefault) || a.title.localeCompare(b.title) || (a.epicId! < b.epicId! ? -1 : 1));
  // The "No epic" lane is omitted when empty; a board with no cards at all draws nothing.
  return noEpic.cardCount > 0 ? [...epicLanes, noEpic] : epicLanes;
}

// ---------------------------------------------------------------- chips

/**
 * The project keys a view's filter offers as chips: its `project` predicate
 * (`equals` or `oneOf`), or null when it names none — the caller then
 * offers every registered project. Only string values count.
 */
export function filterProjects(where: unknown): string[] | null {
  if (!Array.isArray(where)) return null;
  const keys: string[] = [];
  let named = false;
  for (const p of where) {
    if (typeof p !== "object" || p === null || (p as { key?: unknown }).key !== "project") continue;
    const pred = p as { op?: unknown; value?: unknown; values?: unknown };
    const values = pred.op === "equals" ? [pred.value] : pred.op === "oneOf" && Array.isArray(pred.values) ? pred.values : null;
    if (values === null) continue;
    named = true;
    for (const v of values) if (typeof v === "string" && !keys.includes(v)) keys.push(v);
  }
  return named ? keys : null;
}

/** The chips offered: the view's projects, or every registered key when it names none. Order is the view's own (or the registry's), deduplicated. */
export function offeredChips(viewProjects: readonly string[] | null, registered: readonly string[]): string[] {
  return [...new Set(viewProjects ?? registered)];
}

/**
 * The chips that are selected: the address's projects that are offered, in
 * chip order; every offered chip when the address names none that is
 * offered (a stale or hand-edited `?project=` degrades to the full board).
 */
export function chosenChips(offered: readonly string[], address: readonly string[]): string[] {
  const picked = offered.filter((key) => address.includes(key));
  return picked.length > 0 ? picked : [...offered];
}

/**
 * The address's `project` list after toggling `key`, put in chip order; the
 * empty list (all chips selected) when the result is every chip. The last
 * selected chip cannot be deselected — the address has no way to say "none".
 */
export function toggleChip(offered: readonly string[], address: readonly string[], key: string): string[] {
  const chosen = chosenChips(offered, address);
  const next = chosen.includes(key) ? chosen.filter((k) => k !== key) : offered.filter((k) => k === key || chosen.includes(k));
  if (next.length === 0) return chosen.length === offered.length ? [] : [...chosen];
  return next.length === offered.length ? [] : next;
}

/** The `projects` a `board` read may carry: chosen chips the server would accept, at most the server's cap. Empty means nothing is readable (nothing is offered). */
export function readableProjects(chosen: readonly string[]): string[] {
  return chosen.filter((k) => PROJECT_KEY_PATTERN.test(k)).slice(0, MAX_BOARD_PROJECTS);
}

// ----------------------------------------------------------- highlights

/** Card id -> the instant (ms) its highlight ends. */
export type Highlights = ReadonlyMap<string, number>;

export function addHighlights(current: Highlights, ids: readonly string[], now: number): Highlights {
  const next = new Map(pruneHighlights(current, now));
  for (const id of ids) next.set(id, now + HIGHLIGHT_MS);
  return next;
}

export function pruneHighlights(current: Highlights, now: number): Highlights {
  const next = new Map<string, number>();
  for (const [id, until] of current) if (until > now) next.set(id, until);
  return next;
}

/** The earliest instant a highlight expires, or null when none is active. */
export function nextHighlightExpiry(current: Highlights): number | null {
  let min: number | null = null;
  for (const until of current.values()) if (min === null || until < min) min = until;
  return min;
}
