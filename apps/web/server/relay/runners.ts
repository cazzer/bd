// The relay's only way to run anything (laptop-relay design.md decisions 3
// and 9): `bd` and `herdr` wrappers that check every command against core's
// allowlist (relay-allowlist.ts, the same functions Breakdown checks at
// enqueue) and refuse before spawning. The inner runners spawn with an
// argument vector (`execFile`), never a shell: review-writer.ts's
// `createBdRunner` / `createHerdrRunner` for decisions and prompts,
// beads-ingest.ts's `createIngestBdRunner` for the watcher's reads.
//
// A `bd` runner is bound to one project: its `cwd` must be exactly that
// project's checkout in the relay's registry (registry.ts), so an action
// cannot point `bd` at another checkout, registered or not. A herdr socket
// must pass core's `isReviewSocketPath` and be a socket on disk, because
// pane ids are scoped to one herdr server and prompting through another
// could reach a different session's pane of the same id.
//
// A refusal is a `RelayRefusedError` whose message names the rule broken,
// never the free text (a comment, a prompt) that was refused.

import { statSync } from "node:fs";
import { createIngestBdRunner, isAllowedBdArgs, isAllowedHerdrArgs, isReviewSocketPath, type RunBd as IngestRunBd } from "@breakdown/core";
import { createBdRunner, createHerdrRunner, type RunBd, type RunHerdr } from "../review-writer.js";
import type { RelayRegistry } from "./registry.js";

/** The relay refused a command before running it; nothing ran. */
export class RelayRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayRefusedError";
  }
}

export interface RelayRunnerOptions {
  registry: Pick<RelayRegistry, "get">;
  /** The spawning runners; the defaults run `bd` and `herdr` from PATH (tests pass spies). */
  bd?: RunBd;
  herdr?: RunHerdr;
  ingestBd?: IngestRunBd;
  /** Whether `file` is a socket on disk (tests replace it). */
  isSocket?: (file: string) => boolean;
}

export interface RelayRunners {
  /** `bd` for a review decision in `project`'s checkout. */
  bdFor(project: string): RunBd;
  /** `bd` for the beads ingest of `project`'s checkout. */
  ingestBdFor(project: string): IngestRunBd;
  runHerdr: RunHerdr;
}

function isSocketOnDisk(file: string): boolean {
  try {
    return statSync(file).isSocket();
  } catch {
    return false;
  }
}

/** The shape refused, never its free text: the verb and the arity. */
function describeBd(args: readonly unknown[]): string {
  const verb = typeof args[0] === "string" && /^[a-z-]{1,32}$/.test(args[0]) ? args[0] : "(unnamed)";
  return `bd ${verb} with ${args.length} argument${args.length === 1 ? "" : "s"}`;
}

export function createRelayRunners(options: RelayRunnerOptions): RelayRunners {
  const bd = options.bd ?? createBdRunner();
  const herdr = options.herdr ?? createHerdrRunner();
  const ingestBd = options.ingestBd ?? createIngestBdRunner();
  const isSocket = options.isSocket ?? isSocketOnDisk;

  function checkBd(project: string, args: readonly string[], cwd: string): void {
    if (!isAllowedBdArgs(args)) throw new RelayRefusedError(`${describeBd(args)} is not on the relay's allowlist`);
    const entry = options.registry.get(project);
    if (entry === undefined) throw new RelayRefusedError(`project ${project} is not in this relay's registry`);
    if (cwd !== entry.dir) throw new RelayRefusedError(`${cwd} is not project ${project}'s checkout in this relay's registry (${entry.dir})`);
  }

  return {
    bdFor(project) {
      return async (args, cwd) => {
        checkBd(project, args, cwd);
        return bd(args, cwd);
      };
    },
    ingestBdFor(project) {
      return async (args, cwd, signal) => {
        checkBd(project, args, cwd);
        return ingestBd(args, cwd, signal);
      };
    },
    async runHerdr(args, socket) {
      if (!isAllowedHerdrArgs(args)) throw new RelayRefusedError("this herdr command is not on the relay's allowlist (only agent prompt <pane> <text>)");
      if (!isReviewSocketPath(socket)) throw new RelayRefusedError("the herdr socket is not an absolute path of at most 512 characters without control characters");
      if (!isSocket(socket)) throw new RelayRefusedError(`the herdr socket ${socket} is not a socket on this machine`);
      return herdr(args, socket);
    },
  };
}
