import { tmpdir } from "node:os"
import { join } from "node:path"
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    // Keep package workers serial: child startup and dense graph compilation
    // must not compete with every other file in the recursive workspace gate.
    // The existing finite watchdog remains a hang guard, not a performance test.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      enabled: true,
      provider: "v8",
      // Scope the report directory and its v8 scratch directory to this process.
      // The default `./coverage` is shared, so two concurrent `vitest run`
      // invocations destroy each other: one aborts with a removed-coverage-
      // directory error and the other enforces 100% against a partial
      // profile with every test passing (issues #115/#121).
      reportsDirectory: join(tmpdir(), `flows-plan-coverage-${process.pid}`),
      include: ["src/**"],
      thresholds: {
        branches: 100,
        functions: 100,
        lines: 100,
        statements: 100
      }
    }
  }
})
