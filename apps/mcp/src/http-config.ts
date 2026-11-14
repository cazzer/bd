// Command-line configuration for the HTTP entrypoint (design.md decisions
// 4–5; tailnet-hosting decision 1). Port, bind address, and allowed hosts
// are flags, not environment variables, so the project's environment
// allowlist stays as it is and any supervisor (launchd, systemd, a
// container `command:`) can pass them.
//
// Loopback is the default bind, not an enforced one. Binding elsewhere
// exposes nothing by itself: every request still passes the shared
// admission function (packages/core admission.ts), which refuses any Host
// that is neither loopback nor named by `--allow-host`, and requires a
// client token for anything but a loopback peer with a loopback Host. So
// exposure takes both `--allow-host` and tokens; `bindWarning` tells the
// operator when the first is missing. Pure — http.ts owns turning an
// HttpConfigError into an exit and printing the warning.

import { parseArgs } from "node:util";
import { isLoopbackAddress, LOOPBACK_HOST_NAMES, normalizeAllowedHost } from "@breakdown/core";

export const DEFAULT_HTTP_PORT = 5320;
export const DEFAULT_HTTP_HOST = "127.0.0.1";

export interface HttpConfig {
  port: number;
  /** The address to bind, lowercased. */
  host: string;
  /** `--allow-host` values, each normalized by `normalizeAllowedHost`. */
  allowedHosts: string[];
}

/** A flag the HTTP entrypoint cannot start with; the message names the value and what is accepted. */
export class HttpConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HttpConfigError";
  }
}

const ACCEPTED = "accepted: --port <0-65535> --host <addr> --allow-host <hostname> (repeatable)";

/**
 * Parses `--port <n> --host <addr> [--allow-host <name>]...`
 * (process.argv.slice(2)); throws HttpConfigError naming the offending
 * value. `--port 0` asks the OS for an ephemeral port; the ready line names
 * the one it chose.
 */
export function parseHttpArgs(argv: readonly string[]): HttpConfig {
  let values: { port?: string; host?: string; "allow-host"?: string[] };
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: { port: { type: "string" }, host: { type: "string" }, "allow-host": { type: "string", multiple: true } },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    throw new HttpConfigError(`${err instanceof Error ? err.message : String(err)} (${ACCEPTED})`);
  }

  let port = DEFAULT_HTTP_PORT;
  if (values.port !== undefined) {
    const parsed = /^\d+$/.test(values.port) ? Number(values.port) : NaN;
    if (!Number.isInteger(parsed) || parsed > 65535) {
      throw new HttpConfigError(`--port "${values.port}" is not an integer from 0 to 65535`);
    }
    port = parsed;
  }

  let host = DEFAULT_HTTP_HOST;
  if (values.host !== undefined) {
    const lowered = values.host.trim().toLowerCase();
    if (lowered === "") throw new HttpConfigError(`--host "${values.host}" is empty; give an address to bind`);
    host = lowered;
  }

  const allowedHosts = (values["allow-host"] ?? []).map((value) => {
    try {
      return normalizeAllowedHost(value);
    } catch (err) {
      // normalizeAllowedHost's message names the value and why it is refused.
      throw new HttpConfigError(`--allow-host: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  return { port, host, allowedHosts };
}

/** True for a bind address only reachable from this machine. */
function isLoopbackBind(host: string): boolean {
  return host === "localhost" || isLoopbackAddress(host);
}

/**
 * A startup warning, or null: bound off loopback with no `--allow-host`,
 * the server is reachable from the network but admits only loopback Host
 * values, so every remote request gets 403. Said once at startup rather
 * than left for the operator to discover as silent refusals.
 */
export function bindWarning(config: HttpConfig): string | null {
  if (isLoopbackBind(config.host) || config.allowedHosts.length > 0) return null;
  return (
    `bound to ${config.host} with no --allow-host: only requests whose Host is a loopback name ` +
    `(${LOOPBACK_HOST_NAMES.join(", ")}) will be admitted, so remote clients will be refused with 403. ` +
    `Pass --allow-host <name> for each name remote clients use (with a client token per client).`
  );
}
