#!/usr/bin/env node
// Verifies that no server-only secret reaches the browser: scans the client assets of the
// production build (apps/web/.next/static) for
//   1. the names of server-only secret variables (would indicate server code in a client chunk),
//   2. the actual secret values present in the environment at build time (CI builds with
//      random canary values), and
//   3. connection strings / private key material.
// Run after `pnpm --filter @isela/web build`.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const staticDir = join(root, "apps/web/.next/static");

const SECRET_VARIABLES = [
  "AUTH_SECRET",
  "IDENTITY_HASH_PEPPER",
  "DATABASE_URL",
  "SMTP_PASSWORD",
  "SMTP_USER",
  "GEOCODING_API_KEY",
];
const PATTERNS = [/postgres(ql)?:\/\//i, /-----BEGIN [A-Z ]*PRIVATE KEY-----/];

if (!existsSync(staticDir)) {
  console.error("apps/web/.next/static not found – build the web app first.");
  process.exit(1);
}

function files(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

const values = SECRET_VARIABLES.map((name) => process.env[name]).filter(
  (value) => typeof value === "string" && value.length >= 8,
);

const findings = [];
let scanned = 0;
for (const file of files(staticDir)) {
  if (!/\.(js|mjs|css|json|html|txt|map)$/.test(file)) continue;
  scanned += 1;
  const content = readFileSync(file, "utf8");
  const rel = file.slice(root.length);
  for (const name of SECRET_VARIABLES) {
    if (content.includes(name)) findings.push(`${rel}: contains secret variable name ${name}`);
  }
  for (const value of values) {
    if (content.includes(value)) findings.push(`${rel}: contains a server secret value`);
  }
  for (const pattern of PATTERNS) {
    if (pattern.test(content)) findings.push(`${rel}: matches ${pattern}`);
  }
}

if (findings.length > 0) {
  console.error("Client bundle leaks:\n" + findings.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
console.log(
  `OK: ${scanned} client assets scanned, no server secrets (${values.length} canary values checked).`,
);
