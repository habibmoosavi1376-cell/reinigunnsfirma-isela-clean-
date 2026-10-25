#!/usr/bin/env node
/*
 * Minimal load/stability test (no dependencies). Only for isolated test environments:
 * refuses non-loopback targets unless LOAD_TEST_ALLOW_REMOTE=1 is set explicitly.
 *
 *   node scripts/load-test.mjs --base http://127.0.0.1:3000 --concurrency 20 --seconds 30 \
 *     --paths /api/health,/api/health/ready,/,/leistungen
 *
 * Prints one JSON report per path (requests, errors, req/s, latency p50/p95/p99/max in ms).
 */
/* global fetch */
import { performance } from "node:perf_hooks";

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce(
      (pairs, value, index, all) =>
        index % 2 === 0 ? [...pairs, [value.replace(/^--/, ""), all[index + 1]]] : pairs,
      [],
    ),
);
const base = new URL(args.base ?? "http://127.0.0.1:3000");
const concurrency = Number(args.concurrency ?? 10);
const seconds = Number(args.seconds ?? 10);
const paths = (args.paths ?? "/api/health").split(",");

const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(base.hostname);
if (!loopback && process.env.LOAD_TEST_ALLOW_REMOTE !== "1") {
  console.error(`Refusing to load-test non-loopback host ${base.hostname}.`);
  process.exit(2);
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  return Number(
    sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))].toFixed(1),
  );
}

async function run(path) {
  const url = new URL(path, base);
  const latencies = [];
  const statuses = {};
  let errors = 0;
  const deadline = performance.now() + seconds * 1000;
  async function worker() {
    while (performance.now() < deadline) {
      const start = performance.now();
      try {
        const response = await fetch(url, { redirect: "manual" });
        await response.arrayBuffer();
        statuses[response.status] = (statuses[response.status] ?? 0) + 1;
        if (response.status >= 500) errors += 1;
      } catch {
        errors += 1;
      }
      latencies.push(performance.now() - start);
    }
  }
  const started = performance.now();
  await Promise.all(Array.from({ length: concurrency }, worker));
  const elapsed = (performance.now() - started) / 1000;
  latencies.sort((a, b) => a - b);
  return {
    path,
    concurrency,
    seconds: Number(elapsed.toFixed(1)),
    requests: latencies.length,
    errors,
    statuses,
    rps: Number((latencies.length / elapsed).toFixed(1)),
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    max: percentile(latencies, 100),
  };
}

let failed = false;
for (const path of paths) {
  const report = await run(path);
  if (report.errors > 0) failed = true;
  console.log(JSON.stringify(report));
}
process.exitCode = failed ? 1 : 0;
