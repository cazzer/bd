// Finding nodes (search-results-view change; knowledge-store spec, "Nodes
// can be found by text and structure together"): a flat, faceted page of
// canonical nodes for the search results view — optional search text, node
// types, projects (top-level metadata `project`), and a reviews-only flag
// (metadata `labels` contains `REVIEW_LABEL`), with the facet counts beside
// the page.
//
// One statement answers the page and every count. `base` is the text match
// alone; each row then carries three booleans (`type_ok`, `project_ok`,
// `review_ok`), the page takes rows where all three hold, and each facet
// counts rows where every filter except its own holds — so choosing a type
// never zeroes the other types' counts.
//
// Text is parsed exactly as retrieval's exact seed search parses it
// (`websearch_to_tsquery('english', …)`, `@@`, and the same relevance floor
// `DEFAULT_MIN_RELEVANCE`, without which an exclusion-only text like `-foo`
// would match every node at rank 0). Text that parses to nothing (stopwords
// only) is refused with `EmptyQueryError`, as `retrieve()` refuses it. There
// is no fuzzy fallback: "nothing matched" means exactly that.
//
// Canonical rows only: rows come from `resolved_nodes`, so a merged-away
// node is neither returned nor counted, and a term that appears only in a
// merged-away node's text is not found here (the graph's search still finds
// it). Retrieval's fold-on-match exception (CLAUDE.md) is deliberately not
// copied into a second module.
//
// Paging is by offset over a total order — relevance desc (text only), then
// `updated_at` desc, then `id` desc — so pages never repeat while the store
// is unchanged. Relevance is a per-query float, which a keyset cursor would
// have to carry and survive re-ranking; an offset does not. The next page
// starts at `offset + rows returned`, never `offset + limit`, so a caller
// that trims the page (the web response budget) resumes at its first
// dropped row.
//
// Facets scan every text-matched row (the whole canonical store when there
// is no text): O(store), bounded by the pool's statement timeout. Each facet
// list is capped at `MAX_FACET_VALUES`, chosen values first, then count
// desc, then value, so a chosen value is never pushed off the list. A chosen
// value with no matches is absent; the caller back-fills it at zero. Only a
// string `project` counts as one, and the project facet lists only values
// of at most `MAX_PREDICATE_STRING_LENGTH` characters — the longest a
// caller could send back as a chosen project.

import { sql, type SQL } from "drizzle-orm";
import type { Database } from "@breakdown/db";
import { EmptyQueryError, InvalidListOptionError, LookupFailedError } from "./errors.js";
import { MAX_PREDICATE_STRING_LENGTH, validateListNames } from "./list.js";
import { DEFAULT_MIN_RELEVANCE } from "./retrieval.js";
import { REVIEW_LABEL } from "./reviews.js";
import { asPgError, formatPgInfo, sqlArray } from "./sql-helpers.js";

export const DEFAULT_FIND_LIMIT = 50;
export const MAX_FIND_LIMIT = 200;
export const MAX_FIND_OFFSET = 5000;
export const MAX_FIND_TEXT_LENGTH = 500;
export const MAX_FACET_VALUES = 50;

export interface FindNodesOptions {
  /** Search text; trimmed, and empty or whitespace-only means none. At most `MAX_FIND_TEXT_LENGTH` characters. */
  text?: string | null;
  nodeTypes?: readonly string[] | null;
  /** Matches the top-level metadata `project`; a node without one passes only while this is null. */
  projects?: readonly string[] | null;
  /** Only nodes whose metadata `labels` array holds `REVIEW_LABEL`. */
  reviewsOnly?: boolean;
  /** Default `DEFAULT_FIND_LIMIT` (50), max `MAX_FIND_LIMIT` (200). */
  limit?: number;
  /** Rows to skip, 0..`MAX_FIND_OFFSET`. */
  offset?: number;
}

export interface BuildFindNodesQueryParams {
  text: string | null;
  nodeTypes: string[] | null;
  projects: string[] | null;
  reviewsOnly: boolean;
  limit: number;
  offset: number;
}

/** A result row: summary fields only — never content or full metadata. */
export interface FoundNode {
  id: string;
  nodeType: string;
  sourceSystem: string;
  externalId: string;
  title: string;
  updatedAt: Date;
  /** `ts_headline` with matches wrapped in `[[`/`]]`; null when there is no text. */
  snippet: string | null;
  project: string | null;
  status: string | null;
  closedAt: string | null;
  isReview: boolean;
}

export interface FacetCount {
  value: string;
  count: number;
}

export interface FindNodesFacets {
  /** Matches per node type under the text, projects, and reviews-only filter. */
  nodeTypes: FacetCount[];
  /** Matches per project under the text, node types, and reviews-only filter; nodes without a project are not listed. */
  projects: FacetCount[];
  /** Reviews among the matches under the text, node types, and projects. */
  reviews: number;
}

export interface FindNodesResult {
  nodes: FoundNode[];
  hasMore: boolean;
  /** Matches under every filter, across all pages. */
  total: number;
  facets: FindNodesFacets;
}

type RawFoundRow = {
  id: string;
  node_type: string;
  source_system: string;
  external_id: string;
  title: string;
  updated_at: string;
  snippet: string | null;
  project: string | null;
  status: string | null;
  closed_at: string | null;
  is_review: boolean;
};

type RawFindEnvelope = {
  /** `numnode()` of the parsed text; null without text. 0 means the text was stopwords only. */
  query_node_count: number | null;
  rows: RawFoundRow[];
  type_facets: FacetCount[];
  project_facets: FacetCount[];
  total: number;
  reviews: number;
};

function nullableTextArray(values: readonly string[] | null): SQL {
  return values === null ? sql`NULL::text[]` : sqlArray(values, "text");
}

/** Pure: builds the find statement from already-validated params. */
export function buildFindNodesQuery(params: BuildFindNodesQueryParams): SQL {
  const types = nullableTextArray(params.nodeTypes);
  const projects = nullableTextArray(params.projects);
  const chosenTypes = params.nodeTypes === null ? sql`'{}'::text[]` : sqlArray(params.nodeTypes, "text");
  const chosenProjects = params.projects === null ? sql`'{}'::text[]` : sqlArray(params.projects, "text");
  const reviewContainment = JSON.stringify({ labels: [REVIEW_LABEL] });
  const hasText = params.text !== null;

  const tsq = hasText ? sql`SELECT websearch_to_tsquery('english', ${params.text}) AS q` : sql`SELECT NULL::tsquery AS q`;
  const relevance = hasText ? sql`ts_rank_cd(n.search, t.q)::double precision` : sql`0::double precision`;
  const textMatch = hasText ? sql`WHERE n.search @@ t.q` : sql``;
  // The relevance floor is applied to the computed column, so each matched
  // row is ranked once.
  const relevanceFloor = hasText ? sql`WHERE relevance >= ${DEFAULT_MIN_RELEVANCE}::double precision` : sql``;
  // Copied verbatim from retrieval.ts: the client's snippet parser depends
  // on the `[[`/`]]` markers.
  const snippet = hasText
    ? sql`ts_headline('english', r.title || ' - ' || r.content, t.q,
           'StartSel=[[,StopSel=]],MaxFragments=2,MinWords=5,MaxWords=20')`
    : sql`NULL::text`;
  const queryNodeCount = hasText ? sql`(SELECT numnode(q) FROM tsq)` : sql`NULL::int`;

  return sql`
WITH
tsq AS (
  ${tsq}
),

-- The text match alone: never narrowed by type, project, or review here,
-- because every facet is counted over this set. A project that is not a
-- JSON string reads as none, so it can neither match a chosen project nor
-- appear as a facet value.
matched AS (
  SELECT n.id, n.node_type, n.source_system, n.external_id, n.title, n.updated_at,
         CASE WHEN jsonb_typeof(n.metadata->'project') = 'string' THEN n.metadata->>'project' END AS project,
         n.metadata->>'status'    AS status,
         n.metadata->>'closed_at' AS closed_at,
         (n.metadata @> ${reviewContainment}::jsonb) AS is_review,
         ${relevance} AS relevance
  FROM resolved_nodes n CROSS JOIN tsq t
  ${textMatch}
),

base AS (
  SELECT * FROM matched
  ${relevanceFloor}
),

flagged AS (
  SELECT b.*,
         (${types} IS NULL OR b.node_type = ANY(${types}))  AS type_ok,
         (${projects} IS NULL OR b.project = ANY(${projects})) AS project_ok,
         (NOT ${params.reviewsOnly}::boolean OR b.is_review)  AS review_ok
  FROM base b
),

page AS (
  SELECT * FROM flagged
  WHERE type_ok AND project_ok AND review_ok
  ORDER BY relevance DESC, updated_at DESC, id DESC
  OFFSET ${params.offset}::int LIMIT ${params.limit + 1}::int
),

-- Snippets for the rows returned only, never the probe row past the limit:
-- highlighting re-parses the whole document.
numbered AS (
  SELECT p.*, row_number() OVER (ORDER BY relevance DESC, updated_at DESC, id DESC) AS page_ord
  FROM page p
),

page_rows AS (
  SELECT p.*, CASE WHEN p.page_ord <= ${params.limit}::int THEN ${snippet} END AS snippet
  FROM numbered p JOIN resolved_nodes r ON r.id = p.id CROSS JOIN tsq t
),

totals AS (
  SELECT count(*) FILTER (WHERE type_ok AND project_ok AND review_ok)::int AS total,
         count(*) FILTER (WHERE type_ok AND project_ok AND is_review)::int AS reviews
  FROM flagged
),

type_facets AS (
  SELECT node_type AS value, count(*)::int AS count,
         row_number() OVER (ORDER BY (node_type = ANY(${chosenTypes})) DESC, count(*) DESC, node_type) AS ord
  FROM flagged
  WHERE project_ok AND review_ok
  GROUP BY node_type
  ORDER BY ord
  LIMIT ${MAX_FACET_VALUES}::int
),

project_facets AS (
  SELECT project AS value, count(*)::int AS count,
         row_number() OVER (ORDER BY (project = ANY(${chosenProjects})) DESC, count(*) DESC, project) AS ord
  FROM flagged
  WHERE type_ok AND review_ok AND project IS NOT NULL AND length(project) <= ${MAX_PREDICATE_STRING_LENGTH}::int
  GROUP BY project
  ORDER BY ord
  LIMIT ${MAX_FACET_VALUES}::int
)

SELECT json_build_object(
  'query_node_count', ${queryNodeCount},
  'rows', COALESCE((SELECT json_agg(json_build_object(
            'id', id, 'node_type', node_type, 'source_system', source_system, 'external_id', external_id,
            'title', title, 'updated_at', updated_at, 'snippet', snippet, 'project', project,
            'status', status, 'closed_at', closed_at, 'is_review', is_review)
            ORDER BY relevance DESC, updated_at DESC, id DESC) FROM page_rows), '[]'::json),
  'type_facets', COALESCE((SELECT json_agg(json_build_object('value', value, 'count', count) ORDER BY ord) FROM type_facets), '[]'::json),
  'project_facets', COALESCE((SELECT json_agg(json_build_object('value', value, 'count', count) ORDER BY ord) FROM project_facets), '[]'::json),
  'total', (SELECT total FROM totals),
  'reviews', (SELECT reviews FROM totals)
) AS result
`;
}

function validateBoundedInt(option: string, value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new InvalidListOptionError(option, value, `must be an integer from ${min} to ${max}`);
  }
  return value;
}

/** Validates every option, throwing `InvalidListOptionError` before any SQL runs. */
export function resolveFindNodesOptions(options: FindNodesOptions): BuildFindNodesQueryParams {
  let text: string | null = null;
  if (options.text !== null && options.text !== undefined) {
    if (typeof options.text !== "string") {
      throw new InvalidListOptionError("text", options.text, "must be a string or null");
    }
    if (options.text.length > MAX_FIND_TEXT_LENGTH) {
      throw new InvalidListOptionError("text", options.text.length, `must be at most ${MAX_FIND_TEXT_LENGTH} characters`);
    }
    const trimmed = options.text.trim();
    text = trimmed.length === 0 ? null : trimmed;
  }

  const reviewsOnly = options.reviewsOnly ?? false;
  if (typeof reviewsOnly !== "boolean") {
    throw new InvalidListOptionError("reviewsOnly", reviewsOnly, "must be a boolean");
  }

  return {
    text,
    nodeTypes: validateListNames("nodeTypes", options.nodeTypes),
    projects: validateListNames("projects", options.projects),
    reviewsOnly,
    limit: validateBoundedInt("limit", options.limit ?? DEFAULT_FIND_LIMIT, 1, MAX_FIND_LIMIT),
    offset: validateBoundedInt("offset", options.offset ?? 0, 0, MAX_FIND_OFFSET),
  };
}

function mapRow(row: RawFoundRow): FoundNode {
  return {
    id: row.id,
    nodeType: row.node_type,
    sourceSystem: row.source_system,
    externalId: row.external_id,
    title: row.title,
    updatedAt: new Date(row.updated_at),
    snippet: row.snippet,
    project: row.project,
    status: row.status,
    closedAt: row.closed_at,
    isReview: row.is_review,
  };
}

/**
 * Finds canonical nodes by optional text and structure, with facet counts.
 * See the module header for the matching, facet, and paging contracts.
 * Throws `InvalidListOptionError` for a malformed option and
 * `EmptyQueryError` for text with no searchable terms.
 */
export async function findNodes(db: Database, options: FindNodesOptions = {}): Promise<FindNodesResult> {
  const params = resolveFindNodesOptions(options);

  let envelope: RawFindEnvelope | undefined;
  try {
    const result = await db.execute<{ result: RawFindEnvelope }>(buildFindNodesQuery(params));
    envelope = result.rows[0]?.result;
  } catch (err) {
    throw new LookupFailedError(`findNodes query failed${formatPgInfo(asPgError(err))}`, "findNodes", { cause: err });
  }
  if (!envelope) {
    throw new LookupFailedError("findNodes query returned no row", "findNodes");
  }
  if (params.text !== null && envelope.query_node_count === 0) {
    throw new EmptyQueryError(params.text);
  }

  const hasMore = envelope.rows.length > params.limit;
  const pageRows = hasMore ? envelope.rows.slice(0, params.limit) : envelope.rows;
  return {
    nodes: pageRows.map(mapRow),
    hasMore,
    total: envelope.total,
    facets: {
      nodeTypes: envelope.type_facets,
      projects: envelope.project_facets,
      reviews: envelope.reviews,
    },
  };
}
