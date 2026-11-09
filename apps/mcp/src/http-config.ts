// Command-line configuration for the HTTP entrypoint (design.md decisions
// 4–5). Port and bind address are flags, not environment variables, so
// the project's environment allowlist stays as it is and any supervisor
// (launchd, systemd, a container `command:`) can pass them.
//
// Loopback is enforced here, not merely defaulted: HTTP mode has no
// authentication, so a non-loopback `--host` is refused before anything
// listens (brain-mcp spec, "HTTP mode is local only"). Pure — http.ts owns
// turning an HttpConfigError into an exit.

import { parseArgs } from "node:util";

export const DEFAULT_HTTP_PORT = 5320;
export const DEFAULT_HTTP_HOST = "127.0.0.1";

const LOOPBACK_HOSTS = ["127.0.0.1", "::1", "localhost"] as const;
export type LoopbackHost = (typeof LOOPBACK_HOSTS)[number];

export interface HttpConfig {
  port: number;
  host: LoopbackHost;
}

/** A flag the HTTP entrypoint cannot start with; the message names the value and what is accepted. */
export class HttpConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HttpConfigError";
  }
}

function isLoopbackHost(value: string): value is LoopbackHost {
  return (LOOPBACK_HOSTS as readonly string[]).includes(value);
}

/** Parses `--port <n> --host <addr>` (process.argv.slice(2)); throws HttpConfigError naming the offending value. */
export function parseHttpArgs(argv: readonly string[]): HttpConfig {
  let values: { port?: string; host?: string };
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: { port: { type: "string" }, host: { type: "string" } },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    throw new HttpConfigError(`${err instanceof Error ? err.message : String(err)} (accepted: --port <1-65535> --host <127.0.0.1|::1|localhost>)`);
  }

  let port = DEFAULT_HTTP_PORT;
  if (values.port !== undefined) {
    const parsed = /^\d+$/.test(values.port) ? Number(values.port) : NaN;
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      throw new HttpConfigError(`--port "${values.port}" is not an integer from 1 to 65535`);
    }
    port = parsed;
  }

  let host: LoopbackHost = DEFAULT_HTTP_HOST;
  if (values.host !== undefined) {
    const lowered = values.host.toLowerCase();
    if (!isLoopbackHost(lowered)) {
      throw new HttpConfigError(
        `--host ${values.host} is not a loopback address; network exposure is not supported in HTTP mode (use 127.0.0.1, ::1, or localhost)`,
      );
    }
    host = lowered;
  }

  return { port, host };
}
