export { createDatabase } from "./client.ts";
export type {
  Database,
  DatabaseHandle,
  DatabaseOptions,
  DbExecutor,
  Schema,
  Transaction,
} from "./client.ts";
export { runMigrations, migrationsFolder } from "./migrate.ts";
export * as schema from "./schema/index.ts";
export {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
export type { SQL } from "drizzle-orm";
export { seedReferenceData } from "./seed/seed.ts";
export {
  SEED_LEAD_SOURCES,
  SEED_SERVICE_CATEGORIES,
  SEED_START_CITY,
  SEED_START_SERVICE_AREA,
} from "./seed/reference-data.ts";
