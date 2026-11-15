// The relay's only way to run anything (laptop-relay design.md decisions 3
// and 9): `bd` and `herdr` wrappers that check every command against core's
// allowlist (relay-allowlist.ts, the same functions Breakdown checks at
// enqueue) and against the relay's own configuration, and refuse before
// spawning. The inner runners spawn with an argument vector (`execFile`),
// never a shell: review-writer.ts's `createBdRunner` / `createHerdrRunner`
// for decisions and prompts, beads-ingest.ts's `createIngestBdRunner` for
// the watcher's reads.
//
// A `bd` runner is bound to one project: its `cwd` must be exactly that
// project's checkout in the relay's registry (registry.ts), which holds
// only `--project` paths, so an action cannot point `bd` at another
// checkout. The checkout is checked again immediately before the spawn —
// still its own realpath, still holding `.beads/` — so a path swapped for
// a symlink since the last refresh runs nothing.
//
// A herdr call — a `herdr_prompt` and a review decision's notification
// alike — must name a socket in the relay's allowlist (`--herdr-socket`,
// herdr's default socket for this user when none is given), and that path
// must be, by lstat (never following a symlink), a socket owned by the
// relay's own uid. Pane ids are scoped to one herdr server, so a socket
// the relay was not told about could reach another session's pane of the
// same id, or another user's server. Every prompt is sent with core's
// provenance line before it (`withRelayProvenance`), so the agent reading
// it knows it came through the relay and is untrusted input.
//
// A refusal is a `RelayRefusedError` whose message names the rule broken,
// never the free text (a comment, a prompt) that was refused.

import { lstatSync } from "node:fs";
import { createIngestBdRunner, isAllowedBdArgs, isAllowedHerdrArgs, isReviewSocketPath, withRelayProvenance, type RunBd as IngestRunBd } from "@breakdown/core";
import { createBdRunner, createHerdrRunner, type RunBd, type RunHerdr } from "../review-writer.js";
import { checkoutProblem, type RelayRegistry } from "./registry.js";

/** The relay refused a command before running it; nothing ran. */
export class RelayRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayRefusedError";
  }
}

/** What lstat says about a path: whether it is a socket, and its owner. Null when there is nothing there. */
export type SocketInspection = { isSocket: boolean; uid: number } | null;

export interface RelayRunnerOptions {
  registry: Pick<RelayRegistry, "get">;
  /** `--herdr-socket`: the only herdr servers the relay may prompt through. */
  herdrSockets: readonly string[];
  /** The spawning runners; the defaults run `bd` and `herdr` from PATH (tests pass spies). */
  bd?: RunBd;
  herdr?: RunHerdr;
  ingestBd?: IngestRunBd;
  /** lstat of a socket path (tests replace it). */
  inspectSocket?: (file: string) => SocketInspection;
  /** The relay's uid; `process.getuid()` by default. */
  uid?: number;
  /** Why a checkout is not usable right now, or null (registry.ts `checkoutProblem`; tests replace it). */
  checkDir?: (dir: string) => string | null;
}

export interface RelayRunners {
  /** `bd` for a review decision in `project`'s checkout. */
  bdFor(project: string): RunBd;
  /** `bd` for the beads ingest of `project`'s checkout. */
  ingestBdFor(project: string): IngestRunBd;
  /** `herdr agent prompt` on an allowlisted socket, with the provenance line before the text. */
  runHerdr: RunHerdr;
}

function lstatSocket(file: string): SocketInspection {
  try {
    const stat = lstatSync(file);
    return { isSocket: stat.isSocket(), uid: stat.uid };
  } catch {
    return null;
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
  const inspectSocket = options.inspectSocket ?? lstatSocket;
  const checkDir = options.checkDir ?? checkoutProblem;
  const uid = options.uid ?? process.getuid?.();
  const sockets = new Set(options.herdrSockets);

  function checkBd(project: string, args: readonly string[], cwd: string): void {
    if (!isAllowedBdArgs(args)) throw new RelayRefusedError(`${describeBd(args)} is not on the relay's allowlist`);
    const entry = options.registry.get(project);
    if (entry === undefined) throw new RelayRefusedError(`project ${project} is not in this relay's registry`);
    if (cwd !== entry.dir) throw new RelayRefusedError(`${cwd} is not project ${project}'s checkout in this relay's registry (${entry.dir})`);
    const problem = checkDir(entry.dir);
    if (problem !== null) throw new RelayRefusedError(`project ${project}'s checkout ${entry.dir} ${problem}`);
  }

  function checkSocket(socket: string): void {
    if (!isReviewSocketPath(socket)) throw new RelayRefusedError("the herdr socket is not an absolute path of at most 512 characters without control characters");
    if (!sockets.has(socket)) throw new RelayRefusedError(`the herdr socket ${socket} is not one this relay may prompt through (--herdr-socket)`);
    const found = inspectSocket(socket);
    if (found === null || !found.isSocket) throw new RelayRefusedError(`the herdr socket ${socket} is not a socket on this machine`);
    if (uid === undefined || found.uid !== uid) throw new RelayRefusedError(`the herdr socket ${socket} is owned by uid ${found.uid}, not by this relay's user`);
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
      const text = args[3];
      const sent = args.length === 4 && typeof text === "string" ? [args[0]!, args[1]!, args[2]!, withRelayProvenance(text)] : args;
      if (!isAllowedHerdrArgs(sent) || !isAllowedHerdrArgs(args)) throw new RelayRefusedError("this herdr command is not on the relay's allowlist (only agent prompt <pane> <text>, the text within the cap with the relay's provenance line)");
      checkSocket(socket);
      return herdr(sent, socket);
    },
  };
}
