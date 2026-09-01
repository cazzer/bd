// Batch write path (bd-vt2.3) and retrieval (bd-vt2.4). MCP tools land in
// bd-vt2.5. Nothing here connects or reads env at module scope — every
// function takes a `Database` (see @breakdown/db) as its first argument.

export { computeContentHash } from "./content-hash.js";

export {
  KnowledgeStoreError,
  InvalidIngestRunError,
  InvalidNodeInputError,
  ContentTooLargeError,
  TitleTooLargeError,
  MetadataTooLargeError,
  InvalidNodeContentError,
  DuplicateNodeInBatchError,
  NodeUpsertFailedError,
  InvalidEdgeInputError,
  InvalidEdgeWeightError,
  DuplicateEdgeInBatchError,
  EdgeUpsertFailedError,
  NodeNotFoundError,
  SelfMergeError,
  MergeFailedError,
  InvalidRetrievalOptionError,
  EmptyQueryError,
  RetrievalFailedError,
  InvalidLookupIdError,
  LookupFailedError,
  InvalidLookupOptionError,
  NodeNotEditableError,
  EdgeNotFoundError,
} from "./errors.js";

// `asPgError`/`PgErrorLike` are re-exported (not just used internally) so
// the MCP layer (apps/mcp/src/errors.ts) can distinguish a genuine
// database failure's Postgres error code (e.g. 23503 foreign_key_violation
// on an EdgeUpsertFailedError) from a generic one, without reimplementing
// the drizzle/node-postgres error-unwrapping this package already does —
// that unwrapping is infrastructure, not business logic, and duplicating
// it at the MCP boundary would be the actual layering violation.
export { asPgError, type PgErrorLike } from "./sql-helpers.js";

export {
  openIngestRun,
  closeIngestRun,
  getIngestRunContents,
  type IngestRunHandle,
  type ClosedIngestRun,
  type IngestRunContents,
} from "./ingest-runs.js";

export {
  upsertNodes,
  DEFAULT_MAX_CONTENT_LENGTH,
  DEFAULT_MAX_METADATA_LENGTH,
  DEFAULT_MAX_TITLE_LENGTH,
  DEFAULT_NODE_CHUNK_SIZE,
  type NodeInput,
  type UpsertNodesOptions,
  type NodeUpsertAction,
  type NodeUpsertResultRow,
  type UpsertNodesResult,
} from "./nodes.js";

export {
  upsertEdges,
  DEFAULT_EDGE_CHUNK_SIZE,
  type EdgeInput,
  type UpsertEdgesOptions,
  type EdgeUpsertAction,
  type EdgeUpsertResultRow,
  type UpsertEdgesResult,
} from "./edges.js";

export { mergeNodes, type MergeResult } from "./merge.js";

export {
  retrieve,
  buildRetrievalQuery,
  getStoreSummary,
  buildStoreSummaryQuery,
  DEFAULT_SEED_LIMIT,
  MAX_SEED_LIMIT,
  DEFAULT_MIN_RELEVANCE,
  DEFAULT_MAX_DEPTH,
  MAX_ALLOWED_DEPTH,
  DEFAULT_FANOUT,
  MAX_FANOUT,
  DEFAULT_NODE_BUDGET,
  MAX_NODE_BUDGET,
  DEFAULT_DECAY,
  DEFAULT_RECENT_NODES_LIMIT,
  MAX_RECENT_NODES_LIMIT,
  type SeedStrategy,
  type RetrieveOptions,
  type BuildRetrievalQueryParams,
  type RetrievedNode,
  type RetrievedEdge,
  type RetrievalResultFound,
  type RetrievalResultEmpty,
  type RetrievalResult,
  type StoreSummaryOptions,
  type NodeTypeCount,
  type SourceSystemCount,
  type EdgeTypeCount,
  type RecentNode,
  type StoreSummary,
} from "./retrieval.js";

export {
  getNodes,
  buildGetNodesQuery,
  getNeighbors,
  buildGetNeighborsQuery,
  DEFAULT_NEIGHBOR_LIMIT,
  MAX_NEIGHBOR_LIMIT,
  type LookedUpNode,
  type GetNodesResult,
  type NeighborDirection,
  type Neighbor,
  type NeighborsCursor,
  type GetNeighborsOptions,
  type GetNeighborsResult,
  type BuildGetNeighborsQueryParams,
} from "./lookup.js";

export { isEditableSourceSystem } from "./editability.js";

// The human write surface (bd-hmd.2): every write attributed to an ingest
// run with source_system: 'human', reusing upsertNodes/upsertEdges (or,
// for annotateNode, the exact validation/query-building internals those
// are built on) rather than bypassing them. See human-writes.ts's module
// header.
export {
  createNote,
  annotateNode,
  updateNodeContent,
  assertEdge,
  retractEdge,
  reweightEdge,
  HUMAN_SOURCE_SYSTEM,
  NOTE_NODE_TYPE,
  ANNOTATES_EDGE_TYPE,
  type CreateNoteInput,
  type CreateNoteResult,
  type AnnotateNodeInput,
  type AnnotateNodeResult,
  type UpdateNodeContentInput,
  type UpdateNodeContentResult,
  type AssertEdgeInput,
  type AssertEdgeResult,
  type RetractEdgeInput,
  type RetractEdgeResult,
  type ReweightEdgeInput,
  type ReweightEdgeResult,
} from "./human-writes.js";

// Pure helpers for the repo-markdown seed script (bd-vt2.6, task 6.1) —
// not write-path or retrieval behavior, just how src/seed.ts decides a
// node's type/title and derives edges from file structure. See corpus.ts.
export {
  deriveNodeType,
  deriveTitle,
  extractMarkdownLinkTargets,
  deriveStructuralEdges,
  combineEdgeCandidates,
  PART_OF_CHANGE_WEIGHT,
  SIBLING_WEIGHT,
  LINKS_TO_WEIGHT,
  type EdgeCandidate,
} from "./corpus.js";
