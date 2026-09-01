import { defineConfig } from "drizzle-kit";
import { resolveDatabaseUrl } from "./src/env.js";

// This file is the drizzle-kit CLI entry point, not part of the
// @breakdown/db library surface — resolving/throwing at load time here is
// fine; it never gets imported by another package.
const databaseUrl = resolveDatabaseUrl();

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: databaseUrl,
  },
});
