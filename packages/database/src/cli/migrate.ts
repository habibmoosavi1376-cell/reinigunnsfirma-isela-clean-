import { createDatabase } from "../client.ts";
import { runMigrations } from "../migrate.ts";

const url = process.env["DATABASE_URL"];
if (url === undefined || url === "") {
  console.error("DATABASE_URL is not set. Refusing to run migrations.");
  process.exit(1);
}

const handle = createDatabase(url, { maxConnections: 1, applicationName: "isela-migrate" });
try {
  await runMigrations(handle.db);
  console.log("Migrations applied.");
} finally {
  await handle.close();
}
