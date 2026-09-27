#!/usr/bin/env node
// Enforces the module dependency graph of the modular monolith (docs/ARCHITECTURE.md §3.2):
// 1. every internal dependency must be on the allowlist below,
// 2. every "@isela/*" import in source files must be a declared dependency,
// 3. client-safe packages must not depend on server-only packages,
// 4. apps may only use declared packages via their public exports, and client components
//    ("use client") must never import server-only packages or server-side app code.
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
  crm: ["audit", "auth", "catalog", "database", "geocoding", "lead-finder", "shared", "validation"],
  config: ["shared"],
  partners: ["auth", "database", "shared", "validation"],
  geocoding: ["shared", "validation"],
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
      const exported = dep === undefined ? undefined : manifests.get(dep)?.exports;
      if (subpath !== undefined && (exported === undefined || !(`.${subpath}` in exported))) {
        errors.push(
          `${file.slice(root.length)}: deep import @isela/${dep}${subpath} (not a declared export)`,
        );
      }
      if (dep !== undefined && !declared.includes(dep)) {
        errors.push(`${file.slice(root.length)}: imports undeclared @isela/${dep}`);
      }
    }
  }
}

// Apps (e.g. apps/web): declared dependencies, public exports, no server code in client files.
const appsDir = join(root, "apps");
function appFiles(dir) {
  return readdirSync(dir).flatMap((entry) => {
    if (["node_modules", ".next", "test-results", "playwright-report"].includes(entry)) return [];
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return appFiles(path);
    return /\.(ts|tsx)$/.test(path) && !path.endsWith(".d.ts") ? [path] : [];
  });
}
for (const app of readdirSync(appsDir)) {
  const manifest = JSON.parse(readFileSync(join(appsDir, app, "package.json"), "utf8"));
  const declared = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })
    .filter((dep) => dep.startsWith("@isela/"))
    .map((dep) => dep.slice("@isela/".length));
  for (const file of appFiles(join(appsDir, app))) {
    const rel = file.slice(root.length);
    const content = readFileSync(file, "utf8");
    const isClient = /^\s*["']use client["']/.test(content);
    for (const match of content.matchAll(/from\s+"@isela\/([a-z-]+)(\/[^"]*)?"/g)) {
      const [, dep, subpath] = match;
      const target = dep === undefined ? undefined : manifests.get(dep);
      if (
        subpath !== undefined &&
        (target?.exports === undefined || !(`.${subpath}` in target.exports))
      ) {
        errors.push(`${rel}: deep import @isela/${dep}${subpath} (not a declared export)`);
      }
      if (dep !== undefined && !declared.includes(dep)) {
        errors.push(`${rel}: imports undeclared @isela/${dep}`);
      }
      // Type-only imports are erased at build time and never reach the client bundle.
      const typeOnly = /import\s+type\s/.test(
        content.slice(content.lastIndexOf("import", match.index), match.index),
      );
      if (isClient && !typeOnly && target?.isela?.serverOnly === true) {
        errors.push(`${rel}: client component imports server-only @isela/${dep}`);
      }
    }
    if (isClient && /from\s+"@\/lib\/server\//.test(content)) {
      errors.push(`${rel}: client component imports server-side app code (@/lib/server)`);
    }
  }
}

if (errors.length > 0) {
  console.error("Module boundary violations:\n" + errors.map((e) => `  - ${e}`).join("\n"));
  process.exit(1);
}
console.log(`OK: module boundaries respected (${manifests.size} packages).`);
