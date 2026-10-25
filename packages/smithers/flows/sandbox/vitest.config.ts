import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import vibelang from "vibelang-vite"
import { configDefaults, defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [vibelang({ project: "tsconfig.test.json" })],
  test: {
    globalSetup: [
      fileURLToPath(new URL("../../../repo-targets/test-utils/coverage-teardown.mjs", import.meta.url)),
      fileURLToPath(new URL("../../../repo-targets/test-utils/test-process-environment.mjs", import.meta.url))
    ],
    include: ["test/**/*.test.{ts,vibe}"],
    exclude: [...configDefaults.exclude],
    environment: "node",
    // Suites here spawn processes and wait on the 5 s platform teardown
    // timer, so Vitest's 5 s default fails them on a loaded host. Assertions
    // are causal or count-based, never wall-clock; keep the budget finite so
    // a real hang still fails.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      enabled: true,
      provider: "v8",
      // Isolate both reports and V8's .tmp scratch files by coordinator PID,
      // as plan and control do, so another run cannot clean this run's files.
      reportsDirectory: join(tmpdir(), `flows-sandbox-coverage-${process.pid}`),
      include: ["src/**/*.{ts,vibe}"],
      thresholds: { branches: 100, functions: 100, lines: 100, statements: 100 }
    }
  }
})
