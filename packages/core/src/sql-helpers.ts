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

/** The bits of a `pg` `DatabaseError` this package inspects when wrapping a database failure. */
export interface PgErrorLike {
  code?: string;
  constraint?: string;
  detail?: string;
  table?: string;
}

/**
 * Extracts the underlying `pg` driver error from whatever drizzle-orm threw.
 * drizzle-orm's node-postgres driver wraps the real error in a
 * `DrizzleQueryError` and exposes the original as `.cause` — this unwraps
 * that (or falls back to the error itself, if it already looks like a raw
 * driver error) so callers can read `.code`/`.constraint`/`.detail`.
 */
export function asPgError(err: unknown): PgErrorLike | undefined {
  const cause = (err as { cause?: unknown } | undefined)?.cause;
  if (cause && typeof cause === "object") return cause as PgErrorLike;
  if (err && typeof err === "object" && "code" in err) return err as PgErrorLike;
  return undefined;
}

/** Formats a `PgErrorLike` as a short `" (postgres: ...)"` suffix for an error message, or `""` if there isn't one. */
export function formatPgInfo(pg: PgErrorLike | undefined): string {
  if (!pg) return "";
  const parts = [pg.code, pg.constraint, pg.detail].filter(Boolean);
  return parts.length > 0 ? ` (postgres: ${parts.join(" — ")})` : "";
}
