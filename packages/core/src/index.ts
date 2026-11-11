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
  BeadsProjectConflictError,
  NotAWorkItemError,
  NotAnInboxItemError,
  InvalidInboxItemError,
  InboxDecisionConflictError,
  InboxCardChangedError,
  InvalidViewError,
  InvalidEventTimeError,
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
  getNodesByExternalId,
  buildGetNodesByExternalIdQuery,
  DEFAULT_NEIGHBOR_LIMIT,
  MAX_NEIGHBOR_LIMIT,
  MAX_EXTERNAL_ID_LOOKUPS,
  type LookedUpNode,
  type GetNodesResult,
  type NeighborDirection,
  type Neighbor,
  type NeighborsCursor,
  type GetNeighborsOptions,
  type GetNeighborsResult,
  type BuildGetNeighborsQueryParams,
  type ExternalIdPair,
  type ResolvedExternalId,
  type GetNodesByExternalIdResult,
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

// Pure helpers for the GitHub repos/issues/pull-requests loader (bd-5hd;
// pull requests in github-prs-and-commits) — not write-path or retrieval
// behavior, just how src/ingest-github.ts maps `gh` JSON to repo/issue/PR
// nodes, names its source system/node/edge types, resolves the issues a
// PR closes into `closes` edges, and resolves `#N`/`owner/repo#N`
// cross-references in issue and PR text into `mentions` edges. See
// github.ts.
export {
  extractIssueReferences,
  deriveMentionEdges,
  deriveClosesEdges,
  mapGhRepoToNode,
  mapGhIssueToNode,
  mapGhPrToNode,
  GITHUB_SOURCE_SYSTEM,
  REPO_NODE_TYPE,
  ISSUE_NODE_TYPE,
  PR_NODE_TYPE,
  BELONGS_TO_EDGE_TYPE,
  BELONGS_TO_WEIGHT,
  MENTIONS_EDGE_TYPE,
  MENTIONS_WEIGHT,
  CLOSES_EDGE_TYPE,
  CLOSES_WEIGHT,
  type GhRepo,
  type GhIssue,
  type GhPullRequest,
  type GhClosingIssueReference,
  type ParsedReference,
  type IssueRefSource,
  type MentionEdgeCandidate,
  type PrClosesSource,
  type ClosesEdgeCandidate,
  type DeriveClosesEdgesResult,
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
  buildBlockingCtes,
  type WorkItemStatus,
  PROJECT_KEY_PATTERN,
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
  isReviewIssue,
  BEADS_SOURCE_SYSTEM,
  BEADS_EDGE_WEIGHT,
  BEADS_DEPENDENCY_TYPES,
  type BeadsIssue,
  type BeadsComment,
  type BeadsDependency,
  type BeadsEdgeCandidate,
  type DeriveBeadsEdgesResult,
} from "./beads.js";

// The beads loader as a library (live-beads-board): one checkout in, one
// attributed ingest run, optional project registration and collision guard.
// See beads-ingest.ts.
export {
  ingestBeadsCheckout,
  BEADS_PROJECT_NODE_TYPE,
  BEADS_INGEST_ACTOR,
  BD_TIMEOUT_MS,
  type RunBd,
  type IngestBeadsCheckoutOptions,
  type IngestBeadsCheckoutResult,
} from "./beads-ingest.js";

// Work board read (live-beads-board change). See board.ts.
export {
  getWorkBoard,
  getBoardItem,
  getRegisteredBeadsProject,
  listBeadsProjects,
  buildWorkBoardQuery,
  BOARD_COLUMNS,
  MAX_BOARD_ITEMS,
  MAX_BOARD_ITEM_ID_LENGTH,
  CLOSED_PER_PROJECT,
  MAX_BOARD_PROJECTS,
  type BoardColumn,
  type BoardCard,
  type BoardEpic,
  type BoardItem,
  type BoardItemOptions,
  type WorkBoard,
  type WorkBoardOptions,
  type BeadsProject,
} from "./board.js";

// The pending review queue (review-queue change): every pending review
// across the registered projects, oldest first, in one statement. See
// review-queue.ts.
export {
  listPendingReviews,
  MAX_PENDING_REVIEWS,
  MAX_REVIEW_SUMMARY_LINE_LENGTH,
  type PendingReview,
  type PendingReviews,
  type PendingReviewsOptions,
} from "./review-queue.js";

// The review contract (board-visual-reviews): review metadata and comment
// normalization, the review image root, and lexical containment; the
// decision-card keys and `reviewCard` (decision-card-reviews). Pure.
// See reviews.ts.
export {
  REVIEW_LABEL,
  REVIEW_CHANGES_LABEL,
  REVIEW_METADATA_KEY,
  REVIEW_COMMENTS_KEY,
  REVIEW_COMMENT_COUNT_KEY,
  REVIEW_IMAGE_ROOT,
  MAX_REVIEW_METADATA_CHARS,
  MAX_REVIEW_COMMENT_ID_LENGTH,
  MAX_REVIEW_IMAGES,
  MAX_REVIEW_IMAGE_PATH_LENGTH,
  REVIEW_PANE_PATTERN,
  MAX_REVIEW_SOCKET_PATH_LENGTH,
  isReviewSocketPath,
  MAX_REVIEW_SUMMARY_LENGTH,
  MAX_REVIEW_COMMENTS,
  MAX_REVIEW_COMMENT_LENGTH,
  MAX_REVIEW_COMMENT_AUTHOR_LENGTH,
  MAX_REVIEW_COMMENTS_CHARS,
  MAX_REVIEW_QUESTION_LENGTH,
  MIN_REVIEW_OPTIONS,
  MAX_REVIEW_OPTIONS,
  REVIEW_OPTION_ID_PATTERN,
  REVIEW_KEY_PATTERN,
  MAX_REVIEW_KEY_LENGTH,
  MAX_REVIEW_OPTION_LABEL_LENGTH,
  MAX_REVIEW_OPTION_TEXT_LENGTH,
  MAX_REVIEW_ON_ACCEPT_STEPS,
  MAX_REVIEW_ON_ACCEPT_STEP_LENGTH,
  MAX_REVIEW_ATTACHMENTS,
  MAX_REVIEW_ATTACHMENT_CAPTION_LENGTH,
  MAX_REVIEW_ATTACHMENT_SOURCE_LENGTH,
  REVIEW_ATTACHMENT_KINDS,
  REVIEW_ATTACHMENT_PAIRS,
  normalizeReviewMetadata,
  normalizeDecisionCard,
  type DecisionCard,
  normalizeReviewComments,
  reviewCard,
  isInsideReviewRoot,
  type ReviewMetadata,
  type ReviewOption,
  type ReviewAttachment,
  type ReviewAttachmentKind,
  type ReviewAttachmentPair,
  type ReviewImageAttachment,
  type ReviewSourceAttachment,
  type ReviewCard,
  type InvalidReview,
  type ReviewComment,
} from "./reviews.js";

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
// Event time (timeline-view change): the `occurred_at` contract every
// writer applies, whatever the node's type. See event-time.ts's header.
export { OCCURRED_AT_KEY, normalizeOccurredAt, type NormalizeOccurredAtOptions } from "./event-time.js";
// Anchored timeline read (timeline-view change): one anchor's timed
// neighbours newest first, one row per node with the heaviest edge's type
// and direction, merge-folded, keyset-paged, with the untimed count in the
// same statement. See timeline.ts's module header.
export {
  getTimeline,
  buildGetTimelineQuery,
  DEFAULT_TIMELINE_LIMIT,
  MAX_TIMELINE_LIMIT,
  type TimelineCursor,
  type GetTimelineOptions,
  type TimelineRow,
  type TimelineResult,
  type BuildGetTimelineQueryParams,
} from "./timeline.js";
// Bounded subtree read (code-view change): a root's child_of descendants
// in one statement, merge-folded, cycle-safe, capped by depth and by
// count, without content. See tree.ts's module header.
export {
  MAX_SUBTREE_NODES,
  MAX_SUBTREE_DEPTH,
  getSubtree,
  buildGetSubtreeQuery,
  type SubtreeNode,
  type Subtree,
  type GetSubtreeOptions,
} from "./tree.js";
// Git repository loader (git-repo-ingestor change; commits in
// github-prs-and-commits): the pure mapping from `git ls-files` records
// and file bytes to file/directory nodes and `child_of` candidates, the
// pure parse of `git log` records into commit nodes and their
// belongs-to/touches/mentions edges, and the one-transaction write of a
// whole tree with its commits. See git-repo.ts.
export {
  parseLsFiles,
  deriveRepoKey,
  classifyFile,
  deriveLanguage,
  countLines,
  buildRepoTree,
  gitExternalId,
  readWorkingTree,
  emptySkipCounts,
  resolveGitRepoEdges,
  loadGitRepoTree,
  parseGitLog,
  commitExternalId,
  buildCommitNodes,
  isRepoSlug,
  collectCommitReferences,
  resolveCommitEdges,
  emptyCommitEdgeCounts,
  GIT_SOURCE_SYSTEM,
  FILE_NODE_TYPE,
  DIRECTORY_NODE_TYPE,
  COMMIT_NODE_TYPE,
  TOUCHES_EDGE_TYPE,
  TOUCHES_WEIGHT,
  COMMITS_DEFAULT,
  GIT_LOG_FORMAT,
  GIT_EDGE_WEIGHT,
  MAX_FILE_BYTES,
  GENERATED_FILE_NAMES,
  GENERATED_FILE_SUFFIXES,
  LANGUAGE_BY_EXTENSION,
  SYMLINK_MODE,
  SUBMODULE_MODE,
  SKIP_REASONS,
  type LsFilesEntry,
  type SkipReason,
  type SkipCounts,
  type FileClassification,
  type ClassifyFileInput,
  type LoadableFile,
  type WorkingTreeRead,
  type GitRepoEdgeCandidate,
  type GitRepoTree,
  type GitCommit,
  type CommitEdgeCounts,
  type ResolveCommitEdgesInput,
  type ResolveCommitEdgesResult,
  type LoadGitRepoTreeOptions,
  type LoadGitRepoTreeResult,
} from "./git-repo.js";
// The inbox (review queue for things that need the person): inbox_item
// nodes an agent triages out of the person's sources, their metadata
// contract, the queue read, and the person's decision write. See inbox.ts.
export {
  INBOX_ITEM_NODE_TYPE,
  INBOX_SOURCE_SYSTEM,
  INBOX_STATUSES,
  OPEN_INBOX_STATUSES,
  INBOX_DECISIONS,
  MAX_INBOX_ITEMS,
  MAX_INBOX_FEEDBACK_LENGTH,
  normalizeInboxItemMetadata,
  readInboxItemFields,
  listInbox,
  decideInboxItem,
  carryForwardInboxDecisions,
  requestInboxItem,
  completeInboxItem,
  handOffInboxItem,
  INBOX_FEEDBACK_KINDS,
  INBOX_HANDOFF_STATUSES,
  INBOX_DISMISSABLE_STATUSES,
  INBOX_READ_DEPTHS,
  MAX_INBOX_READ,
  MAX_INBOX_READ_REF_LENGTH,
  MAX_INBOX_REVISION_LENGTH,
  MAX_INBOX_CLOSE_REASON_LENGTH,
  releaseInboxItem,
  unlinkInboxWorkContext,
  type InboxWorkContext,
  inboxItemDigested,
  type InboxRead,
  type InboxReadDepth,
  type HandOffInboxItemInput,
  type InboxFeedbackKind,
  type RequestInboxItemInput,
  loadStoredInboxMetadata,
  type InboxStatus,
  type InboxDecision,
  type InboxLink,
  type InboxFeedback,
  type InboxItemFields,
  type InboxItem,
  type InboxList,
  type ListInboxOptions,
  type DecideInboxItemInput,
  type DecideInboxItemResult,
} from "./inbox.js";

export {
  ABOUT_EDGE_TYPE,
  MAX_WORK_CONTEXT_ENTRIES,
  normalizeWorkContextLog,
  type WorkDecision,
  type WorkSignal,
} from "./work-context.js";
