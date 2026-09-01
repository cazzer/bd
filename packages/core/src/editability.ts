/**
 * Whether a node can have its content edited through `updateNodeContent`
 * (bd-hmd.2, knowledge-store spec section 3).
 *
 * Deliberately a whitelist of `"human"`/`"agent"`, not a blacklist of
 * `"repo"`: everything else is presumed file/loader-backed, whose truth
 * lives in the source system that wrote it, not in this store. A future
 * Slack or Notion loader becomes read-only automatically the moment it
 * starts writing nodes under its own source_system — no code change here
 * is needed, and none would accidentally make it editable by omission the
 * way a blacklist would.
 *
 * This is the one place the rule is expressed. `updateNodeContent` (and
 * `NodeNotEditableError`, which it throws on refusal) call this rather
 * than re-deriving the check, and the tRPC layer and the UI (bd-hmd.3
 * onward) are expected to import this same function — never a local
 * `sourceSystem === "repo"` check of their own — so the rule can only
 * ever be changed in one place.
 */

/** Source systems whose nodes are editable. Not exported: go through `isEditableSourceSystem`, not this set, so the rule stays a single function call at every call site. */
const EDITABLE_SOURCE_SYSTEMS: ReadonlySet<string> = new Set(["human", "agent"]);

/** True when a node whose `source_system` is `sourceSystem` may have its content edited. */
export function isEditableSourceSystem(sourceSystem: string): boolean {
  return EDITABLE_SOURCE_SYSTEMS.has(sourceSystem);
}
