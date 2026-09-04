// Structured listing (work-items change; knowledge-store spec, "Nodes can
// be listed by structure without query text"): canonical nodes selected by
// node type, source system, recency, and validated predicates on
// top-level metadata keys — no search text involved.
//
// Every metadata predicate compiles to a jsonb containment test
// (`metadata @> '{...}'`): `equals` predicates are merged into one object,
// a `oneOf` predicate becomes a disjunction of one containment per value.
// That is the only operator ever issued against `metadata`, which is why
// `nodes_metadata_gin_idx` is a `jsonb_path_ops` index (schema.ts). Keys
// and values are bound as parameters; there is no path by which a caller
// composes an expression.
//
// Results come from `resolved_nodes` (canonical rows only — a merged-away
// node is not listed), ordered `updated_at DESC, id DESC`, and paged by a
// keyset cursor under that same order (lookup.ts's convention: one row past
// the limit answers `hasMore`, a NULL cursor is the first page). The cursor
// carries `updated_at` rendered by Postgres at microsecond precision, not
// a JS Date: timestamptz has microsecond precision and a millisecond
// round-trip could repeat or skip a row. Content is never returned —
// brain_get is for that.

import { sql, type SQL } from "drizzle-orm";
import type { Database } from "@breakdown/db";
import { InvalidListOptionError, LookupFailedError } from "./errors.js";
import { asPgError, formatPgInfo, sqlArray } from "./sql-helpers.js";

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;
export const MAX_LIST_PREDICATES = 10;
/** Max entries in `nodeTypes` / `sourceSystems`. */
export const MAX_LIST_NAMES = 50;
export const MAX_ONE_OF_VALUES = 20;
export const MAX_PREDICATE_KEY_LENGTH = 100;
export const MAX_PREDICATE_STRING_LENGTH = 500;

export type MetadataScalar = string | number | boolean | null;

export type MetadataPredicate =
  | { key: string; op: "equals"; value: MetadataScalar }
  | { key: string; op: "oneOf"; values: readonly MetadataScalar[] };

/** Opaque to callers: pass a previous result's `nextCursor` back unchanged. */
export interface ListNodesCursor {
  /** `updated_at` as microsecond-precision ISO-8601 UTC — see the module header. */
  updatedAt: string;
  id: string;
}

export interface ListNodesOptions {
  nodeTypes?: readonly string[] | null;
  sourceSystems?: readonly string[] | null;
  /** Nodes updated at or after this instant. A Date or an ISO-8601 string. */
  updatedSince?: Date | string | null;
  where?: readonly MetadataPredicate[] | null;
  /** Default `DEFAULT_LIST_LIMIT` (50), max `MAX_LIST_LIMIT` (500). */
  limit?: number;
  cursor?: ListNodesCursor | null;
}

export interface ListedNode {
  id: string;
  nodeType: string;
  sourceSystem: string;
  externalId: string;
  title: string;
  metadata: Record<string, unknown>;
  contentHash: string;
  createdAt: Date;
  updatedAt: Date;
  /** This node's keyset position: pass as `cursor` to continue after it. Lets a caller that trims the page (the MCP response budget) still resume correctly. */
  cursor: ListNodesCursor;
}

export interface ListNodesResult {
  nodes: ListedNode[];
  hasMore: boolean;
  nextCursor: ListNodesCursor | null;
}

export interface BuildListNodesQueryParams {
  nodeTypes: readonly string[] | null;
  sourceSystems: readonly string[] | null;
  /** ISO-8601 text; null = no lower bound. */
  updatedSince: string | null;
  where: readonly MetadataPredicate[];
  limit: number;
  cursor: ListNodesCursor | null;
}

type RawListedRow = {
  id: string;
  node_type: string;
  source_system: string;
  external_id: string;
  title: string;
  metadata: Record<string, unknown>;
  content_hash: string;
  created_at: string;
  updated_at: string;
  /** `updated_at` rendered as microsecond ISO-8601 UTC — the rendering the cursor must carry. */
  updated_at_text: string;
};

function nullableTextArray(values: readonly string[] | null): SQL {
  return values === null ? sql`NULL::text[]` : sqlArray(values, "text");
}

/** Pure: builds the listing statement from already-validated params. */
export function buildListNodesQuery(params: BuildListNodesQueryParams): SQL {
  const nodeTypesArr = nullableTextArray(params.nodeTypes);
  const sourceSystemsArr = nullableTextArray(params.sourceSystems);
  const updatedSince = params.updatedSince === null ? sql`NULL::timestamptz` : sql`${params.updatedSince}::timestamptz`;
  const cursorUpdatedAt = params.cursor === null ? sql`NULL::timestamptz` : sql`${params.cursor.updatedAt}::timestamptz`;
  const cursorId = params.cursor === null ? sql`NULL::uuid` : sql`${params.cursor.id}::uuid`;

  // Every `equals` predicate folds into one containment object; an empty
  // object is contained by everything, so "no equals predicates" costs
  // nothing and needs no second code path.
  // A null-prototype object: on a plain object an assignment to "__proto__"
  // is a no-op and JSON.stringify omits it, which would silently widen the
  // list. validatePredicates rejects those keys too; this is the backstop.
  const equalsObject: Record<string, MetadataScalar> = Object.create(null) as Record<string, MetadataScalar>;
  const oneOfClauses: SQL[] = [];
  for (const predicate of params.where) {
    if (predicate.op === "equals") {
      equalsObject[predicate.key] = predicate.value;
    } else {
      oneOfClauses.push(
        sql`(${sql.join(
          predicate.values.map((v) => sql`n.metadata @> ${JSON.stringify({ [predicate.key]: v })}::jsonb`),
          sql.raw(" OR "),
        )})`,
      );
    }
  }
  const oneOfFilter = oneOfClauses.length === 0 ? sql`TRUE` : sql.join(oneOfClauses, sql.raw(" AND "));

  return sql`
SELECT n.id, n.node_type, n.source_system, n.external_id, n.title, n.metadata, n.content_hash,
       n.created_at, n.updated_at,
       -- Rendered explicitly at microsecond precision in UTC so the cursor
       -- round-trips regardless of the session's DateStyle.
       to_char(n.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at_text
FROM resolved_nodes n
WHERE (${nodeTypesArr} IS NULL OR n.node_type = ANY(${nodeTypesArr}))
  AND (${sourceSystemsArr} IS NULL OR n.source_system = ANY(${sourceSystemsArr}))
  AND (${updatedSince} IS NULL OR n.updated_at >= ${updatedSince})
  AND n.metadata @> ${JSON.stringify(equalsObject)}::jsonb
  AND ${oneOfFilter}
  -- Keyset page: strictly after the cursor under the exact ORDER BY below.
  AND (${cursorUpdatedAt} IS NULL
       OR n.updated_at < ${cursorUpdatedAt}
       OR (n.updated_at = ${cursorUpdatedAt} AND n.id < ${cursorId}))
ORDER BY n.updated_at DESC, n.id DESC
LIMIT ${params.limit + 1}::int
`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Accepts ISO-8601 and Postgres's own timestamptz text ("2026-09-01 01:15:07.238158+00").
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)$/;

// Keys that would target the prototype chain of the object the predicates
// are folded into, rather than a metadata key.
const FORBIDDEN_PREDICATE_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

function isScalar(value: unknown): value is MetadataScalar {
  return value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)) || typeof value === "string";
}

function validateScalar(option: string, value: unknown): MetadataScalar {
  if (!isScalar(value)) {
    throw new InvalidListOptionError(option, value, "must be a string, number, boolean, or null");
  }
  if (typeof value === "string" && value.length > MAX_PREDICATE_STRING_LENGTH) {
    throw new InvalidListOptionError(option, value, `string values must be at most ${MAX_PREDICATE_STRING_LENGTH} characters`);
  }
  return value;
}

function validatePredicates(where: readonly MetadataPredicate[] | null | undefined): MetadataPredicate[] {
  if (where === null || where === undefined) return [];
  if (!Array.isArray(where)) {
    throw new InvalidListOptionError("where", where, "must be an array of predicates");
  }
  if (where.length > MAX_LIST_PREDICATES) {
    throw new InvalidListOptionError("where", where.length, `must contain at most ${MAX_LIST_PREDICATES} predicates`);
  }
  const equalsKeys = new Set<string>();
  return where.map((predicate, i) => {
    const option = `where[${i}]`;
    if (!predicate || typeof predicate !== "object") {
      throw new InvalidListOptionError(option, predicate, "must be an object");
    }
    const { key, op } = predicate as { key?: unknown; op?: unknown };
    if (typeof key !== "string" || key.length === 0 || key.length > MAX_PREDICATE_KEY_LENGTH) {
      throw new InvalidListOptionError(`${option}.key`, key, `must be a non-empty string of at most ${MAX_PREDICATE_KEY_LENGTH} characters`);
    }
    if (FORBIDDEN_PREDICATE_KEYS.has(key)) {
      throw new InvalidListOptionError(`${option}.key`, key, "is not an allowed key");
    }
    if (op === "equals") {
      if (equalsKeys.has(key)) {
        throw new InvalidListOptionError(`${option}.key`, key, "appears in more than one equals predicate; use oneOf for alternatives");
      }
      equalsKeys.add(key);
      return { key, op, value: validateScalar(`${option}.value`, (predicate as { value?: unknown }).value) };
    }
    if (op === "oneOf") {
      const values = (predicate as { values?: unknown }).values;
      if (!Array.isArray(values) || values.length === 0 || values.length > MAX_ONE_OF_VALUES) {
        throw new InvalidListOptionError(`${option}.values`, values, `must be a non-empty array of at most ${MAX_ONE_OF_VALUES} scalar values`);
      }
      return { key, op, values: values.map((v, j) => validateScalar(`${option}.values[${j}]`, v)) };
    }
    throw new InvalidListOptionError(`${option}.op`, op, 'must be "equals" or "oneOf"');
  });
}

/**
 * The `nodeTypes` / `sourceSystems` rule, shared: `null`/absent means
 * "all"; otherwise a non-empty array of at most `MAX_LIST_NAMES` non-empty
 * strings, copied. Throws `InvalidListOptionError` naming `option`.
 * Exported for `getTimeline` (timeline.ts), whose narrowing is this one —
 * a second copy would drift from it.
 */
export function validateListNames(option: string, values: readonly string[] | null | undefined): string[] | null {
  if (values === null || values === undefined) return null;
  if (!Array.isArray(values) || values.length === 0 || values.some((v) => typeof v !== "string" || v.length === 0)) {
    throw new InvalidListOptionError(option, values, "must be a non-empty array of non-empty strings, or null");
  }
  if (values.length > MAX_LIST_NAMES) {
    throw new InvalidListOptionError(option, values.length, `must contain at most ${MAX_LIST_NAMES} entries`);
  }
  return [...values];
}

/** Validates every option, throwing `InvalidListOptionError` before any SQL runs. */
export function resolveListNodesOptions(options: ListNodesOptions): BuildListNodesQueryParams {
  const limit = options.limit ?? DEFAULT_LIST_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_LIST_LIMIT) {
    throw new InvalidListOptionError("limit", limit, `must be a positive integer no greater than ${MAX_LIST_LIMIT}`);
  }

  let updatedSince: string | null = null;
  if (options.updatedSince !== null && options.updatedSince !== undefined) {
    const raw = options.updatedSince;
    if (typeof raw !== "string" && !(raw instanceof Date)) {
      throw new InvalidListOptionError("updatedSince", raw, "must be a Date or an ISO-8601 string");
    }
    const asDate = raw instanceof Date ? raw : new Date(raw);
    if (Number.isNaN(asDate.getTime())) {
      throw new InvalidListOptionError("updatedSince", raw, "must be a parseable timestamp");
    }
    updatedSince = asDate.toISOString();
  }

  let cursor: ListNodesCursor | null = null;
  if (options.cursor !== null && options.cursor !== undefined) {
    const c = options.cursor;
    if (typeof c !== "object" || typeof c.updatedAt !== "string" || !TIMESTAMP_RE.test(c.updatedAt) || typeof c.id !== "string" || !UUID_RE.test(c.id)) {
      throw new InvalidListOptionError("cursor", c, "must be a nextCursor from a previous listNodes result ({ updatedAt, id }), or null for the first page");
    }
    cursor = { updatedAt: c.updatedAt, id: c.id };
  }

  return {
    nodeTypes: validateListNames("nodeTypes", options.nodeTypes),
    sourceSystems: validateListNames("sourceSystems", options.sourceSystems),
    updatedSince,
    where: validatePredicates(options.where),
    limit,
    cursor,
  };
}

function mapRow(row: RawListedRow): ListedNode {
  return {
    id: row.id,
    nodeType: row.node_type,
    sourceSystem: row.source_system,
    externalId: row.external_id,
    title: row.title,
    metadata: row.metadata,
    contentHash: row.content_hash,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    cursor: { updatedAt: row.updated_at_text, id: row.id },
  };
}

/**
 * Lists canonical nodes by structure. See the module header for the
 * predicate model and the paging contract.
 */
export async function listNodes(db: Database, options: ListNodesOptions = {}): Promise<ListNodesResult> {
  const params = resolveListNodesOptions(options);

  let result: { rows: RawListedRow[] };
  try {
    result = await db.execute<RawListedRow>(buildListNodesQuery(params));
  } catch (err) {
    throw new LookupFailedError(`listNodes query failed${formatPgInfo(asPgError(err))}`, "listNodes", { cause: err });
  }

  const hasMore = result.rows.length > params.limit;
  const pageRows = hasMore ? result.rows.slice(0, params.limit) : result.rows;
  const page = pageRows.map(mapRow);
  const last = page[page.length - 1];

  return {
    nodes: page,
    hasMore,
    nextCursor: hasMore && last ? last.cursor : null,
  };
}
