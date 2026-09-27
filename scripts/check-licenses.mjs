#!/usr/bin/env node
// License policy: only licenses on the allowlist may be installed (production and dev).
// Unknown or copyleft licenses fail the check and need an explicit, documented decision.
import { execFileSync } from "node:child_process";

const ALLOWED = new Set([
  "MIT",
  "ISC",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "BlueOak-1.0.0",
  "CC0-1.0",
  "Unlicense",
  // Weak, file-level copyleft; allowed for unmodified use (lightningcss via the build toolchain).
  "MPL-2.0",
]);

const output = execFileSync("pnpm", ["licenses", "list", "--json"], { encoding: "utf8" });
const byLicense = JSON.parse(output);

const violations = [];
let total = 0;
for (const [license, packages] of Object.entries(byLicense)) {
  total += packages.length;
  const parts = license.replace(/[()]/g, "").split(/\s+OR\s+/);
  if (!parts.some((part) => ALLOWED.has(part.trim()))) {
    for (const pkg of packages) {
      violations.push(`${pkg.name}@${pkg.versions.join(",")}: ${license}`);
    }
  }
}

if (violations.length > 0) {
  console.error("License policy violations:\n" + violations.map((v) => `  - ${v}`).join("\n"));
  process.exit(1);
}
console.log(`OK: ${total} packages, all licenses on the allowlist.`);
