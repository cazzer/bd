#!/usr/bin/env node
// The image's entrypoint (tailnet-hosting decision 6); the logic lives in
// container-launch-lib.mjs. BREAKDOWN_* env → flags, migrations (retried
// while the database app starts), then the web and MCP servers as two
// supervised children. Exits 2 on bad configuration, 1 when migrations never
// succeed or a server exits, 0 after a stop signal.
//
// Run as PID 1 (no `init`), the launcher gets no default signal handling,
// so it handles SIGTERM/SIGINT itself from the first moment, migrations
// included; under `init: true` the init forwards them here all the same.
import { spawn } from "node:child_process";
import os from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { LaunchConfigError, hostNetworkWarning, migrateWithRetry, planLaunch, runWithTimeout, supervise } from "./container-launch-lib.mjs";

let plan;
try {
  plan = planLaunch(process.env);
} catch (err) {
  if (!(err instanceof LaunchConfigError)) throw err;
  console.error(`[launcher] cannot start: ${err.message}`);
  process.exit(2);
}

const warning = hostNetworkWarning(plan.host, os.networkInterfaces());
if (warning !== null) console.error(warning);

const start = (argv) => spawn(process.execPath, argv, { env: plan.childEnv, stdio: "inherit" });

let migrating;
const stopWhileMigrating = (signal) => {
  console.error(`[launcher] ${signal} received during migrations; exiting`);
  migrating?.kill(signal);
  process.exit(0);
};
process.on("SIGTERM", stopWhileMigrating);
process.on("SIGINT", stopWhileMigrating);

const migrated = await migrateWithRetry({
  runMigrate: () => {
    migrating = start(plan.migrate);
    return runWithTimeout(migrating);
  },
  sleep,
  log: (line) => console.error(line),
});
if (!migrated) {
  console.error("[launcher] cannot start: migrations did not succeed; is the database reachable at DATABASE_URL?");
  process.exit(1);
}

process.off("SIGTERM", stopWhileMigrating);
process.off("SIGINT", stopWhileMigrating);

supervise(
  { web: start(plan.web), mcp: start(plan.mcp) },
  { signals: process, exit: (code) => process.exit(code) },
);
