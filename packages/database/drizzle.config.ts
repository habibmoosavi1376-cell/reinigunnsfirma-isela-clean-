import { defineConfig } from "drizzle-kit";

// Only `generate` and `check` are used from drizzle-kit; migrations are applied by
// `src/cli/migrate.ts` so that production and tests use the same code path.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  strict: true,
  verbose: true,
});
