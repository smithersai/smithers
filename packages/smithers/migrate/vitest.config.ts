import { tmpdir } from "node:os"
import { join } from "node:path"
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    // House convention (see packages/smithers/flows/patterns/vitest.config.ts): a finite
    // wall-clock budget so correct suites survive coverage-instrumented load
    // while a genuine hang still fails the run. Scanner tests copy fixture
    // trees and open SQLite databases, so the budget is 60 s rather than 30 s.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Fixtures are byte-for-byte copies of real Smithers 0.x projects. They
    // carry their own `*.test.ts` files, which are inputs to the scanner and
    // must never be collected as this package's tests.
    exclude: ["**/node_modules/**", "**/dist/**", "test/fixtures/**"],
    coverage: {
      enabled: true,
      provider: "v8",
      // Per-process report directory so concurrent vitest runs do not destroy
      // each other's coverage scratch state.
      reportsDirectory: join(tmpdir(), `flows-migrate-coverage-${process.pid}`),
      include: ["src/**"],
      // `src/flow/bin.ts` is the one statement `NodeRuntime.runMain(main)` and
      // stays in the denominator uncovered: a test can only reach it by
      // spawning a process, which `test/flow/Bin.test.ts` does against the
      // built binary, and the command it runs is `flow/Cli.ts`, covered in
      // process. The floor below allows for it.
      // A ratchet, not the goal. The 1.0 command contract's baseline is 100 on every
      // default run. On a checkout with no `SMITHERS_MIGRATE_PLUE_PACK` beside
      // it, which is every checkout but the maintainer's, the package measures
      // 94.4 statements, 86.0 branches, 95.3 functions, and 96.9 lines. The
      // floor sits under that so a change that lowers coverage fails here
      // rather than passing under a threshold nobody meets. Raise both
      // together: `packages/smithers/flows/test/vitestCoverageIsolation.test.ts`
      // carries the comment justifying this package's place in
      // `coverageFloorDeferred`, and it has to state the same numbers these
      // thresholds do.
      thresholds: {
        branches: 83,
        functions: 93,
        lines: 95,
        statements: 92
      }
    }
  }
})
