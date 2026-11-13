#!/usr/bin/env node
// The image's entrypoint (tailnet-hosting decision 6); the logic lives in
// container-launch-lib.mjs. BREAKDOWN_* env → flags, migrations (retried
// while the database app starts), then the web and MCP servers as two
// supervised children. Exits 2 on bad configuration, 1 when migrations never
// succeed or a server exits, 0 after a stop signal.
//
// As PID 1 the launcher gets no default signal handling, so it handles
// SIGTERM/SIGINT itself from the first moment, migrations included.
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { LaunchConfigError, migrateWithRetry, planLaunch, supervise } from "./container-launch-lib.mjs";

let plan;
try {
  plan = planLaunch(process.env);
} catch (err) {
  if (!(err instanceof LaunchConfigError)) throw err;
  console.error(`[launcher] cannot start: ${err.message}`);
  process.exit(2);
}

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
  runMigrate: () =>
    new Promise((resolve) => {
      migrating = start(plan.migrate);
      migrating.on("exit", (code, signal) => resolve(code ?? signal));
      migrating.on("error", (err) => resolve(err.message));
    }),
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
