// `fitText`: the fit-and-keep cut shared by the beads importer (beads.ts)
// and the review contract (reviews.ts). Its own module so reviews.ts can use
// it without importing beads.ts, which imports reviews.ts.

/** `value` cut to at most `max` UTF-16 units without splitting a surrogate pair; shorter values, null, and undefined pass through untouched. */
export function fitText(value: string | null | undefined, max: number): string | null | undefined {
  if (typeof value !== "string" || value.length <= max) return value;
  const last = value.charCodeAt(max - 1);
  return value.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}
