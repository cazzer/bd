// Batch write path (bd-vt2.3) and retrieval (bd-vt2.4). MCP tools land in
// bd-vt2.5. Nothing here connects or reads env at module scope — every
// function takes a `Database` (see @breakdown/db) as its first argument.

export { computeContentHash } from "./content-hash.js";

export {
  KnowledgeStoreError,
  InvalidIngestRunError,
  InvalidNodeInputError,
  ContentTooLargeError,
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
} from "./errors.js";

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
  DEFAULT_MIN_RELEVANCE,
  DEFAULT_MAX_DEPTH,
  MAX_ALLOWED_DEPTH,
  DEFAULT_FANOUT,
  DEFAULT_NODE_BUDGET,
  DEFAULT_DECAY,
  DEFAULT_RECENT_NODES_LIMIT,
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
