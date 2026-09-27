import { syncRbacCatalog } from "@isela/auth";
import { createDatabase, runMigrations, seedReferenceData, sql } from "@isela/database";
import { requireTestDatabaseUrl } from "./env.ts";

/**
 * Prepares the integration test database: drops and recreates the schema, applies all
 * migrations exactly as in production, seeds reference data and syncs the RBAC catalogue.
 * Guarded: refuses to run against a database whose name does not contain "test".
 */
export default async function setup(): Promise<void> {
  const url = requireTestDatabaseUrl();
  const handle = createDatabase(url, { maxConnections: 1, applicationName: "isela-test-setup" });
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
}
