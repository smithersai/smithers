import { tmpdir } from "node:os"
import { join } from "node:path"
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    // The retention assertion in Optimizer.test.ts counts live candidates
    // across a forced collection; without --expose-gc there is no collection
    // to force and the test refuses rather than flakes. `execArgv` is top
    // level in Vitest 4 (see packages/smithers/flows/sync/vitest.config.ts);
    // the 3.x `poolOptions.forks.execArgv` shape type-checks and is silently
    // ignored, which is how a flag that never reaches the worker looks.
    pool: "forks",
    execArgv: ["--expose-gc"],
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
      reportsDirectory: join(tmpdir(), `flows-patterns-coverage-${process.pid}`),
      include: ["src/**"],
      // Frozen 1.0 command contract: deferred declaration callbacks are executed by the
      // pure core test runtime, so the same 100% gate covers both topology and
      // value behavior.
      thresholds: {
        branches: 100,
        functions: 100,
        lines: 100,
        statements: 100
      }
    }
  }
})
