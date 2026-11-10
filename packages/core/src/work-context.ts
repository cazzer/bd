// A work item's memory of what the person decided and what arrived about it
// (inbox-follow-through, design.md decisions 7 and 8). An inbox item is a
// decision about some piece of work, linked to that work by an `about` edge
// (inbox item → work_item). The work item, not the inbox item, keeps:
//
//   decisions — `{ at, decision, note, item? }`: one entry per close, act, or
//               accept-with-note on a linked inbox item, written by the agent
//               that carried it out. `decision` is a short word (close, act,
//               accept, dismiss, …); `note` is the person's direction or a
//               one-line paraphrase; `item` is the inbox item's id.
//   signals   — `{ at, title, url?, gist }`: one entry per signal the ingest
//               folded into the work's history instead of raising a card,
//               because the decisions above already settle it.
//
// Both are optional arrays on a work item's metadata, oldest first, capped
// at the most recent MAX_WORK_CONTEXT_ENTRIES: a longer list keeps its tail,
// so a writer appending to a full list never fails. A malformed entry is
// refused naming the field, through the work-item contract's error, so
// `normalizeWorkItemMetadata` enforces it at every writer. Pure.

import { InvalidWorkItemError } from "./errors.js";

export const ABOUT_EDGE_TYPE = "about";
export const MAX_WORK_CONTEXT_ENTRIES = 50;
export const MAX_WORK_CONTEXT_WORD = 32;
export const MAX_WORK_CONTEXT_TEXT = 500;
export const MAX_WORK_CONTEXT_URL = 2000;

export interface WorkDecision {
  at: string;
  decision: string;
  note: string;
  item?: string;
}

export interface WorkSignal {
  at: string;
  title: string;
  url?: string;
  gist: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function text(entry: Record<string, unknown>, key: string, field: string, max: number, index: number | undefined, required = true): string | undefined {
  const raw = entry[key];
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) {
    if (required) throw new InvalidWorkItemError(`${field}.${key}`, raw, "is required", index);
    return undefined;
  }
  if (typeof raw !== "string" || CONTROL.test(raw) || raw.trim().length > max) {
    throw new InvalidWorkItemError(`${field}.${key}`, raw, `must be a string of at most ${max} characters without control characters`, index);
  }
  return raw.trim();
}

function at(entry: Record<string, unknown>, field: string, index: number | undefined): string {
  const raw = entry["at"];
  const parsed = typeof raw === "string" ? new Date(raw) : new Date(Number.NaN);
  if (Number.isNaN(parsed.getTime())) throw new InvalidWorkItemError(`${field}.at`, raw, "must be an ISO-8601 timestamp", index);
  return parsed.toISOString();
}

function list(raw: unknown, field: string, index: number | undefined): Record<string, unknown>[] {
  if (!Array.isArray(raw)) throw new InvalidWorkItemError(field, raw, "must be an array", index);
  return raw.slice(-MAX_WORK_CONTEXT_ENTRIES).map((entry, i) => {
    if (!isObject(entry)) throw new InvalidWorkItemError(`${field}[${i}]`, entry, "must be an object", index);
    return entry;
  });
}

/** `decisions` and `signals` normalized in place on a work item's metadata copy; absent or null keys are removed. */
export function normalizeWorkContextLog(out: Record<string, unknown>, index?: number): void {
  if (out["decisions"] === undefined || out["decisions"] === null) delete out["decisions"];
  else {
    out["decisions"] = list(out["decisions"], "decisions", index).map((e, i): WorkDecision => {
      const field = `decisions[${i}]`;
      const item = text(e, "item", field, 36, index, false);
      if (item !== undefined && !UUID.test(item)) throw new InvalidWorkItemError(`${field}.item`, item, "must be an inbox item's uuid", index);
      const base: WorkDecision = {
        at: at(e, field, index),
        decision: text(e, "decision", field, MAX_WORK_CONTEXT_WORD, index)!.toLowerCase(),
        note: text(e, "note", field, MAX_WORK_CONTEXT_TEXT, index)!,
      };
      return item === undefined ? base : { ...base, item: item.toLowerCase() };
    });
  }
  if (out["signals"] === undefined || out["signals"] === null) delete out["signals"];
  else {
    out["signals"] = list(out["signals"], "signals", index).map((e, i): WorkSignal => {
      const field = `signals[${i}]`;
      const url = text(e, "url", field, MAX_WORK_CONTEXT_URL, index, false);
      if (url !== undefined && !/^https?:\/\//i.test(url)) throw new InvalidWorkItemError(`${field}.url`, url, "must be an http(s) URL", index);
      const base: WorkSignal = {
        at: at(e, field, index),
        title: text(e, "title", field, MAX_WORK_CONTEXT_TEXT, index)!,
        gist: text(e, "gist", field, MAX_WORK_CONTEXT_TEXT, index)!,
      };
      return url === undefined ? base : { ...base, url };
    });
  }
}
