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
      reportsDirectory: join(tmpdir(), `flows-memory-coverage-${process.pid}`),
      include: ["src/**/*.ts"].map((pattern) => join(import.meta.dirname, pattern)),
      // An honest measured floor: every value is at or below what the suite
      // actually reaches (99.31 statements / 95.00 branches / 99.14 functions /
      // 99.57 lines), so a change that drops coverage fails here. The package is
      // still listed in `coverageFloorDeferred` in
      // packages/smithers/flows/test/vitestCoverageIsolation.test.ts, which requires at
      // least one value below 100; raising the last of these to 100 has to
      // remove the package from that set in the same commit.
      thresholds: {
        branches: 95,
        functions: 99,
        lines: 99,
        statements: 99
      }
    }
  }
})
