// Batch write path (bd-vt2.3). Retrieval and MCP tools land in bd-vt2.4
// and bd-vt2.5. Nothing here connects or reads env at module scope — every
// function takes a `Database` (see @breakdown/db) as its first argument.

export { computeContentHash } from "./content-hash.js";

export {
  KnowledgeStoreError,
  InvalidIngestRunError,
  InvalidNodeInputError,
  ContentTooLargeError,
  DuplicateNodeInBatchError,
  NodeUpsertFailedError,
  InvalidEdgeInputError,
  InvalidEdgeWeightError,
  DuplicateEdgeInBatchError,
  EdgeUpsertFailedError,
  NodeNotFoundError,
  SelfMergeError,
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
