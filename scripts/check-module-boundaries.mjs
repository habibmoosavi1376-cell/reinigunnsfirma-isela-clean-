#!/usr/bin/env node
// Enforces the module dependency graph of the modular monolith (docs/ARCHITECTURE.md §3.2):
// 1. every internal dependency must be on the allowlist below,
// 2. every "@isela/*" import in source files must be a declared dependency,
// 3. client-safe packages must not depend on server-only packages.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ALLOWED = {
  shared: [],
  validation: ["shared"],
  notifications: ["shared"],
  database: ["shared"],
  audit: ["database", "shared"],
  "payment-risk": ["validation"],
  "lead-finder": ["shared", "validation"],
  auth: ["audit", "database", "notifications", "shared", "validation"],
  catalog: ["audit", "auth", "database", "shared", "validation"],
  settings: ["audit", "auth", "database", "lead-finder", "payment-risk", "shared", "validation"],
  crm: ["audit", "auth", "catalog", "database", "lead-finder", "shared", "validation"],
};

const root = new URL("..", import.meta.url).pathname;
const packagesDir = join(root, "packages");
const errors = [];

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

const manifests = new Map();
for (const name of readdirSync(packagesDir)) {
  const manifest = JSON.parse(readFileSync(join(packagesDir, name, "package.json"), "utf8"));
  manifests.set(name, manifest);
}

for (const [name, manifest] of manifests) {
  if (!(name in ALLOWED)) {
    errors.push(`packages/${name}: not registered in the boundary allowlist`);
    continue;
  }
  const declared = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })
    .filter((dep) => dep.startsWith("@isela/"))
    .map((dep) => dep.slice("@isela/".length));

  for (const dep of declared) {
    if (!ALLOWED[name].includes(dep)) {
      errors.push(`packages/${name} must not depend on @isela/${dep}`);
    }
    const target = manifests.get(dep);
    if (manifest.isela?.serverOnly === false && target?.isela?.serverOnly === true) {
      errors.push(`client-safe packages/${name} must not depend on server-only @isela/${dep}`);
    }
  }

  for (const file of sourceFiles(join(packagesDir, name, "src"))) {
    const content = readFileSync(file, "utf8");
    for (const match of content.matchAll(/from\s+"@isela\/([a-z-]+)(\/[^"]*)?"/g)) {
      const [, dep, subpath] = match;
      if (subpath !== undefined) {
        errors.push(`${file.slice(root.length)}: deep import @isela/${dep}${subpath}`);
      }
      if (dep !== undefined && !declared.includes(dep)) {
        errors.push(`${file.slice(root.length)}: imports undeclared @isela/${dep}`);
      }
    }
  }
}

if (errors.length > 0) {
  console.error("Module boundary violations:\n" + errors.map((e) => `  - ${e}`).join("\n"));
  process.exit(1);
}
console.log(`OK: module boundaries respected (${manifests.size} packages).`);
