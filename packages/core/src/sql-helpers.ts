import { sql, type SQL } from "drizzle-orm";

/** Splits `items` into consecutive slices of at most `size` elements. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size <= 0) {
    throw new RangeError(`chunk size must be a positive integer, got ${size}`);
  }
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Builds a Postgres `ARRAY[...]::pgType[]` literal from JS values, one bound
 * parameter per element, for feeding `unnest(...)` in the batch upsert
 * queries (nodes.ts, edges.ts).
 *
 * Binding a whole JS array as a single drizzle-orm `sql` parameter does not
 * work for this: drizzle's `sql` tag renders an interpolated array as a SQL
 * "row" literal (`($1, $2, ...)`), not a Postgres array — `unnest()` can't
 * consume that. Building the `ARRAY[...]` constructor explicitly, with each
 * element as its own placeholder, is the reliable way to pass an array
 * parameter through drizzle's query builder.
 *
 * `pgType` must always be a literal under our control (e.g. "text",
 * "uuid", "real", "jsonb") — it is spliced in as raw SQL, never a
 * parameter, because Postgres has no way to bind a type name. It must
 * never be derived from caller input.
 */
export function sqlArray(values: readonly unknown[], pgType: string): SQL {
  return sql`ARRAY[${sql.join(
    values.map((v) => sql`${v}`),
    sql.raw(","),
  )}]::${sql.raw(pgType)}[]`;
}
