import { syncRbacCatalog } from "@isela/auth";
import { createDatabase, seedReferenceData, sql } from "@isela/database";
import { runMigrations } from "@isela/database/migrate";

/*
 * TEST-ONLY. Resets the dedicated E2E database: drops and recreates the schema, applies all
 * migrations exactly as in production, seeds reference data and syncs the RBAC catalogue.
 * Guarded: refuses to run unless the database name contains "e2e".
 */

const url = process.env["E2E_DATABASE_URL"];
if (url === undefined || url === "") {
  console.error("E2E_DATABASE_URL is required");
  process.exit(1);
}
const name = new URL(url).pathname.replace(/^\//, "");
if (!name.includes("e2e")) {
  console.error("Refusing to reset a database whose name does not contain 'e2e'");
  process.exit(1);
}

const handle = createDatabase(url, { maxConnections: 1, applicationName: "isela-e2e-setup" });
try {
  await handle.db.execute(sql`DROP SCHEMA IF EXISTS drizzle CASCADE`);
  await handle.db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE`);
  await handle.db.execute(sql`CREATE SCHEMA public`);
  await runMigrations(handle.db);
  await seedReferenceData(handle.db);
  await syncRbacCatalog(handle.db);
} finally {
  await handle.close();
}
