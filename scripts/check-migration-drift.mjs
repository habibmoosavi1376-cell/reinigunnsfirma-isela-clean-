#!/usr/bin/env node
// Fails when the Drizzle schema and the committed migrations diverge: drizzle-kit generates
// into a temporary copy of the migrations folder; any new file means a migration is missing.
//
// `process.exitCode` is used instead of `process.exit()` so that the temporary copy is always
// removed in `finally`.
// Fail closed: drizzle-kit may exit with code 0 even when it fails (observed with absolute
// --out paths), so the check only passes on the explicit "No schema changes" message.
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const databaseDir = new URL("../packages/database/", import.meta.url).pathname;
const migrations = join(databaseDir, "migrations");
// drizzle-kit requires a path relative to the package directory.
const tempAbsolute = mkdtempSync(join(databaseDir, ".drift-check-"));
const tempRelative = `./${tempAbsolute.slice(databaseDir.length)}`;

try {
  cpSync(migrations, tempAbsolute, { recursive: true });
  const before = new Set(readdirSync(tempAbsolute));
  const output = execFileSync(
    "pnpm",
    [
      "exec",
      "drizzle-kit",
      "generate",
      "--dialect=postgresql",
      "--schema=./src/schema/index.ts",
      `--out=${tempRelative}`,
      "--name=drift_probe",
    ],
    { cwd: databaseDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const added = readdirSync(tempAbsolute).filter(
    (file) => !before.has(file) && file.endsWith(".sql"),
  );
  if (added.length > 0) {
    console.error(
      `Schema drift: the schema requires a migration that is not committed (${added.join(", ")}).`,
    );
    console.error("Run `pnpm db:generate` and review the generated SQL.");
    process.exitCode = 1;
  } else if (!output.includes("No schema changes")) {
    console.error("Drift check inconclusive – drizzle-kit did not confirm the absence of changes:");
    console.error(output);
    process.exitCode = 1;
  } else {
    console.log("OK: schema and migrations are in sync.");
  }
} finally {
  rmSync(tempAbsolute, { recursive: true, force: true });
}
