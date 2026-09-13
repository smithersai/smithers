import { tmpdir } from "node:os"
import { join } from "node:path"
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    // Vitest's 5 s default is a wall-clock budget measured under coverage
    // instrumentation across parallel workers, where correct suites have been
    // measured 6-12x slower than in isolation. Raise the budget instead of
    // trimming the workload, and keep it FINITE so a genuine hang still fails
    // the run (issues #115/#121).
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      enabled: true,
      provider: "v8",
      reportsDirectory: join(tmpdir(), `flows-capability-coverage-${process.pid}`),
      include: ["src/**/*.ts"],
      thresholds: { branches: 100, functions: 100, lines: 100, statements: 100 }
    }
  }
})
