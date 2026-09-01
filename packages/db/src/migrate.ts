import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb, createPool } from "./client.js";
import { resolveDatabaseUrl } from "./env.js";

async function main() {
  const databaseUrl = resolveDatabaseUrl();
  const pool = createPool(databaseUrl);
  const db = createDb(pool);

  try {
    const dirname = path.dirname(fileURLToPath(import.meta.url));
    const migrationsFolder = path.resolve(dirname, "../migrations");
    await migrate(db, { migrationsFolder });
    console.log("Migrations applied.");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exitCode = 1;
});
