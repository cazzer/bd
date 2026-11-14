// tRPC request context (bd-hmd.3). The database connection is opened once
// at startup (index.ts) and verified before the server ever listens — the
// context factory just closes over it, never opens or reads env itself,
// so this stays testable without a real HTTP request.

import type { IncomingMessage } from "node:http";
import type { HostBinary } from "@breakdown/core";
import type { ClientTokenScope, Database } from "@breakdown/db";
import type { BeadsWatcher } from "./beads-watcher.js";
import type { RunHerdrJson } from "./herdr-session.js";
import type { ReviewWriter, RunHerdr } from "./review-writer.js";

export interface Context {
  db: Database;
  /**
   * Character budget for a single procedure response's JSON payload — see
   * budget.ts. Unset in production (the HTTP context factory never sets
   * it, so every procedure bounds at `DEFAULT_RESPONSE_CHAR_BUDGET`); a
   * test injects a small one to prove trimming without writing megabytes
   * into the database. Same seam as apps/mcp's `ToolContext.responseCharBudget`.
   */
  responseCharBudget?: number;
  /** The beads watcher (index.ts creates it). Optional so callers that never touch the live board — every existing caller test — need not build one. */
  watcher?: BeadsWatcher;
  /** Aborted at shutdown; subscriptions end on it so shutdown never waits on a connected browser. */
  shutdownSignal?: AbortSignal;
  /** BRAIN_READ_ONLY (config.ts): every write procedure (review, inbox, routers/write.ts) is refused when set. Unset means writable. */
  readOnly?: boolean;
  /** Runs review decisions through `bd` (review-writer.ts). Optional so callers that never decide a review need not build one; the decision is refused without it. */
  reviewWriter?: ReviewWriter;
  /** Tells a live session's herdr pane about an inbox decision (routers/inbox.ts). Optional; without it nobody is told. */
  runHerdr?: RunHerdr;
  /** Runs herdr commands whose JSON result matters (opening an inbox item's session). Optional; without it "Open session" is refused. */
  herdrJson?: RunHerdrJson;
  /** The herdr server socket those commands use; null when none was found. */
  herdrSocket?: string | null;
  /** Where an inbox item's interactive session starts. */
  sessionCwd?: string;
  /**
   * Host-only binaries (`bd`, `herdr`) not on PATH when the server started
   * (index.ts; tailnet-hosting decision 8). A procedure that needs one is
   * refused with PRECONDITION_FAILED naming it. Absent means none missing.
   */
  missingBinaries?: readonly HostBinary[];
  /** The review media root (`--media-dir`, else core's REVIEW_IMAGE_ROOT); image URLs are built against it. */
  reviewImageRoot?: string;
  /**
   * The client token that admitted this request (dispatch.ts), or null for
   * a tokenless loopback request. Human writes record it as their run's
   * actor (tailnet-hosting decision 4). Optional so direct callers (tests)
   * need not set it; absent means the same as null.
   */
  client?: string | null;
  /**
   * The admitted token's scope (dispatch.ts), or null for a tokenless
   * loopback request. Each procedure declares the scopes it accepts
   * (trpc.ts `scopeGate`); null and absent both count as `human`, since a
   * tokenless request is the local person (hangar-queue decision 5).
   */
  scope?: ClientTokenScope | null;
  /**
   * The hangar session the admitting token is bound to (hangar-queue
   * decision 4), or null for any other token or none. Absent means null.
   */
  sessionId?: string | null;
}

/** What admission established about a tokened request (dispatch.ts). */
export interface AdmittedClient {
  client: string;
  scope: ClientTokenScope;
  sessionId: string | null;
}

/**
 * The admitted token client and scope per request, written by the
 * dispatcher after admission and read by the context factory. A WeakMap
 * keyed on the request object rather than a header or a property on `req`,
 * so nothing a client sends can set it, and an entry goes away with its
 * request. A tokenless request has no entry.
 */
export const admittedClients = new WeakMap<IncomingMessage, AdmittedClient>();

/** Builds the per-request context factory tRPC's HTTP adapter calls. `db` is created once, at startup, and shared across every request. */
export function createContextFactory(db: Database, live: Pick<Context, "watcher" | "shutdownSignal" | "readOnly" | "reviewWriter" | "runHerdr" | "herdrJson" | "herdrSocket" | "sessionCwd" | "missingBinaries" | "reviewImageRoot"> = {}) {
  return async ({ req }: { req: IncomingMessage }): Promise<Context> => {
    const admitted = admittedClients.get(req);
    return { db, ...live, client: admitted?.client ?? null, scope: admitted?.scope ?? null, sessionId: admitted?.sessionId ?? null };
  };
}
