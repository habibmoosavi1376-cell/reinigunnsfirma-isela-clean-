#!/usr/bin/env node
// Ensures that no business, authorization, pricing, service-area or partner-assignment logic
// is tied to a specific location. The start market may only appear in seed data, tests and
// documentation (docs/DOMAIN_MODEL.md §3).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;

/** Location names that must not appear in application code. Extend when new markets open. */
const LOCATION_NAMES = ["Gelsenkirchen", "Ruhrgebiet", "Nordrhein-Westfalen"];

/** Paths where location names are legitimate data or documentation. */
const ALLOWED = [/^packages\/database\/src\/seed\//, /^packages\/database\/migrations\//];

/** Generic anti-pattern: comparing a city/postal-code value against a string literal. */
const LOCATION_COMPARISON = /\b(city|cityName|postalCode|zip|plz)\b\s*[!=]==?\s*["'`]/i;

function files(dir) {
  return readdirSync(dir).flatMap((entry) => {
    if (["node_modules", "dist", ".next", "test-results", "playwright-report"].includes(entry)) {
      return [];
    }
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|tsx|js|mjs|sql)$/.test(path) ? [path] : [];
  });
}

const findings = [];
for (const file of [...files(join(root, "packages")), ...files(join(root, "apps"))]) {
  const rel = relative(root, file);
  if (ALLOWED.some((pattern) => pattern.test(rel))) continue;
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, index) => {
    for (const name of LOCATION_NAMES) {
      if (line.toLowerCase().includes(name.toLowerCase())) {
        findings.push(`${rel}:${index + 1}: location name "${name}" in application code`);
      }
    }
    if (LOCATION_COMPARISON.test(line)) {
      findings.push(`${rel}:${index + 1}: comparison of a location field with a literal`);
    }
  });
}

if (findings.length > 0) {
  console.error("Hard-coded location logic found:\n" + findings.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
console.log("OK: no hard-coded location logic in application code.");
