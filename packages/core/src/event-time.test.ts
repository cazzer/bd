// Pure contract tests — no database. The canonical form's fixed width is
// what the timeline read's text order rests on, so each accepted shape is
// asserted to land on exactly that form.

import { describe, expect, it } from "vitest";
import { InvalidEventTimeError } from "./errors.js";
import { normalizeOccurredAt, OCCURRED_AT_KEY } from "./event-time.js";

function rejection(metadata: Record<string, unknown>, options?: Parameters<typeof normalizeOccurredAt>[1]): InvalidEventTimeError {
  let thrown: unknown;
  try {
    normalizeOccurredAt(metadata, options);
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(InvalidEventTimeError);
  return thrown as InvalidEventTimeError;
}

describe("normalizeOccurredAt", () => {
  it("canonicalizes an offset to Z with milliseconds (spec: a time in another zone is canonicalized)", () => {
    expect(normalizeOccurredAt({ occurred_at: "2026-03-04T10:00:00+02:00" })).toEqual({ occurred_at: "2026-03-04T08:00:00.000Z" });
    expect(normalizeOccurredAt({ occurred_at: "2026-03-04T08:00:00Z" })).toEqual({ occurred_at: "2026-03-04T08:00:00.000Z" });
    expect(normalizeOccurredAt({ occurred_at: "2026-03-04T08:00:00.000Z" })).toEqual({ occurred_at: "2026-03-04T08:00:00.000Z" });
    expect(normalizeOccurredAt({ occurred_at: "2026-03-04T08:00:00.123456Z" })).toEqual({ occurred_at: "2026-03-04T08:00:00.123Z" });
  });

  it("accepts a Date a loader already parsed", () => {
    expect(normalizeOccurredAt({ occurred_at: new Date("2026-03-04T10:00:00+02:00") })).toEqual({ occurred_at: "2026-03-04T08:00:00.000Z" });
  });

  it("absent and null both yield no key (spec: absent means no position)", () => {
    expect(normalizeOccurredAt({ note: "kept" })).toEqual({ note: "kept" });
    expect(normalizeOccurredAt({ occurred_at: null, note: "kept" })).toEqual({ note: "kept" });
    expect(normalizeOccurredAt(undefined)).toEqual({});
    expect(normalizeOccurredAt({ occurred_at: null })).not.toHaveProperty(OCCURRED_AT_KEY);
  });

  it("rejects a number, an object, an unparseable string, an empty string, and an invalid Date, each naming occurred_at", () => {
    for (const value of [1772611200000, { at: "2026-03-04" }, "last Tuesday", "", "   ", true, new Date(Number.NaN)]) {
      const e = rejection({ occurred_at: value });
      expect(e.value).toEqual(value);
      expect(e.message).toMatch(/^invalid event time: occurred_at \(got /);
    }
  });

  it("requires a string to carry a zone or be a date alone, so the instant never depends on the machine (review follow-up)", () => {
    for (const value of ["2026-03-04T10:00:00", "2026-03-04T10:00:00.000", "March 4, 2026", "1", "2026-03-04T10:00:00+0200"]) {
      const e = rejection({ occurred_at: value });
      expect(e.value).toBe(value);
      expect(e.message).toContain("must carry a zone (Z or ±HH:MM)");
    }
    expect(normalizeOccurredAt({ occurred_at: "2026-03-04" })).toEqual({ occurred_at: "2026-03-04T00:00:00.000Z" });
    expect(normalizeOccurredAt({ occurred_at: "2026-03-04T10:00:00-07:00" })).toEqual({ occurred_at: "2026-03-04T17:00:00.000Z" });
    expect(normalizeOccurredAt({ occurred_at: new Date(Date.UTC(2026, 2, 4, 8)) })).toEqual({ occurred_at: "2026-03-04T08:00:00.000Z" });
  });

  it("rejects an instant the fixed-width form cannot carry", () => {
    const e = rejection({ occurred_at: "+010000-01-01T00:00:00Z" });
    expect(e.message).toContain("years 0000 to 9999");
  });

  it("names the item by label, else by batch index, else not at all", () => {
    expect(rejection({ occurred_at: "nope" }, { itemLabel: "at batch index 2 (agent/x)", index: 9 }).message).toBe(
      'invalid event time at batch index 2 (agent/x): occurred_at (got "nope") must parse as an instant (an ISO-8601 timestamp such as 2026-03-04T08:00:00.000Z)',
    );
    const byIndex = rejection({ occurred_at: "nope" }, { index: 4 });
    expect(byIndex.item).toBe("at batch index 4");
    expect(byIndex.message).toContain("invalid event time at batch index 4: occurred_at");
    expect(rejection({ occurred_at: "nope" }).item).toBeNull();
  });

  it("does not mutate its input and passes every other key through untouched", () => {
    const input = { occurred_at: "2026-03-04T10:00:00+02:00", status: "open", nested: { a: 1 } };
    const out = normalizeOccurredAt(input);
    expect(input.occurred_at).toBe("2026-03-04T10:00:00+02:00");
    expect(out).not.toBe(input);
    expect(out).toEqual({ occurred_at: "2026-03-04T08:00:00.000Z", status: "open", nested: { a: 1 } });
    expect(out["nested"]).toBe(input.nested);

    const nulled = { occurred_at: null };
    normalizeOccurredAt(nulled);
    expect(nulled).toEqual({ occurred_at: null });
  });
});
