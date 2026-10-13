import pg from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema/index.ts";

export type Schema = typeof schema;
export type Database = NodePgDatabase<Schema>;
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
/** Anything that can execute queries: the database itself or an open transaction. */
export type DbExecutor = Database | Transaction;

export interface DatabaseHandle {
  readonly db: Database;
  readonly pool: pg.Pool;
  close(): Promise<void>;
}

export interface DatabaseOptions {
  readonly maxConnections?: number;
  readonly applicationName?: string;
}

export function createDatabase(
  connectionString: string,
  options: DatabaseOptions = {},
): DatabaseHandle {
  const pool = new pg.Pool({
    connectionString,
    max: options.maxConnections ?? 10,
    application_name: options.applicationName ?? "isela-clean",
  });
  const db = drizzle(pool, { schema });
  return {
    db,
    pool,
    close: () => pool.end(),
  };
}
