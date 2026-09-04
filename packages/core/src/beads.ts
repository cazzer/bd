// Pure helpers for the beads importer (work-items change, task group 4):
// how `bd list --json` rows become `work_item` nodes and how beads
// dependencies become `blocks` / `child_of` edges. No I/O here — the
// script in ingest-beads.ts shells out to `bd` and calls the write path;
// this module is what its tests exercise. Same split as github.ts /
// ingest-github.ts.
//
// Every mapped node's metadata goes through `normalizeWorkItemMetadata`,
// so a beads row that violates the contract is rejected at import time
// naming the issue, rather than stored and silently invisible to
// readiness. Beads happens to use the same five status names the contract
// does, so status maps one-to-one; `owner` becomes `assignee` and
// `close_reason` becomes `closed_reason`. The issue's `created_at` is also
// written as `occurred_at` through `normalizeOccurredAt` (timeline-view
// design.md decision 2: the moment a person would place the item at on a
// timeline), with `source_created_at` kept beside it untouched.

import type { EdgeInput } from "./edges.js";
import { normalizeOccurredAt, OCCURRED_AT_KEY } from "./event-time.js";
import type { NodeInput } from "./nodes.js";
import { BLOCKS_EDGE_TYPE, CHILD_OF_EDGE_TYPE, normalizeWorkItemMetadata, WORK_ITEM_NODE_TYPE } from "./work-items.js";

export const BEADS_SOURCE_SYSTEM = "beads";
export const BEADS_EDGE_WEIGHT = 1.0;

/** The subset of a `bd list --json` row this importer reads. Anything else is ignored. */
export interface BeadsIssue {
  id: string;
  title: string;
  description?: string | null;
  status: string;
  priority: number;
  issue_type?: string | null;
  owner?: string | null;
  created_by?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  closed_at?: string | null;
  close_reason?: string | null;
  spec_id?: string | null;
  acceptance_criteria?: string | null;
  design?: string | null;
  notes?: string | null;
  labels?: string[] | null;
  dependencies?: BeadsDependency[] | null;
}

/** One row of an issue's `dependencies`: `issue_id` depends on `depends_on_id`. */
export interface BeadsDependency {
  issue_id: string;
  depends_on_id: string;
  type: string;
}

/** Beads dependency types this importer understands; anything else is skipped and counted. */
export const BEADS_DEPENDENCY_TYPES = { blocks: "blocks", parentChild: "parent-child" } as const;

function section(heading: string, body: string | null | undefined): string {
  const text = body?.trim();
  return text ? `\n\n## ${heading}\n\n${text}` : "";
}

/**
 * Maps one beads issue to a `work_item` node. Content is the description
 * followed by the acceptance criteria, design, and notes sections when
 * present, so full-text search sees everything a person wrote. Throws
 * `InvalidEventTimeError` when `created_at` does not parse and
 * `InvalidWorkItemError` when the row violates the work-item contract,
 * each naming `index`.
 */
export function mapBeadsIssueToNode(issue: BeadsIssue, index?: number): NodeInput {
  const metadata: Record<string, unknown> = {
    status: issue.status,
    priority: issue.priority,
    assignee: issue.owner ?? null,
    closed_at: issue.closed_at ?? null,
    closed_reason: issue.close_reason ?? null,
    spec_id: issue.spec_id ?? null,
    issue_type: issue.issue_type ?? null,
    created_by: issue.created_by ?? null,
    source_created_at: issue.created_at ?? null,
    source_updated_at: issue.updated_at ?? null,
    [OCCURRED_AT_KEY]: issue.created_at ?? null,
    ...(issue.labels && issue.labels.length > 0 ? { labels: issue.labels } : {}),
  };
  // Event time first, so an unparseable created_at is named as occurred_at
  // rather than surfacing through the work-item contract.
  return {
    nodeType: WORK_ITEM_NODE_TYPE,
    sourceSystem: BEADS_SOURCE_SYSTEM,
    externalId: issue.id,
    title: issue.title,
    content: `${issue.description?.trim() ?? ""}${section("Acceptance criteria", issue.acceptance_criteria)}${section("Design", issue.design)}${section("Notes", issue.notes)}`,
    metadata: normalizeWorkItemMetadata(normalizeOccurredAt(metadata, { index }), { index }),
  };
}

export interface BeadsEdgeCandidate {
  srcExternalId: string;
  dstExternalId: string;
  edgeType: typeof BLOCKS_EDGE_TYPE | typeof CHILD_OF_EDGE_TYPE;
}

export interface DeriveBeadsEdgesResult {
  edges: BeadsEdgeCandidate[];
  /** Dependencies naming an issue outside the export (deleted, or filtered out). */
  skippedUnknownIssue: number;
  /** Dependencies of a type this importer does not map. */
  skippedUnknownType: number;
}

/**
 * Derives edge candidates from every issue's dependencies. A `blocks`
 * dependency ("issue depends on X") becomes X -blocks-> issue; a
 * `parent-child` dependency becomes issue -child_of-> parent. Duplicates
 * collapse; a dependency whose either end is not in `knownIssueIds` is
 * skipped and counted rather than failing the import.
 */
export function deriveBeadsEdges(issues: readonly BeadsIssue[], knownIssueIds: ReadonlySet<string>): DeriveBeadsEdgesResult {
  const seen = new Set<string>();
  const edges: BeadsEdgeCandidate[] = [];
  let skippedUnknownIssue = 0;
  let skippedUnknownType = 0;
  for (const issue of issues) {
    for (const dep of issue.dependencies ?? []) {
      let candidate: BeadsEdgeCandidate;
      if (dep.type === BEADS_DEPENDENCY_TYPES.blocks) {
        candidate = { srcExternalId: dep.depends_on_id, dstExternalId: dep.issue_id, edgeType: BLOCKS_EDGE_TYPE };
      } else if (dep.type === BEADS_DEPENDENCY_TYPES.parentChild) {
        candidate = { srcExternalId: dep.issue_id, dstExternalId: dep.depends_on_id, edgeType: CHILD_OF_EDGE_TYPE };
      } else {
        skippedUnknownType += 1;
        continue;
      }
      if (!knownIssueIds.has(candidate.srcExternalId) || !knownIssueIds.has(candidate.dstExternalId)) {
        skippedUnknownIssue += 1;
        continue;
      }
      const key = `${candidate.srcExternalId}\u0000${candidate.dstExternalId}\u0000${candidate.edgeType}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push(candidate);
    }
  }
  return { edges, skippedUnknownIssue, skippedUnknownType };
}

/** Resolves edge candidates to `EdgeInput`s given the node ids the upsert returned. */
export function resolveBeadsEdges(candidates: readonly BeadsEdgeCandidate[], nodeIdByExternalId: ReadonlyMap<string, string>): EdgeInput[] {
  const edges: EdgeInput[] = [];
  for (const c of candidates) {
    const srcId = nodeIdByExternalId.get(c.srcExternalId);
    const dstId = nodeIdByExternalId.get(c.dstExternalId);
    if (!srcId || !dstId) continue;
    edges.push({ srcId, dstId, edgeType: c.edgeType, sourceSystem: BEADS_SOURCE_SYSTEM, weight: BEADS_EDGE_WEIGHT });
  }
  return edges;
}
