// Command-line configuration for the web API server (tailnet-hosting
// decision 1). Bind address, port, and allowed hosts are flags, so the
// project's environment allowlist stays as it is; `WEB_SERVER_PORT` is
// kept only as the port's fallback, because vite.config.ts's dev proxy
// reads it to find this server.
//
// A deliberate copy of apps/mcp/src/http-config.ts, not a shared module:
// only admission is shared between the two servers (packages/core
// admission.ts); the adapters stay copy-not-share.
//
// Loopback is the default bind, not an enforced one. Binding elsewhere
// exposes nothing by itself: every request still passes the shared
// admission function, which refuses any Host that is neither loopback nor
// named by `--allow-host`, and requires a client token for anything but a
// loopback peer with a loopback Host. `bindWarning` tells the operator
// when the bind is off loopback but no host is allowed. Pure — index.ts
// owns turning a WebArgsError into an exit and printing the warning.

import path from "node:path";
import { parseArgs } from "node:util";
import { isLoopbackAddress, LOOPBACK_HOST_NAMES, normalizeAllowedHost } from "@breakdown/core";

/** vite.config.ts's dev proxy target must agree with this. */
export const DEFAULT_WEB_PORT = 4310;
export const DEFAULT_WEB_HOST = "127.0.0.1";

export interface WebArgs {
  /** The address to bind, lowercased. */
  host: string;
  port: number;
  /** `--allow-host` values, each normalized by `normalizeAllowedHost`. */
  allowedHosts: string[];
  /** `--client-dir`, absolute: the built browser client to serve (static-client.ts), or null to serve none (Vite does, under `pnpm dev`). */
  clientDir: string | null;
  /** `--media-dir`, absolute: the review media root, or null for core's REVIEW_IMAGE_ROOT. */
  mediaDir: string | null;
}

/** A flag (or `WEB_SERVER_PORT`) the server cannot start with; the message names the value and what is accepted. */
export class WebArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebArgsError";
  }
}

const ACCEPTED = "accepted: --port <1-65535> --host <addr> --allow-host <hostname> (repeatable) --client-dir <dir> --media-dir <dir>";

// No 0 (an ephemeral port): the dispatcher pins Host to the port it is
// given before the server listens, so an OS-chosen port would refuse every
// request, and vite.config.ts's proxy could not find it either.
function parsePort(value: string, source: string): number {
  const parsed = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(parsed) || parsed > 65535) {
    throw new WebArgsError(`${source} "${value}" is not an integer from 1 to 65535`);
  }
  if (parsed === 0) {
    throw new WebArgsError(`${source} "${value}": the web server needs a fixed port (admission pins Host to it); give one from 1 to 65535`);
  }
  return parsed;
}

/**
 * Parses `--port <n> --host <addr> [--allow-host <name>]...
 * [--client-dir <dir>] [--media-dir <dir>]` (process.argv.slice(2)). The port is `--port`, else `envPort`
 * (`WEB_SERVER_PORT`), else 4310. Throws WebArgsError naming the
 * offending value.
 */
export function parseWebArgs(argv: readonly string[], envPort: string | undefined): WebArgs {
  let values: { port?: string; host?: string; "allow-host"?: string[]; "client-dir"?: string; "media-dir"?: string };
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        port: { type: "string" },
        host: { type: "string" },
        "allow-host": { type: "string", multiple: true },
        "client-dir": { type: "string" },
        "media-dir": { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    throw new WebArgsError(`${err instanceof Error ? err.message : String(err)} (${ACCEPTED})`);
  }

  let port = DEFAULT_WEB_PORT;
  if (values.port !== undefined) port = parsePort(values.port, "--port");
  else if (envPort !== undefined && envPort !== "") port = parsePort(envPort, "WEB_SERVER_PORT");

  let host = DEFAULT_WEB_HOST;
  if (values.host !== undefined) {
    const lowered = values.host.trim().toLowerCase();
    if (lowered === "") throw new WebArgsError(`--host "${values.host}" is empty; give an address to bind`);
    host = lowered;
  }

  const allowedHosts = (values["allow-host"] ?? []).map((value) => {
    try {
      return normalizeAllowedHost(value);
    } catch (err) {
      // normalizeAllowedHost's message names the value and why it is refused.
      throw new WebArgsError(`--allow-host: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  return { host, port, allowedHosts, clientDir: directoryFlag(values["client-dir"], "--client-dir"), mediaDir: directoryFlag(values["media-dir"], "--media-dir") };
}

/** A directory flag as an absolute path, or null when absent. Whether it exists is index.ts's check, not a parse error. */
function directoryFlag(value: string | undefined, flag: string): string | null {
  if (value === undefined) return null;
  if (value.trim() === "") throw new WebArgsError(`${flag} is empty; give a directory`);
  return path.resolve(value);
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
export function bindWarning(args: Pick<WebArgs, "host" | "port" | "allowedHosts">): string | null {
  if (isLoopbackBind(args.host) || args.allowedHosts.length > 0) return null;
  return (
    `bound to ${args.host} with no --allow-host: only requests whose Host is a loopback name ` +
    `(${LOOPBACK_HOST_NAMES.join(", ")}) will be admitted, so remote clients will be refused with 403. ` +
    `Pass --allow-host <name> for each name remote clients use (with a client token per client).`
  );
}
