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
  InvalidListOptionError,
  InvalidWorkItemError,
  NotAWorkItemError,
  InvalidViewError,
} from "./errors.js";

// `asPgError`/`PgErrorLike` are re-exported (not just used internally) so
// the MCP layer (apps/mcp/src/errors.ts) can distinguish a genuine
// database failure's Postgres error code (e.g. 23503 foreign_key_violation
// on an EdgeUpsertFailedError) from a generic one, without reimplementing
// the drizzle/node-postgres error-unwrapping this package already does —
// that unwrapping is infrastructure, not business logic, and duplicating
// it at the MCP boundary would be the actual layering violation.
export { asPgError, isDrizzleQueryError, type PgErrorLike } from "./sql-helpers.js";

export {
  openIngestRun,
  closeIngestRun,
  getIngestRunContents,
  MAX_ACTOR_LENGTH,
  type IngestRunHandle,
  type OpenIngestRunOptions,
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

// Per-node revision history (node-history change): what the triggers in
// migrations/0002_*.sql recorded, newest first, with what changed between
// revisions computed on read. See history.ts's module header.
export {
  getNodeHistory,
  buildNodeHistoryQuery,
  DEFAULT_HISTORY_LIMIT,
  MAX_HISTORY_LIMIT,
  type NodeRevision,
  type RevisionField,
  type RevisionIngestRun,
  type MetadataKeyChange,
  type GetNodeHistoryOptions,
  type GetNodeHistoryResult,
  type BuildNodeHistoryQueryParams,
} from "./history.js";

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

// Pure helpers for the GitHub repos/issues loader (bd-5hd) — not
// write-path or retrieval behavior, just how src/ingest-github.ts names
// its source system/node/edge types and resolves `#N`/`owner/repo#N`
// cross-references in issue text into `mentions` edges. See github.ts.
export {
  extractIssueReferences,
  deriveMentionEdges,
  GITHUB_SOURCE_SYSTEM,
  REPO_NODE_TYPE,
  ISSUE_NODE_TYPE,
  BELONGS_TO_EDGE_TYPE,
  BELONGS_TO_WEIGHT,
  MENTIONS_EDGE_TYPE,
  MENTIONS_WEIGHT,
  type ParsedReference,
  type IssueRefSource,
  type MentionEdgeCandidate,
} from "./github.js";

// Structured listing (work-items change): canonical nodes by type, source,
// recency, and validated metadata predicates. See list.ts's module header.
export {
  listNodes,
  buildListNodesQuery,
  resolveListNodesOptions,
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  MAX_LIST_NAMES,
  MAX_LIST_PREDICATES,
  MAX_ONE_OF_VALUES,
  MAX_PREDICATE_KEY_LENGTH,
  MAX_PREDICATE_STRING_LENGTH,
  type MetadataScalar,
  type MetadataPredicate,
  type ListNodesCursor,
  type ListNodesOptions,
  type ListedNode,
  type ListNodesResult,
  type BuildListNodesQueryParams,
} from "./list.js";

// Work items (work-items change): the lifecycle contract, the patch
// primitive, dependency edge conventions, and readiness. See
// work-items.ts's module header.
export {
  WORK_ITEM_NODE_TYPE,
  WORK_ITEM_STATUSES,
  DEFAULT_WORK_ITEM_STATUS,
  MIN_WORK_ITEM_PRIORITY,
  MAX_WORK_ITEM_PRIORITY,
  DEFAULT_WORK_ITEM_PRIORITY,
  MAX_ASSIGNEE_LENGTH,
  MAX_SPEC_ID_LENGTH,
  MAX_CLOSED_REASON_LENGTH,
  BLOCKS_EDGE_TYPE,
  CHILD_OF_EDGE_TYPE,
  DEFAULT_READINESS_LIMIT,
  MAX_READINESS_LIMIT,
  normalizeWorkItemMetadata,
  readWorkItemFields,
  patchWorkItem,
  getWorkItemReadiness,
  buildWorkItemReadinessQuery,
  type WorkItemStatus,
  type WorkItemFields,
  type NormalizeWorkItemOptions,
  type WorkItemPatch,
  type PatchWorkItemResult,
  type WorkItemReadinessOptions,
  type ReadyWorkItem,
  type BlockedWorkItem,
  type WorkItemReadinessResult,
  type BuildWorkItemReadinessQueryParams,
} from "./work-items.js";

// Pure helpers for the beads importer (work-items change, task group 4):
// how `bd list --json` rows become work items and how beads dependencies
// become blocks / child_of edges. See beads.ts.
export {
  mapBeadsIssueToNode,
  deriveBeadsEdges,
  resolveBeadsEdges,
  BEADS_SOURCE_SYSTEM,
  BEADS_EDGE_WEIGHT,
  BEADS_DEPENDENCY_TYPES,
  type BeadsIssue,
  type BeadsDependency,
  type BeadsEdgeCandidate,
  type DeriveBeadsEdgesResult,
} from "./beads.js";

// Node views (node-views change): the view contract, the default_view edge
// convention, and batched default-view resolution along child_of. See
// views.ts's module header.
export {
  VIEW_NODE_TYPE,
  VIEW_RENDERERS,
  DEFAULT_VIEW_EDGE_TYPE,
  MAX_RESOLVE_IDS,
  MAX_RESOLVE_DEPTH,
  isViewRenderer,
  normalizeViewMetadata,
  resolveDefaultViews,
  buildResolveDefaultViewsQuery,
  type ViewRenderer,
  type ViewFilter,
  type NormalizeViewOptions,
  type ResolvedDefaultView,
} from "./views.js";
