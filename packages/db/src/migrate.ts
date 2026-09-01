import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "./client.js";

async function main() {
  const dirname = path.dirname(fileURLToPath(import.meta.url));
  const migrationsFolder = path.resolve(dirname, "../migrations");
  await migrate(db, { migrationsFolder });
  console.log("Migrations applied.");
}

main()
  .catch((err) => {
    console.error("Migration failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
