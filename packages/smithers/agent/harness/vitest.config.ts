import { tmpdir } from "node:os"
import { join } from "node:path"
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    // House convention (see packages/smithers/flows/journal/vitest.config.ts): a finite 30 s
    // wall-clock budget so correct suites survive coverage-instrumented load
    // while a genuine hang still fails the run.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      enabled: true,
      provider: "v8",
      // Per-process report directory so concurrent vitest runs do not destroy
      // each other's coverage scratch state (issues #115/#121).
      reportsDirectory: join(tmpdir(), `flows-harness-coverage-${process.pid}`),
      // Console table only. Nothing reads a report under a directory named
      // after a finished process, and Vitest removes the reports directory at
      // run end only when it is empty, so the default html, clover, and json
      // reporters left one directory per run in the temp dir.
      reporter: ["text"],
      include: ["src/**"].map((pattern) => join(import.meta.dirname, pattern)),
      // Every remaining unreachable site carries a `v8 ignore` comment stating
      // why a test cannot reach it, so anything short of 100 is new untested
      // code rather than a known gap.
      thresholds: {
        branches: 100,
        functions: 100,
        lines: 100,
        statements: 100
      }
    }
  }
})
