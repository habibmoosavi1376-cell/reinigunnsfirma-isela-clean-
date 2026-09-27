import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const webRoot = fileURLToPath(new URL("./apps/web", import.meta.url));
// `server-only` throws outside the React server runtime; tests import server modules directly.
const serverOnlyStub = fileURLToPath(
  new URL("./test/support/server-only-stub.ts", import.meta.url),
);
const resolve = { alias: { "@": webRoot, "server-only": serverOnlyStub } };

export default defineConfig({
  test: {
    projects: [
      {
        resolve,
        test: {
          name: "unit",
          include: ["test/unit/**/*.test.ts", "apps/web/tests/unit/**/*.test.ts"],
          environment: "node",
          env: { __NEXT_EXPERIMENTAL_AUTH_INTERRUPTS: "true" },
        },
      },
      {
        resolve,
        test: {
          name: "integration",
          include: ["test/integration/**/*.test.ts", "apps/web/tests/integration/**/*.test.ts"],
          environment: "node",
          globalSetup: ["./test/support/integration-global-setup.ts"],
          // Tests share one database; run files sequentially for deterministic state.
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
