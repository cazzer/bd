// The commands the laptop relay may run (laptop-relay decisions 3 and 9).
// Enforced twice: Breakdown refuses an action at enqueue whose arguments
// fall outside it (relay.ts), and the relay's `runBd` / `runHerdr`
// wrappers refuse anything else before spawning. Both call these
// functions, so the two checks cannot drift.
//
// A shape is an exact argument vector: every element a string, the arity
// fixed, the literals literal. Free text (a comment, a close reason, a
// prompt) is bounded, carries no NUL, and never starts with `-`, so it can
// never be read as a flag. The commands run with an argument vector
// (`execFile`), never a shell, so no other character is special.
//
// The two read-only `bd` shapes are exactly what the beads ingest issues
// (beads-ingest.ts `fetchIssues`, `fetchReviewComments`).

import { REVIEW_PANE_PATTERN } from "./reviews.js";

/** A beads issue id: a lowercase prefix, a hyphen, then the hash or dotted child suffix (`bd-d38.11`). */
export const RELAY_ISSUE_ID_PATTERN = /^[a-z][a-z0-9-]*-[a-z0-9.]+$/;
export const MAX_RELAY_ISSUE_ID_LENGTH = 200;
/** `bd` free text: a comment or a close reason. */
export const MAX_RELAY_BD_TEXT_LENGTH = 4000;
/** herdr free text: an inbox note plus its title can exceed the `bd` cap. */
export const MAX_RELAY_HERDR_TEXT_LENGTH = 8000;

const CHANGES_LABEL = "review:changes";

export function isRelayIssueId(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_RELAY_ISSUE_ID_LENGTH && RELAY_ISSUE_ID_PATTERN.test(value);
}

/** Free text at most `max` characters, at least one, no NUL, not starting with `-`. */
export function isRelayText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= max && !value.includes("\u0000") && !value.startsWith("-");
}

export function isRelayPane(value: unknown): value is string {
  return typeof value === "string" && REVIEW_PANE_PATTERN.test(value);
}

function isStringVector(args: unknown): args is readonly string[] {
  return Array.isArray(args) && args.every((a) => typeof a === "string");
}

/** Whether `args` is one of the `bd` argument vectors the relay may run. */
export function isAllowedBdArgs(args: unknown): boolean {
  if (!isStringVector(args)) return false;
  const [command, a, b, c] = args;
  switch (args.length) {
    case 3:
      // show <id> --json | comments <id> --json
      return (command === "show" || command === "comments") && isRelayIssueId(a) && b === "--json";
    case 4:
      if (command === "comments") return a === "add" && isRelayIssueId(b) && isRelayText(c, MAX_RELAY_BD_TEXT_LENGTH);
      if (command === "update") return isRelayIssueId(a) && (b === "--add-label" || b === "--remove-label") && c === CHANGES_LABEL;
      if (command === "close") return isRelayIssueId(a) && b === "--reason" && isRelayText(c, MAX_RELAY_BD_TEXT_LENGTH);
      if (command === "list") return a === "--status=all" && b === "--limit=0" && c === "--json";
      return false;
    default:
      return false;
  }
}

/** Whether `args` is the one `herdr` argument vector the relay may run: `agent prompt <pane> <text>`. */
export function isAllowedHerdrArgs(args: unknown): boolean {
  if (!isStringVector(args) || args.length !== 4) return false;
  const [agent, prompt, pane, text] = args;
  return agent === "agent" && prompt === "prompt" && isRelayPane(pane) && isRelayText(text, MAX_RELAY_HERDR_TEXT_LENGTH);
}
