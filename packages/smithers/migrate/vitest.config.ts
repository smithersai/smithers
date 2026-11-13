import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import vibelang from "vibelang-vite"
import { configDefaults, defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [vibelang({ project: "tsconfig.test.json" })],
  test: {
    globalSetup: [
      fileURLToPath(new URL("../../repo-targets/test-utils/coverage-teardown.mjs", import.meta.url)),
      fileURLToPath(new URL("../../repo-targets/test-utils/test-process-environment.mjs", import.meta.url))
    ],
    include: [...configDefaults.include, "**/*.{test,spec}.vibe"],
    environment: "node",
    // Migration journeys start real verification processes and checkpoint
    // whole fixture trees. Run files serially to bound their process and disk
    // contention without extending any migration's execution budget.
    fileParallelism: false,
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
      // The default suite's documented baseline, not the 100% goal. Pin
      // every measured category so regressions below that baseline fail.
      // Full coverage remains deferred in the repository conformance suite;
      // its independent baseline assertion prevents weakening this ratchet.
      thresholds: {
        branches: 86,
        functions: 95.3,
        lines: 96.9,
        statements: 94.4
      }
    }
  }
})
